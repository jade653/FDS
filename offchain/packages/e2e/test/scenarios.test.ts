import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import {encodeFunctionData, maxUint256, parseEventLogs, parseGwei, toHex, type Hex} from "viem";
import {stableTokenAbi, timelockControllerAbi} from "@stb/abi";
import {lower, units, type Address} from "@stb/common";
import {
  caseIdOf,
  caseStatus,
  executeLocal,
  planBotRevoke,
  planReissue,
  planUnfreeze,
  planWipe,
  PreconditionError,
  reconcileCase,
  recordLedger,
  verifyRoles,
} from "@stb/ops-cli";
import {
  Anvil,
  anvilAccount,
  deploy,
  frozenEvent,
  fund,
  isFrozen,
  mint,
  OPERATOR_TOKEN,
  rpc,
  sleep,
  startWatchtower,
  testAccount,
  transfer,
  waitFor,
  wallet,
  writeAddresses,
  type Env,
} from "./harness";
import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

// design.md 12장 종단 간 시나리오 1~7 (로컬 Anvil). 13장 3단계(1·2·4 탐지)와 4단계(1~7 전부)의 완료 기준.

const hot = [1, 2, 3, 4, 5].map((i) => testAccount(`hot${i}`));
const partner = testAccount("partner");
const exchange = testAccount("exchange");
const router = testAccount("router");
const user = testAccount("user");

const anvil = new Anvil(8645);
let addressesPath = "";
let snapshot: Hex = "0x0";
let env: Env;
const metrics: Record<string, unknown> = {};

async function freshEnv() {
  const client = (await import("viem")).createPublicClient({transport: (await import("viem")).http(anvil.http)});
  await rpc(client as any, "evm_revert", [snapshot]);
  snapshot = (await rpc(client as any, "evm_snapshot")) as Hex;
  env = await startWatchtower(anvil, addressesPath);
  for (const a of [...hot, partner, user]) await fund(env.client, a.address);
}

beforeAll(async () => {
  await anvil.start();
  const {deploymentPath} = deploy(anvil);
  addressesPath = writeAddresses(deploymentPath, {
    hot: hot.map((h) => h.address),
    watched: [partner.address],
    whitelabel: [exchange.address],
    exits: [router.address],
  });
  const client = (await import("viem")).createPublicClient({transport: (await import("viem")).http(anvil.http)});
  snapshot = (await rpc(client as any, "evm_snapshot")) as Hex;
});

afterEach(async () => {
  await env?.wt.stop();
});

afterAll(() => {
  anvil.stop();
  console.log("E2E metrics", JSON.stringify(metrics, null, 2));
});

describe("2단계: 배포 직후 권한 전수 검사 (이벤트 열거)", () => {
  it("6장 표와 일치하고 배포자에게 남은 권한이 없다", async () => {
    await freshEnv();
    const r = await verifyRoles(env.ops);
    expect(r.problems).toEqual([]);
    expect(r.token.FREEZER.sort()).toEqual([lower(env.ops.deployment.opsSafe), lower(env.ops.deployment.bot)].sort());
    expect(r.timelock.EXECUTOR).toEqual(["0x0000000000000000000000000000000000000000"]);
    // 배포 과정의 관리 이벤트는 승인된 것으로 처리되어 R7 알림이 없다.
    await env.wt.ingestor.tick();
    expect(env.capture.of("R7")).toEqual([]);
  });
});

describe("시나리오", () => {
  it("1. 대형 탈취: 핫월렛 3개 → 공격자. R1·R1b·R4, 핫월렛과 공격자 자동 동결", async () => {
    await freshEnv();
    const attacker = testAccount("attacker1").address;
    for (const h of hot.slice(0, 3)) await mint(env, h.address, 320_000); // minter 한도 1,000,000 안에서
    const start = await env.client.getBlockNumber();
    // 거의 동시에 세 지갑에서 유출
    const hashes = await Promise.all(hot.slice(0, 3).map((h) => transfer(env, h, attacker, 300_000, {wait: false})));
    const receipts = await Promise.all(hashes.map((hash) => env.client.waitForTransactionReceipt({hash})));
    const ok = receipts.filter((r) => r.status === "success");
    const sent = ok.map((r) => lower(r.from));

    await waitFor("attacker frozen", () => isFrozen(env, attacker));
    for (const h of sent) await waitFor(`hot ${h} frozen`, () => isFrozen(env, h as Address));
    const fe = (await frozenEvent(env, attacker))!;
    metrics.scenario1 = {
      outflowBeforeFreeze: `${ok.length * 300_000} STB`,
      hotWalletsDrained: ok.length,
      blocksFromFirstOutflowToFreeze: Number(fe.blockNumber - ok[0].blockNumber),
      firstBlock: Number(start) + 1,
    };
    const hits = await env.store.hitsFor(attacker);
    expect(hits.map((h) => h.rule)).toContain("R1b");
    if (ok.length >= 2) expect(hits.map((h) => h.rule)).toContain("R4");
    expect(env.capture.of("responder.frozen").length).toBeGreaterThan(0);
  });

  it("1b. 단일 핫월렛 탈취: 핫월렛 1개 → 신규 주소 1개. R1(핫월렛), R1b·R2(수신 주소), 둘 다 자동 동결", async () => {
    await freshEnv();
    const attacker = testAccount("attacker1b").address;
    await mint(env, hot[3].address, 1_000_000);
    const hash = await transfer(env, hot[3], attacker, 900_000);
    await waitFor("both frozen", async () => (await isFrozen(env, attacker)) && (await isFrozen(env, hot[3].address)));
    expect((await env.store.hitsFor(attacker)).map((h) => h.rule).sort()).toEqual(["R1b", "R2"]);
    expect((await env.store.hitsFor(hot[3].address)).map((h) => h.rule)).toContain("R1");
    const fe = (await frozenEvent(env, attacker))!;
    const tr = await env.client.getTransactionReceipt({hash});
    metrics.scenario1b = {blocksToFreeze: Number(fe.blockNumber - tr.blockNumber)};
  });

  it("2. 세탁 시도: 신규 주소 20개로 분산 송금 → R3, 공격자 자동 동결, 연관 주소는 원클릭 승인으로 동결", async () => {
    await freshEnv();
    const attacker = testAccount("attacker2");
    await fund(env.client, attacker.address);
    await mint(env, user.address, 1_000_000);
    await transfer(env, user, attacker.address, 1_000_000); // R2 40: 기록만
    await sleep(500);
    expect(await isFrozen(env, attacker.address)).toBe(false);

    const recipients = Array.from({length: 20}, (_, i) => testAccount(`launder${i}`).address);
    const base = await env.client.getTransactionCount({address: attacker.address});
    const hashes: Hex[] = [];
    for (const [i, r] of recipients.entries()) hashes.push(await transfer(env, attacker, r, 50_000, {wait: false, nonce: base + i}));
    await Promise.all(hashes.map((hash) => env.client.waitForTransactionReceipt({hash})));

    await waitFor("attacker frozen", () => isFrozen(env, attacker.address));
    expect((await env.store.hitsFor(attacker.address)).map((h) => h.rule)).toContain("R3");
    const rel = await waitFor("related alert", async () => env.capture.of("related_addresses")[0]);
    expect(rel.approvalLinks!.length).toBeGreaterThanOrEqual(10);

    // 운영자가 원클릭 승인 → 동결 (source = human)
    for (const link of rel.approvalLinks!) {
      const u = new URL(link.url);
      const r = await env.wt.approvalServer.approve(u.searchParams.get("case")!, u.searchParams.get("token")!, OPERATOR_TOKEN);
      expect(r.status).toBe(200);
    }
    for (const link of rel.approvalLinks!) expect(await isFrozen(env, link.address)).toBe(true);
    const acts = await env.store.actions(rel.caseKey!);
    expect(acts.filter((a) => a.kind === "freeze_approved").every((a) => a.actor === "alice")).toBe(true);
    metrics.scenario2 = {relatedFrozenByApproval: rel.approvalLinks!.length};
  });

  it("3. 출구 경쟁: pending DEX approve → R5, 동결이 approve보다 먼저 포함", async () => {
    await freshEnv();
    const attacker = testAccount("attacker3");
    await fund(env.client, attacker.address);
    await mint(env, user.address, 60_000);
    await transfer(env, user, attacker.address, 60_000); // R2 40 + 대량 수신
    await sleep(500);

    await rpc(env.client, "evm_setAutomine", [false]);
    try {
      const w = wallet(anvil, attacker);
      const approveHash = await w.writeContract({
        address: env.token,
        abi: stableTokenAbi,
        functionName: "approve",
        args: [router.address, maxUint256],
        chain: null,
        gas: 80_000n,
        maxPriorityFeePerGas: parseGwei("1"),
        maxFeePerGas: parseGwei("10"),
      });
      // 봇의 동결 트랜잭션이 멤풀에 들어올 때까지 기다린다.
      const bot = lower(env.ops.deployment.bot);
      await waitFor(
        "freeze in mempool",
        async () => {
          const pool = (await rpc(env.client, "txpool_content")) as any;
          return Object.keys(pool.pending ?? {}).some((k) => lower(k) === bot);
        },
        20_000,
      );
      await rpc(env.client, "evm_mine");
      const ar = await env.client.waitForTransactionReceipt({hash: approveHash});
      const fe = (await frozenEvent(env, attacker.address))!;
      expect(fe.blockNumber).toBe(ar.blockNumber);
      expect(fe.transactionIndex).toBeLessThan(ar.transactionIndex);
      expect(ar.status).toBe("reverted"); // 동결된 owner의 approve는 실패
      expect((await env.store.hitsFor(attacker.address)).map((h) => h.rule)).toContain("R5");
      metrics.scenario3 = {sameBlock: true, freezeIndex: fe.transactionIndex, approveIndex: ar.transactionIndex, route: "public (local anvil)"};
    } finally {
      await rpc(env.client, "evm_setAutomine", [true]);
    }
  });

  it("4. 오탐 방지: 감시 지갑 → 거래소 입금 주소 대량 송금은 자동 동결 없이 사람 확인 알림만", async () => {
    await freshEnv();
    await mint(env, partner.address, 1_000_000);
    await transfer(env, partner, exchange.address, 900_000);
    const review = await waitFor("human review", async () => env.capture.of("human_review")[0]);
    expect(review.approvalLinks!.map((l) => l.address)).toEqual([lower(partner.address)]);
    await sleep(1500);
    expect(await isFrozen(env, partner.address)).toBe(false);
    expect(await isFrozen(env, exchange.address)).toBe(false);
    expect(env.capture.alerts.some((a) => (a.approvalLinks ?? []).some((l) => l.address === lower(exchange.address)))).toBe(false);
  });

  it("5. 봇 키 탈취: 속도 제한 발동, 운영 Safe가 FREEZER 회수 후 해제", async () => {
    await freshEnv();
    // (a) 오작동한 봇에 오탐이 폭주: 시간당 20개를 넘으면 사람 승인 모드
    const flood = Array.from({length: 25}, (_, i) => testAccount(`flood${i}`).address);
    const caseKey = caseIdOf("e2e-flood");
    await env.wt.responder.requestFreeze({caseKey, addresses: flood, source: "auto"});
    expect(env.wt.responder.isHumanMode()).toBe(true);
    expect(env.capture.of("responder.rate_limited")).toHaveLength(1);
    let frozen = 0;
    for (const a of flood) if (await isFrozen(env, a)) frozen++;
    expect(frozen).toBe(20);

    // (b) 공격자가 봇 키로 직접 무차별 동결 → 탐지기가 봇 동결 속도 이상을 최고 등급으로 알림
    const victims = Array.from({length: 10}, (_, i) => testAccount(`victim${i}`).address);
    const botWallet = wallet(anvil, anvilAccount(6));
    const h = await botWallet.writeContract({address: env.token, abi: stableTokenAbi, functionName: "freezeBatch", args: [victims, caseIdOf("stolen")], chain: null});
    await env.client.waitForTransactionReceipt({hash: h});
    await waitFor("bot rate alert", async () => env.capture.of("bot.freeze_rate")[0]);

    // 운영 Safe: FREEZER 회수(타임락 없이) → 오탐 해제
    await executeLocal(env.ops, planBotRevoke(env.ops, env.ops.deployment.bot as Address));
    const FREEZER = await env.client.readContract({address: env.token, abi: stableTokenAbi, functionName: "FREEZER_ROLE"});
    expect(await env.client.readContract({address: env.token, abi: stableTokenAbi, functionName: "hasRole", args: [FREEZER, env.ops.deployment.bot as Address]})).toBe(false);
    await executeLocal(env.ops, planUnfreeze(env.ops, [...victims, ...flood.slice(0, 20)], "봇 키 탈취 오탐"));
    for (const a of [...victims, ...flood]) expect(await isFrozen(env, a)).toBe(false);
    // 회수된 봇 키로는 더 이상 동결할 수 없다
    await expect(
      botWallet.writeContract({address: env.token, abi: stableTokenAbi, functionName: "freeze", args: [victims[0], caseKey], chain: null, gas: 100_000n}).then((hash) => env.client.waitForTransactionReceipt({hash})).then((r) => r.status),
    ).resolves.toBe("reverted");
  });

  it("6. 회수 완결: 동결 → 대기 → 소각 → 준비금 장부 → 재발행 → 대조 (ops-cli)", async () => {
    await freshEnv();
    const attacker = testAccount("attacker6").address;
    const victim = testAccount("victim6").address;
    await mint(env, hot[4].address, 950_000);
    await transfer(env, hot[4], attacker, 900_000);
    await waitFor("attacker frozen", () => isFrozen(env, attacker));
    const caseKey = (await frozenEvent(env, attacker))!.args.reason as Hex;
    expect(await env.store.getCase(caseKey)).toBeDefined();

    // 4단계 대기: minFreezeAge 전에는 소각 계획을 거부 (컨트랙트도 거부)
    await expect(planWipe(env.ops, [attacker], caseKey)).rejects.toBeInstanceOf(PreconditionError);
    await rpc(env.client, "evm_increaseTime", [toHex(600)]);
    await rpc(env.client, "evm_mine");

    // 5단계 소각 (회수 Safe)
    const wipe = await planWipe(env.ops, [attacker], caseKey);
    expect(wipe.total).toBe(units(900_000));
    expect(wipe.batch.meta.createdFromSafeAddress).toBe(lower(env.ops.deployment.recoverySafe));
    await executeLocal(env.ops, wipe.batch);
    expect(await isFrozen(env, attacker)).toBe(true); // 소각 후에도 동결 유지

    // 6단계 준비금 회계 (오프체인 장부)
    const ledger = join(mkdtempSync(join(tmpdir(), "ledger-")), "anvil.jsonl");
    recordLedger(ledger, {caseId: caseKey, kind: "reserve_released", amount: wipe.total, actor: "e2e"});

    // 7단계 재발행: 남은 재발행 가능액을 넘으면 거부, minter 한도가 모자라면 금고 Safe 배치도 만든다
    await expect(planReissue(env.ops, victim, units(900_001), caseKey)).rejects.toBeInstanceOf(PreconditionError);
    const re = await planReissue(env.ops, victim, units(900_000), caseKey);
    expect(re.remaining).toBe(units(900_000));
    expect(re.treasury).toBeDefined(); // 1,000,000 - 950,000 < 900,000
    await executeLocal(env.ops, re.treasury!);
    await executeLocal(env.ops, re.minter);
    recordLedger(ledger, {caseId: caseKey, kind: "reissued", amount: units(900_000), actor: "e2e"});
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toHaveLength(2);

    // 8단계 종결: 이벤트 대조
    const rec = await reconcileCase(env.ops, caseKey);
    expect(rec).toMatchObject({consistent: true, balanced: true, wiped: units(900_000), reissued: units(900_000)});
    const st = await caseStatus(env.ops, caseKey, [attacker]);
    expect(st.remaining).toBe(0n);
    await expect(planReissue(env.ops, victim, 1n, caseKey)).rejects.toBeInstanceOf(PreconditionError);

    // Case Store에도 소각·재발행이 같은 사건으로 남는다
    await env.wt.ingestor.tick();
    const kinds = (await env.store.actions(caseKey)).map((a) => a.kind);
    expect(kinds).toContain("wiped");
    expect(kinds).toContain("reissued");
    metrics.scenario6 = {caseKey, wiped: "900000 STB", reissued: "900000 STB"};
  });

  it("7. 관리 이벤트: 승인 목록에 없는 RoleGranted → 최고 등급 알림. 타임락 경유와 승인된 발행은 알림 없음", async () => {
    await freshEnv();
    const timelock = env.ops.deployment.timelock as Address;
    const PAUSER = await env.client.readContract({address: env.token, abi: stableTokenAbi, functionName: "PAUSER_ROLE"});

    // (b) 정상 경로: 거버넌스 Safe 제안 → 10분 → 아무나 실행
    const data = encodeFunctionData({abi: stableTokenAbi, functionName: "grantRole", args: [PAUSER, testAccount("pauser2").address]});
    const gov = wallet(anvil, anvilAccount(1));
    const salt = ("0x" + "01".repeat(32)) as Hex;
    const zero = ("0x" + "00".repeat(32)) as Hex;
    let h = await gov.writeContract({address: timelock, abi: timelockControllerAbi, functionName: "schedule", args: [env.token, 0n, data, zero, salt, 600n], chain: null});
    await env.client.waitForTransactionReceipt({hash: h});
    await rpc(env.client, "evm_increaseTime", [toHex(600)]);
    await rpc(env.client, "evm_mine");
    h = await wallet(anvil, anvilAccount(9)).writeContract({address: timelock, abi: timelockControllerAbi, functionName: "execute", args: [env.token, 0n, data, zero, salt], chain: null});
    await env.client.waitForTransactionReceipt({hash: h});
    await waitFor("timelock executed alert", async () => env.capture.of("timelock.CallExecuted")[0]);
    expect(env.capture.of("R7")).toEqual([]);

    // (a) 타임락을 거치지 않은 역할 부여 (타임락 키 탈취를 흉내: impersonate)
    await fund(env.client, timelock);
    await rpc(env.client, "anvil_impersonateAccount", [timelock]);
    const intruder = testAccount("intruder").address;
    const txh = (await rpc(env.client, "eth_sendTransaction", [
      {from: timelock, to: env.token, data: encodeFunctionData({abi: stableTokenAbi, functionName: "grantRole", args: [PAUSER, intruder]})},
    ])) as Hex;
    await env.client.waitForTransactionReceipt({hash: txh});
    const r7 = await waitFor("R7 alert", async () => env.capture.of("R7")[0]);
    expect(r7.severity).toBe("critical");
    expect(r7.title).toContain("RoleGranted");

    // R8: 발행 요청 기록 없는 Mint → 최고 등급 알림. 기록된 발행은 알림 없음
    await mint(env, user.address, 10);
    const w = wallet(anvil, anvilAccount(5));
    const mh = await w.writeContract({address: env.token, abi: stableTokenAbi, functionName: "mint", args: [user.address, units(777)], chain: null});
    await env.client.waitForTransactionReceipt({hash: mh});
    const r8 = await waitFor("R8 alert", async () => env.capture.of("R8")[0]);
    expect(r8.lines.join(" ")).toContain(String(units(777)));
    expect(env.capture.of("R8")).toHaveLength(1);
  });

  it("처리 지연: 블록 도착부터 결정까지 1초 이내 (design.md 7.4)", async () => {
    await freshEnv();
    await mint(env, user.address, 100);
    for (let i = 0; i < 5; i++) await transfer(env, user, testAccount(`lat${i}`).address, 1);
    await env.wt.ingestor.tick();
    const lat = env.wt.ingestor.latencies;
    const p95 = [...lat].sort((a, b) => a - b)[Math.floor(lat.length * 0.95)];
    metrics.latencyMs = {samples: lat.length, p95, max: Math.max(...lat)};
    expect(p95).toBeLessThan(1000);
  });
});

export {parseEventLogs};
