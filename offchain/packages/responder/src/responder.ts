import {encodeFunctionData, parseEventLogs, parseGwei, type PublicClient, type TransactionReceipt} from "viem";
import {stableTokenAbi} from "@stb/abi";
import type {
  Address,
  AlertSink,
  ApprovalIssuer,
  ConfigStore,
  FreezeRequest,
  FreezeSink,
  Hex,
  Logger,
} from "@stb/common";
import {lower, silentLogger} from "@stb/common";
import {FreezeOnlySigner, type TxSigner} from "./signer";
import type {LeaderLock} from "./lock";

export type ResponderMode = "shadow" | "auto" | "off";

/** Responder가 쓰는 Case Store 부분 (detector의 CaseStore가 그대로 맞는다). */
export interface ResponderStore {
  addAction(a: {caseKey: Hex; kind: string; actor: string; txHash?: Hex | null; ts: number; data?: Record<string, unknown>}): Promise<void>;
  countActionsSince(kind: string, sinceTs: number): Promise<number>;
}

export interface ResponderDeps {
  config: ConfigStore;
  /** RESPONDER_MODE (shadow | auto | off). 함수라서 재시작 없이 바꿀 수 있다. */
  mode: () => ResponderMode;
  /** 공개 RPC: 조회와 공개 제출 */
  client: PublicClient;
  /** 프라이빗 제출 RPC (Flashbots Protect 등). 없으면 공개 경로로 대신한다. */
  privateClient?: PublicClient;
  signer: TxSigner;
  store: ResponderStore;
  alerts: AlertSink;
  approvals: ApprovalIssuer;
  lock: LeaderLock;
  instanceId?: string;
  log?: Logger;
  /** 속도 제한에 쓰는 현재 시각(초). 기본은 벽시계 */
  now?: () => number;
  /** 블록 대기 폴링 간격 */
  pollMs?: number;
}

const AUTO_SENT = "freeze_sent_auto";
const HUMAN_SENT = "freeze_sent_human";

export interface SendResult {
  txHash: Hex;
  frozen: Address[];
  attempts: number;
  blocksToInclusion: bigint;
}

/**
 * 동결 트랜잭션 하나만 서명하고 보낸다 (design.md 8장).
 *
 * - 서명은 FreezeOnlySigner를 거친다. freeze/freezeBatch 외 calldata는 서명하지 않는다.
 * - 킬 스위치(설정) 또는 mode=off: 아무것도 서명하지 않고 알림만.
 * - 섀도 모드: 자동 동결 요청은 "동결했을 것"으로 기록만. 사람이 승인한 동결은 실행한다.
 * - 시간당 자동 동결 상한을 넘으면 사람 승인 모드로 바뀌고(래치) 나머지는 사람에게 넘긴다.
 * - 리더 락을 쥔 인스턴스만 보내고, 보내기는 한 번에 하나씩(단일 nonce 작성자).
 * - 1블록 안에 포함되지 않으면 같은 nonce로 수수료를 올려 다시 보낸다(최대 resend_max회).
 */
export class Responder implements FreezeSink {
  private readonly signer: TxSigner;
  private readonly log: Logger;
  private readonly instanceId: string;
  private queue: Promise<unknown> = Promise.resolve();
  private inflight = new Set<Address>();
  private humanMode = false;

  constructor(private readonly d: ResponderDeps) {
    const {book} = d.config.current();
    this.signer = new FreezeOnlySigner(d.signer, book.token);
    this.log = d.log ?? silentLogger;
    this.instanceId = d.instanceId ?? `responder-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }

  get address(): Address {
    return this.signer.address;
  }

  /** 속도 제한으로 켜진 사람 승인 모드를 운영자가 끈다. */
  resetHumanMode() {
    this.humanMode = false;
  }
  isHumanMode() {
    return this.humanMode;
  }

  private now() {
    return this.d.now ? this.d.now() : Math.floor(Date.now() / 1000);
  }

  async requestFreeze(req: FreezeRequest): Promise<void> {
    const run = this.queue.then(() => this.handle(req));
    this.queue = run.catch(() => undefined);
    await run;
  }

  private async handle(req: FreezeRequest): Promise<void> {
    const {rules, book} = this.d.config.current();
    const cfg = rules.responder;
    const now = this.now();
    let addrs = [...new Set(req.addresses.map(lower))];

    // 1. 킬 스위치 / off: 서명하지 않는다.
    if (cfg.kill_switch || this.d.mode() === "off") {
      await this.d.store.addAction({caseKey: req.caseKey, kind: "freeze_skipped_kill_switch", actor: "responder", ts: now, data: {addresses: addrs, source: req.source}});
      await this.d.alerts.alert({
        severity: "critical",
        kind: "responder.kill_switch",
        title: "킬 스위치 켜짐: 동결하지 않고 알림만 보냄. 필요하면 운영 Safe가 직접 동결",
        caseKey: req.caseKey,
        lines: addrs.map((a) => book.label(a)),
      });
      return;
    }

    // 2. 섀도 모드: 자동 동결은 기록만
    if (req.source === "auto" && this.d.mode() === "shadow") {
      await this.d.store.addAction({caseKey: req.caseKey, kind: "shadow_freeze", actor: "responder", ts: now, data: {addresses: addrs}});
      await this.d.alerts.alert({
        severity: "info",
        kind: "responder.shadow",
        title: `섀도 모드: 동결했을 것 (${addrs.length}개)`,
        caseKey: req.caseKey,
        lines: addrs.map((a) => book.label(a)),
        approvalLinks: addrs.map((a) => ({address: a, url: this.d.approvals.issue(req.caseKey, a)})),
      });
      return;
    }

    // 3. 대상 거르기: 보호 주소(봇은 못 함), 진행 중, 이미 동결(멱등)
    const skipped: string[] = [];
    const targets: Address[] = [];
    for (const a of addrs) {
      if (book.isProtected(a)) {
        skipped.push(`${book.label(a)}: protected (GUARDIAN이 판단)`);
        continue;
      }
      if (this.inflight.has(a)) continue;
      const frozen = await this.d.client.readContract({address: book.token, abi: stableTokenAbi, functionName: "isFrozen", args: [a]});
      if (frozen) continue;
      targets.push(a);
    }
    if (skipped.length > 0) {
      await this.d.alerts.alert({severity: "warning", kind: "responder.skipped_protected", title: "보호 주소는 봇이 동결하지 않음", caseKey: req.caseKey, lines: skipped});
    }
    addrs = targets;
    if (addrs.length === 0) return;

    // 4. 자동 동결 속도 제한
    let toHuman: Address[] = [];
    if (req.source === "auto") {
      if (this.humanMode) {
        toHuman = addrs;
        addrs = [];
      } else {
        const used = await this.d.store.countActionsSince(AUTO_SENT, now - 3600);
        const left = Math.max(0, cfg.max_auto_freezes_per_hour - used);
        if (addrs.length > left) {
          this.humanMode = true;
          toHuman = addrs.slice(left);
          addrs = addrs.slice(0, left);
          await this.d.alerts.alert({
            severity: "critical",
            kind: "responder.rate_limited",
            title: `자동 동결 상한(시간당 ${cfg.max_auto_freezes_per_hour}개) 초과: 사람 승인 모드로 전환`,
            caseKey: req.caseKey,
            lines: ["오탐 폭주나 봇 오작동일 수 있다. 원인을 확인한 뒤 운영자가 resetHumanMode로 되돌린다."],
          });
        }
      }
    }
    if (toHuman.length > 0) {
      await this.d.store.addAction({caseKey: req.caseKey, kind: "human_review_requested", actor: "responder", ts: now, data: {addresses: toHuman, reason: "rate_limit"}});
      await this.d.alerts.alert({
        severity: "warning",
        kind: "human_review",
        title: `사람 승인 모드: ${toHuman.length}개 주소 동결 승인 필요`,
        caseKey: req.caseKey,
        lines: toHuman.map((a) => book.label(a)),
        approvalLinks: toHuman.map((a) => ({address: a, url: this.d.approvals.issue(req.caseKey, a)})),
      });
    }
    if (addrs.length === 0) return;

    // 5. 리더만 보낸다
    if (!(await this.d.lock.acquire(this.instanceId, 60_000))) {
      this.log.warn("not leader; skipping freeze", {caseKey: req.caseKey});
      return;
    }

    for (let i = 0; i < addrs.length; i += cfg.batch_max) {
      const chunk = addrs.slice(i, i + cfg.batch_max);
      for (const a of chunk) this.inflight.add(a);
      try {
        const res = await this.send(chunk, req.caseKey);
        await this.d.store.addAction({
          caseKey: req.caseKey,
          kind: req.source === "auto" ? AUTO_SENT : HUMAN_SENT,
          actor: req.source === "auto" ? "bot" : `bot (approved by ${req.approvedBy ?? "?"})`,
          txHash: res.txHash,
          ts: now,
          data: {addresses: res.frozen, attempts: res.attempts, blocksToInclusion: Number(res.blocksToInclusion)},
        });
        await this.d.alerts.alert({
          severity: "warning",
          kind: "responder.frozen",
          title: `동결 완료 (${req.source === "auto" ? "자동" : `승인: ${req.approvedBy ?? "?"}`}) ${res.frozen.length}개`,
          caseKey: req.caseKey,
          lines: [...res.frozen.map((a) => book.label(a)), `tx ${res.txHash}`, `포함까지 ${res.blocksToInclusion}블록, 시도 ${res.attempts}회`],
        });
      } catch (err) {
        this.log.error("freeze failed", {err: String(err), caseKey: req.caseKey});
        await this.d.alerts.alert({
          severity: "critical",
          kind: "responder.failed",
          title: "동결 트랜잭션 실패. 운영 Safe가 직접 동결해야 함",
          caseKey: req.caseKey,
          lines: [String(err), ...chunk.map((a) => book.label(a))],
        });
      } finally {
        for (const a of chunk) this.inflight.delete(a);
      }
    }
    await this.checkGas().catch((err) => this.log.warn("gas check failed", {err: String(err)}));
  }

  /** 수수료 계산: 최근 블록 priority fee 중위값 × 배수, 하한·상한 (design.md 10장). */
  async fees(): Promise<{maxPriorityFeePerGas: bigint; maxFeePerGas: bigint}> {
    const cfg = this.d.config.current().rules.responder;
    let median = 0n;
    try {
      const h = await this.d.client.getFeeHistory({blockCount: 5, rewardPercentiles: [50]});
      const rewards = (h.reward ?? []).map((r) => r[0]).filter((x) => x !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (rewards.length > 0) median = rewards[Math.floor(rewards.length / 2)];
    } catch {
      // 일부 체인은 eth_feeHistory가 없다. 하한을 쓴다.
    }
    const mult = BigInt(Math.round(cfg.priority_fee_multiplier * 100));
    let tip = (median * mult) / 100n;
    const lo = parseGwei(String(cfg.min_priority_fee_gwei));
    const hi = parseGwei(String(cfg.max_priority_fee_gwei));
    if (tip < lo) tip = lo;
    if (tip > hi) tip = hi;
    const block = await this.d.client.getBlock({blockTag: "latest"});
    const base = block.baseFeePerGas ?? 0n;
    return {maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip};
  }

  /** freeze/freezeBatch 한 건을 보내고 포함될 때까지 기다린다. 필요하면 같은 nonce로 수수료를 올려 재전송. */
  async send(addrs: Address[], caseKey: Hex): Promise<SendResult> {
    const {rules, book} = this.d.config.current();
    const cfg = rules.responder;
    const data =
      addrs.length === 1
        ? encodeFunctionData({abi: stableTokenAbi, functionName: "freeze", args: [addrs[0], caseKey]})
        : encodeFunctionData({abi: stableTokenAbi, functionName: "freezeBatch", args: [addrs, caseKey]});
    const chainId = book.chainId;
    const from = this.signer.address;
    const nonce = await this.d.client.getTransactionCount({address: from, blockTag: "pending"});
    let gas: bigint;
    try {
      gas = ((await this.d.client.estimateGas({account: from, to: book.token, data})) * 12n) / 10n;
    } catch (err) {
      throw new Error(`freeze would revert: ${String(err).split("\n")[0]}`);
    }
    let fees = await this.fees();
    const startBlock = await this.d.client.getBlockNumber({cacheTime: 0});
    const hashes: Hex[] = [];
    let attempts = 0;

    const submit = async (useRoute: "private" | "public" | "both") => {
      const raw = await this.signer.signTransaction({type: "eip1559", chainId, nonce, to: book.token, data, gas, value: 0n, ...fees});
      attempts += 1;
      const targets: PublicClient[] = [];
      if ((useRoute === "private" || useRoute === "both") && this.d.privateClient) targets.push(this.d.privateClient);
      if (useRoute === "public" || useRoute === "both" || !this.d.privateClient) targets.push(this.d.client);
      const results = await Promise.allSettled(targets.map((c) => c.sendRawTransaction({serializedTransaction: raw})));
      const ok = results.find((r): r is PromiseFulfilledResult<Hex> => r.status === "fulfilled");
      if (!ok) throw new Error(`submit failed: ${results.map((r) => (r.status === "rejected" ? String(r.reason).split("\n")[0] : "")).join("; ")}`);
      hashes.push(ok.value);
      this.log.info("freeze submitted", {hash: ok.value, route: useRoute, nonce, attempt: attempts, tip: fees.maxPriorityFeePerGas});
    };

    const firstRoute = cfg.submit_route === "public_only" ? "public" : cfg.submit_route === "both" ? "both" : "private";
    await submit(firstRoute);

    let lastSendBlock = startBlock;
    const deadline = Date.now() + 120_000;
    for (;;) {
      const receipt = await this.findReceipt(hashes);
      if (receipt) {
        if (receipt.status !== "success") throw new Error(`freeze tx reverted: ${receipt.transactionHash}`);
        const frozen = parseEventLogs({abi: stableTokenAbi, eventName: "Frozen", logs: receipt.logs})
          .filter((l) => lower(l.address) === book.token)
          .map((l) => lower(l.args.account));
        return {txHash: receipt.transactionHash, frozen, attempts, blocksToInclusion: receipt.blockNumber - startBlock};
      }
      if (Date.now() > deadline) throw new Error(`freeze not included after ${attempts} attempts: ${hashes.join(", ")}`);
      const head = await this.d.client.getBlockNumber({cacheTime: 0});
      if (head - lastSendBlock >= BigInt(cfg.resend_after_blocks) && attempts <= cfg.resend_max) {
        // 같은 nonce, 수수료 25% 이상 인상 (교체 조건 10%를 넉넉히 넘김)
        const bump = (x: bigint) => (x * 125n) / 100n + 1n;
        const fresh = await this.fees();
        fees = {
          maxPriorityFeePerGas: bump(fees.maxPriorityFeePerGas) > fresh.maxPriorityFeePerGas ? bump(fees.maxPriorityFeePerGas) : fresh.maxPriorityFeePerGas,
          maxFeePerGas: bump(fees.maxFeePerGas) > fresh.maxFeePerGas ? bump(fees.maxFeePerGas) : fresh.maxFeePerGas,
        };
        lastSendBlock = head;
        // private_first: 1블록 안에 안 들어가면 공개 경로에도 낸다.
        await submit(cfg.submit_route === "private_first" ? "both" : firstRoute).catch((err) => this.log.warn("resend failed", {err: String(err)}));
      }
      await new Promise((r) => setTimeout(r, this.d.pollMs ?? 250));
    }
  }

  private async findReceipt(hashes: Hex[]): Promise<TransactionReceipt | null> {
    for (const h of hashes) {
      try {
        return await this.d.client.getTransactionReceipt({hash: h});
      } catch {
        // 아직 포함되지 않음
      }
    }
    return null;
  }

  /** 봇 가스 잔고가 동결 N건 분량 아래면 알림 (design.md 8.3). */
  async checkGas(): Promise<{balance: bigint; needed: bigint; low: boolean}> {
    const {rules, book} = this.d.config.current();
    const cfg = rules.responder;
    const [balance, fees] = await Promise.all([this.d.client.getBalance({address: this.signer.address}), this.fees()]);
    const needed = BigInt(cfg.gas_alert_freezes) * BigInt(cfg.freeze_gas_estimate) * fees.maxFeePerGas;
    const low = balance < needed;
    if (low) {
      await this.d.alerts.alert({
        severity: "warning",
        kind: "responder.gas_low",
        title: `봇 가스 부족: 동결 ${cfg.gas_alert_freezes}건 분량 미만`,
        lines: [`bot ${book.label(this.signer.address)}`, `balance ${balance} wei`, `needed ${needed} wei`],
      });
    }
    return {balance, needed, low};
  }
}
