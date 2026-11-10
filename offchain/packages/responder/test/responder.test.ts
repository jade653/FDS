import {createCipheriv, randomBytes, scryptSync} from "node:crypto";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseTransaction,
  type PublicClient,
  type TransactionSerializable,
} from "viem";
import {stableTokenAbi} from "@stb/abi";
import {ConfigStore, lower, type Address, type Hex} from "@stb/common";
import {MemoryStore} from "@stb/detector";
import {A, D, makeConfig, Sinks} from "../../detector/test/helpers";
import {MemoryLock} from "../src/lock";
import {Responder, type ResponderMode} from "../src/responder";
import {assertFreezeOnly, FreezeOnlySigner, keystoreSigner, privateKeySigner, SignRefused} from "../src/signer";

// Anvil 기본 키 6 (봇 자리). 공개된 테스트 키.
const BOT_KEY: Hex = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";
const CASE = ("0x" + "cc".repeat(32)) as Hex;

/** 트랜잭션을 받아 두었다가 `includeAfter`블록 뒤에 포함시키는 가짜 체인 */
class FakeChain {
  block = 100n;
  frozen = new Set<Address>();
  sent: {raw: Hex; via: string; tip: bigint; nonce: number; data: Hex}[] = [];
  receipts = new Map<Hex, any>();
  includeAfter = 0;
  nonce = 0;
  balance = 10n ** 18n;

  mine(n = 1) {
    for (let i = 0; i < n; i++) {
      this.block += 1n;
      // 같은 nonce의 마지막(가장 높은 수수료) 트랜잭션 하나만 포함
      const pending = this.sent.filter((s) => s.nonce === this.nonce);
      const ready = pending.filter((s) => (s as any).at + BigInt(this.includeAfter) <= this.block);
      if (ready.length === 0) continue;
      const best = ready.reduce((a, b) => (b.tip > a.tip ? b : a));
      const hash = keccak256(best.raw);
      const logs: any[] = [];
      for (const acct of this.decodeTargets(best.data)) {
        if (this.frozen.has(acct)) continue;
        this.frozen.add(acct);
        logs.push({
          address: D.token,
          topics: encodeEventTopics({abi: stableTokenAbi, eventName: "Frozen", args: {account: acct, operator: lower(privateKeySigner(BOT_KEY).address), reason: CASE}}),
          data: "0x",
          blockNumber: this.block,
          logIndex: logs.length,
          transactionHash: hash,
        });
      }
      this.receipts.set(hash, {status: "success", transactionHash: hash, blockNumber: this.block, logs});
      this.nonce += 1;
    }
  }

  private decodeTargets(data: Hex): Address[] {
    const freezeSel = encodeFunctionData({abi: stableTokenAbi, functionName: "freeze", args: [A(1), CASE]}).slice(0, 10);
    if (data.startsWith(freezeSel)) return [lower(("0x" + data.slice(34, 74)) as Address)];
    const n = Number(BigInt("0x" + data.slice(10 + 128, 10 + 192)));
    const out: Address[] = [];
    for (let i = 0; i < n; i++) out.push(lower(("0x" + data.slice(10 + 192 + i * 64 + 24, 10 + 192 + (i + 1) * 64)) as Address));
    return out;
  }

  client(via: string): PublicClient {
    const self = this;
    return {
      async readContract({args}: {args: [Address]}) {
        return self.frozen.has(lower(args[0]));
      },
      async getTransactionCount() {
        return self.nonce;
      },
      async estimateGas() {
        return 60_000n;
      },
      async getFeeHistory() {
        return {reward: [[1_000_000_000n], [2_000_000_000n], [3_000_000_000n]]};
      },
      async getBlock() {
        return {baseFeePerGas: 1_000_000_000n, number: self.block};
      },
      async getBlockNumber() {
        return self.block;
      },
      async getBalance() {
        return self.balance;
      },
      async sendRawTransaction({serializedTransaction}: {serializedTransaction: Hex}) {
        const tx = parseTransaction(serializedTransaction);
        self.sent.push({raw: serializedTransaction, via, tip: tx.maxPriorityFeePerGas!, nonce: tx.nonce!, data: tx.data!, at: self.block} as any);
        if (self.includeAfter === 0) self.mine();
        return keccak256(serializedTransaction);
      },
      async getTransactionReceipt({hash}: {hash: Hex}) {
        const r = self.receipts.get(hash);
        if (!r) throw new Error("not found");
        return r;
      },
    } as unknown as PublicClient;
  }
}

function make(opts: {mode?: ResponderMode; private?: boolean; route?: "private_first" | "public_only" | "both"; kill?: boolean} = {}) {
  const chain = new FakeChain();
  const cfg = makeConfig({protected: [A(0x999)]});
  if (opts.route) cfg.rules.responder.submit_route = opts.route;
  if (opts.kill) cfg.rules.responder.kill_switch = true;
  const config = new ConfigStore(cfg);
  const store = new MemoryStore();
  const sinks = new Sinks();
  let mode: ResponderMode = opts.mode ?? "auto";
  let now = 1_700_000_000;
  const r = new Responder({
    config,
    mode: () => mode,
    client: chain.client("public"),
    privateClient: opts.private ? chain.client("private") : undefined,
    signer: privateKeySigner(BOT_KEY),
    store,
    alerts: sinks.alertSink,
    approvals: sinks.approvals,
    lock: new MemoryLock(),
    now: () => now,
    pollMs: 5,
  });
  return {r, chain, store, sinks, config, setMode: (m: ResponderMode) => (mode = m), advance: (s: number) => (now += s)};
}

describe("서명 가드: freeze/freezeBatch 외에는 서명하지 않는다 (design.md 12장)", () => {
  const signer = new FreezeOnlySigner(privateKeySigner(BOT_KEY), D.token);
  const base: TransactionSerializable = {type: "eip1559", chainId: 31337, nonce: 0, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, to: D.token, value: 0n};
  const call = (fn: string, args: unknown[]) => encodeFunctionData({abi: stableTokenAbi, functionName: fn as any, args: args as any});

  it("freeze, freezeBatch는 서명한다", async () => {
    await expect(signer.signTransaction({...base, data: call("freeze", [A(1), CASE])})).resolves.toMatch(/^0x/);
    await expect(signer.signTransaction({...base, data: call("freezeBatch", [[A(1), A(2)], CASE])})).resolves.toMatch(/^0x/);
  });

  const refused: [string, unknown[]][] = [
    ["unfreeze", [A(1)]],
    ["wipeFrozen", [A(1), CASE]],
    ["mint", [A(1), 1n]],
    ["mintForRecovery", [A(1), 1n, CASE]],
    ["burn", [1n]],
    ["pause", []],
    ["unpause", []],
    ["grantRole", [CASE, A(1)]],
    ["revokeRole", [CASE, A(1)]],
    ["renounceRole", [CASE, A(1)]],
    ["setProtected", [A(1), false]],
    ["transfer", [A(1), 1n]],
    ["approve", [A(1), 1n]],
    ["rescueERC20", [A(1), A(2), 1n]],
  ];
  for (const [fn, args] of refused) {
    it(`${fn}는 거부`, async () => {
      await expect(signer.signTransaction({...base, data: call(fn, args)})).rejects.toBeInstanceOf(SignRefused);
    });
  }

  it("다른 대상, ETH 송금, 빈 calldata, 컨트랙트 생성은 거부", () => {
    const data = call("freeze", [A(1), CASE]);
    expect(() => assertFreezeOnly({...base, data, to: A(5)}, D.token)).toThrow(SignRefused);
    expect(() => assertFreezeOnly({...base, data, value: 1n}, D.token)).toThrow(SignRefused);
    expect(() => assertFreezeOnly({...base, data: "0x"}, D.token)).toThrow(SignRefused);
    expect(() => assertFreezeOnly({...base, data, to: undefined}, D.token)).toThrow(SignRefused);
  });
});

describe("키스토어 서명자", () => {
  it("v3 키스토어(scrypt)를 풀어 같은 주소로 서명한다. 비밀번호가 틀리면 실패", () => {
    const dir = mkdtempSync(join(tmpdir(), "ks-"));
    const salt = randomBytes(32);
    const iv = randomBytes(16);
    const derived = scryptSync("pw", salt, 32, {N: 1024, r: 8, p: 1});
    const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(BOT_KEY.slice(2), "hex")), cipher.final()]);
    const mac = keccak256(new Uint8Array(Buffer.concat([derived.subarray(16, 32), ct]))).slice(2);
    const path = join(dir, "bot.json");
    writeFileSync(
      path,
      JSON.stringify({version: 3, crypto: {cipher: "aes-128-ctr", ciphertext: ct.toString("hex"), cipherparams: {iv: iv.toString("hex")}, kdf: "scrypt", kdfparams: {n: 1024, r: 8, p: 1, dklen: 32, salt: salt.toString("hex")}, mac}}),
    );
    expect(keystoreSigner(path, "pw").address).toBe(privateKeySigner(BOT_KEY).address);
    expect(() => keystoreSigner(path, "wrong")).toThrow(/MAC/);
  });
});

describe("Responder", () => {
  it("한 주소는 freeze, 여러 주소는 freezeBatch로 한 트랜잭션", async () => {
    const t = make();
    await t.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "auto"});
    await t.r.requestFreeze({caseKey: CASE, addresses: [A(2), A(3)], source: "auto"});
    expect(t.chain.sent).toHaveLength(2);
    expect(t.chain.frozen).toEqual(new Set([A(1), A(2), A(3)]));
    expect(t.sinks.alertsOf("responder.frozen")).toHaveLength(2);
    expect((await t.store.actions(CASE)).map((a) => a.kind)).toEqual(["freeze_sent_auto", "freeze_sent_auto"]);
  });

  it("같은 요청을 두 번 받아도 트랜잭션은 하나 (동시에 와도)", async () => {
    const t = make();
    const req = {caseKey: CASE, addresses: [A(1), A(2)], source: "auto" as const};
    await Promise.all([t.r.requestFreeze(req), t.r.requestFreeze(req)]);
    await t.r.requestFreeze(req);
    expect(t.chain.sent).toHaveLength(1);
  });

  it("보호 주소는 봇이 동결하지 않고 알린다", async () => {
    const t = make();
    await t.r.requestFreeze({caseKey: CASE, addresses: [A(0x999), D.opsSafe], source: "auto"});
    expect(t.chain.sent).toHaveLength(0);
    expect(t.sinks.alertsOf("responder.skipped_protected")[0].lines).toHaveLength(2);
  });

  it("섀도 모드: 자동 요청은 기록만, 사람 승인 요청은 실행", async () => {
    const t = make({mode: "shadow"});
    await t.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "auto"});
    expect(t.chain.sent).toHaveLength(0);
    expect((await t.store.actions(CASE))[0].kind).toBe("shadow_freeze");
    await t.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "human", approvedBy: "alice"});
    expect(t.chain.sent).toHaveLength(1);
    expect((await t.store.actions(CASE)).at(-1)!.kind).toBe("freeze_sent_human");
  });

  it("킬 스위치와 mode=off: 아무것도 서명하지 않는다 (사람 승인 요청도)", async () => {
    const k = make({kill: true});
    await k.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "human", approvedBy: "alice"});
    expect(k.chain.sent).toHaveLength(0);
    expect(k.sinks.alertsOf("responder.kill_switch")).toHaveLength(1);

    const o = make({mode: "off"});
    await o.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "auto"});
    expect(o.chain.sent).toHaveLength(0);
  });

  it("킬 스위치는 설정 핫리로드로 즉시 켠다", async () => {
    const t = make();
    const cfg = makeConfig({protected: [A(0x999)]});
    cfg.rules.responder.kill_switch = true;
    t.config.set(cfg);
    await t.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "auto"});
    expect(t.chain.sent).toHaveLength(0);
  });

  it("시간당 자동 동결 상한(20) 초과: 넘는 만큼 사람 승인으로 넘기고 사람 승인 모드로 전환", async () => {
    const t = make();
    const addrs = Array.from({length: 25}, (_, i) => A(0x100 + i));
    await t.r.requestFreeze({caseKey: CASE, addresses: addrs.slice(0, 15), source: "auto"});
    await t.r.requestFreeze({caseKey: CASE, addresses: addrs.slice(15), source: "auto"});
    expect(t.chain.frozen.size).toBe(20);
    expect(t.r.isHumanMode()).toBe(true);
    expect(t.sinks.alertsOf("responder.rate_limited")).toHaveLength(1);
    const review = t.sinks.alertsOf("human_review")[0];
    expect(review.approvalLinks!.map((l) => l.address)).toEqual(addrs.slice(20));

    // 사람 승인 모드에서는 새 자동 요청도 사람에게. 사람이 승인한 동결은 실행.
    await t.r.requestFreeze({caseKey: CASE, addresses: [A(0x500)], source: "auto"});
    expect(t.chain.frozen.has(A(0x500))).toBe(false);
    await t.r.requestFreeze({caseKey: CASE, addresses: [A(0x500)], source: "human", approvedBy: "bob"});
    expect(t.chain.frozen.has(A(0x500))).toBe(true);

    // 한 시간이 지나고 운영자가 되돌리면 다시 자동
    t.advance(3601);
    t.r.resetHumanMode();
    await t.r.requestFreeze({caseKey: CASE, addresses: [A(0x501)], source: "auto"});
    expect(t.chain.frozen.has(A(0x501))).toBe(true);
  });

  it("1블록 안에 포함되지 않으면 같은 nonce로 수수료를 올려 재전송 (최대 3회)", async () => {
    const t = make();
    t.chain.includeAfter = 3; // 3블록 뒤에야 포함
    const p = t.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "auto"});
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 30));
      t.chain.mine();
    }
    await p;
    const nonces = new Set(t.chain.sent.map((s) => s.nonce));
    expect(nonces.size).toBe(1);
    expect(t.chain.sent.length).toBeGreaterThanOrEqual(2);
    expect(t.chain.sent.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < t.chain.sent.length; i++) expect(t.chain.sent[i].tip).toBeGreaterThan(t.chain.sent[i - 1].tip);
    expect(t.chain.frozen.has(A(1))).toBe(true);
  });

  it("priority fee는 중위값의 3배, 하한·상한 적용", async () => {
    const t = make();
    const f = await t.r.fees();
    expect(f.maxPriorityFeePerGas).toBe(6_000_000_000n); // 중위 2 gwei × 3
    expect(f.maxFeePerGas).toBe(2_000_000_000n + 6_000_000_000n);
  });

  it("제출 경로: both는 두 경로에, public_only는 공개에만, private_first는 프라이빗 먼저", async () => {
    const both = make({private: true, route: "both"});
    await both.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "auto"});
    expect(both.chain.sent.map((s) => s.via).sort()).toEqual(["private", "public"]);

    const pub = make({private: true, route: "public_only"});
    await pub.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "auto"});
    expect(pub.chain.sent.map((s) => s.via)).toEqual(["public"]);

    const pf = make({private: true, route: "private_first"});
    await pf.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "auto"});
    expect(pf.chain.sent.map((s) => s.via)).toEqual(["private"]);
  });

  it("리더 락을 다른 인스턴스가 쥐고 있으면 보내지 않는다", async () => {
    const t = make();
    const lock = new MemoryLock();
    await lock.acquire("other", 60_000);
    (t.r as any).d.lock = lock;
    await t.r.requestFreeze({caseKey: CASE, addresses: [A(1)], source: "auto"});
    expect(t.chain.sent).toHaveLength(0);
  });

  it("봇 가스가 동결 10건 분량 아래면 알림", async () => {
    const t = make();
    t.chain.balance = 1n;
    const g = await t.r.checkGas();
    expect(g.low).toBe(true);
    expect(t.sinks.alertsOf("responder.gas_low")).toHaveLength(1);
  });
});
