import {keccak256, toBytes} from "viem";
import type {
  Address,
  Alert,
  AlertSink,
  ApprovalIssuer,
  ConfigStore,
  FreezeSink,
  Hex,
  Logger,
  RuntimeConfig,
} from "@stb/common";
import {lower, silentLogger} from "@stb/common";
import type {ChainReader} from "./chain";
import {decide} from "./decision";
import {Enricher, posKey, ZERO} from "./enricher";
import {eventId, type ChainEvent, type DetectorEvent, type PendingTxEvent} from "./events";
import {RuleEngine, type RuleHitOut, type RuleOutput} from "./rules";
import type {CaseRecord, Store, WindowStore} from "./stores/types";

export interface DetectorDeps {
  config: ConfigStore;
  store: Store;
  window: WindowStore;
  chain: ChainReader;
  freezer: FreezeSink;
  alerts: AlertSink;
  approvals: ApprovalIssuer;
  log?: Logger;
}

const DEPLOYER_DONE = "deployer_done";
const BOT_ALERT_KEY = "botfreeze-alert";

/**
 * Enricher → Rule Engine → Decision → Case Store를 잇는다 (design.md 7.1).
 * 블록 단위로 처리하고, 블록 안에서 나온 자동 동결 요청은 사건별로 묶어 블록 끝에 한 번에 보낸다.
 */
export class Detector {
  readonly enricher: Enricher;
  private readonly rules: RuleEngine;
  private readonly log: Logger;
  private pendingFreeze = new Map<Hex, Set<Address>>();
  private pendingReview = new Map<Hex, Map<Address, {score: number; why: string}>>();
  private pendingRelated = new Map<Hex, {subject: Address; addresses: Address[]}>();

  constructor(private readonly d: DetectorDeps) {
    this.log = d.log ?? silentLogger;
    this.enricher = new Enricher(d.store, d.chain);
    this.rules = new RuleEngine(() => {
      const c = this.cfg();
      return {cfg: c.rules, book: c.book, riskList: c.riskList, enricher: this.enricher, window: d.window, chain: d.chain};
    });
  }

  private cfg(): RuntimeConfig {
    return this.d.config.current();
  }

  /** 한 블록의 이벤트를 순서대로 처리한다. 같은 블록을 다시 넣어도 결과가 같다. */
  async processBlock(events: ChainEvent[]): Promise<void> {
    const sorted = [...events].sort((a, b) => a.txIndex - b.txIndex || a.logIndex - b.logIndex);
    // 타임락이 실행한 트랜잭션: 그 안의 관리 이벤트는 승인된 변경이다 (R7).
    const timelockTxs = new Set(
      sorted.filter((e) => e.kind === "timelock" && e.name === "CallExecuted").map((e) => e.txHash.toLowerCase()),
    );
    for (const e of sorted) await this.handle(e, timelockTxs);
    await this.flush();
    const last = sorted.at(-1);
    if (last) await this.d.window.prune(last.timestamp - this.windowSec() * 4);
  }

  /** pending 트랜잭션 (R5, R10). 자동 동결 요청은 바로 보낸다. */
  async processPending(e: PendingTxEvent): Promise<void> {
    await this.applyRules(e);
    await this.flush();
  }

  /** 재조직: 사라진 블록의 윈도우 항목을 지우고 근거가 사라진 사건을 재검토 대상으로 표시한다 (7.4). */
  async onReorg(fromBlock: bigint): Promise<void> {
    await this.d.window.removeFromBlock(fromBlock);
    this.enricher.clearCache();
    const keys = await this.d.store.markReorged(fromBlock);
    if (keys.length > 0) {
      await this.d.alerts.alert({
        severity: "warning",
        kind: "reorg",
        title: `재조직: 블록 ${fromBlock}부터 근거가 바뀐 사건 ${keys.length}건 재검토 필요`,
        lines: keys.map((k) => `case ${k}`),
      });
    }
  }

  private windowSec() {
    return this.cfg().rules.window_minutes * 60;
  }

  private async handle(e: ChainEvent, timelockTxs: Set<string>): Promise<void> {
    const {book} = this.cfg();
    switch (e.kind) {
      case "transfer": {
        for (const a of [e.from, e.to]) {
          if (a !== ZERO) await this.enricher.observe(a, e.timestamp, e.blockNumber, posKey(e.blockNumber, e.txIndex, e.logIndex));
        }
        break;
      }
      case "frozen":
        await this.enricher.setFrozen(e.account, true, e.timestamp, e.blockNumber);
        await this.onFrozenEvent(e);
        return;
      case "unfrozen":
        await this.enricher.setFrozen(e.account, false, e.timestamp, e.blockNumber);
        return;
      case "mint":
        await this.r8(e);
        return;
      case "admin":
        await this.r7(e, timelockTxs);
        return;
      case "timelock":
        await this.d.alerts.alert({
          severity: "info",
          kind: `timelock.${e.name}`,
          title: e.name === "CallScheduled" ? "타임락 작업 예약" : "타임락 작업 실행",
          lines: [`id ${e.id}`, `target ${book.label(e.target)}`, `data ${e.data.slice(0, 74)}${e.data.length > 74 ? "…" : ""}`, `tx ${e.txHash}`],
        });
        return;
      case "wiped":
      case "reissued":
        await this.onRecoveryEvent(e);
        return;
    }
    await this.applyRules(e);
  }

  private async applyRules(e: DetectorEvent): Promise<void> {
    const out = await this.rules.evaluate(e);
    if (out.hits.length === 0 && out.related.length === 0) return;
    await this.handleOutput(out, e);
  }

  private async handleOutput(out: RuleOutput, e: DetectorEvent): Promise<void> {
    const {rules, book} = this.cfg();
    const now = e.timestamp;
    const win = this.windowSec();
    for (const h of out.hits) {
      await this.d.window.addHit(h);
      await this.d.store.recordHit(h, null);
    }

    // 주소별로 점수를 다시 계산해 결정한다.
    const byAddr = new Map<Address, RuleHitOut[]>();
    for (const h of out.hits) byAddr.set(h.address, [...(byAddr.get(h.address) ?? []), h]);
    const caseOf = new Map<Address, CaseRecord>();

    for (const [addr, hs] of byAddr) {
      const s = await this.d.window.score(addr, now, win);
      const decision = decide({category: book.category(addr), score: s.score, rules: s.rules, thresholds: rules.thresholds});
      this.log.debug("decision", {addr, score: s.score, rules: s.rules, decision});
      if (decision === "record") continue;

      const group = [addr, ...hs.flatMap((h) => h.groupWith)];
      const c = await this.caseFor(group, e, addr);
      caseOf.set(addr, c);
      for (const h of s.hits) await this.d.store.recordHit(h, c.caseKey);
      const escalated = await this.d.store.setDecision(c.caseKey, addr, decision, s.score, now);
      if (!escalated) continue;
      const why = s.hits.map((h) => `${h.rule}(${h.points}): ${h.detail}`).join("; ");
      if (decision === "auto_freeze") {
        if (await this.enricher.isFrozen(addr)) continue;
        if (!this.pendingFreeze.has(c.caseKey)) this.pendingFreeze.set(c.caseKey, new Set());
        this.pendingFreeze.get(c.caseKey)!.add(addr);
        await this.d.store.addAction({caseKey: c.caseKey, kind: "auto_freeze_requested", actor: "detector", ts: now, data: {address: addr, score: s.score, why}});
      } else {
        if (!this.pendingReview.has(c.caseKey)) this.pendingReview.set(c.caseKey, new Map());
        this.pendingReview.get(c.caseKey)!.set(addr, {score: s.score, why});
        await this.d.store.addAction({caseKey: c.caseKey, kind: "human_review_requested", actor: "detector", ts: now, data: {address: addr, score: s.score, why}});
      }
    }

    // 연관 주소 (R3 분산 송금의 수신 주소들): 주체에 사건이 있을 때만 사람에게 넘긴다.
    for (const rel of out.related) {
      const c = caseOf.get(rel.subject) ?? (await this.d.store.findOpenCase([rel.subject], now - win));
      if (!c) continue;
      const fresh: Address[] = [];
      for (const a of rel.addresses) {
        if (book.isProtected(a) || book.isWhitelabel(a) || (await this.enricher.isFrozen(a))) continue;
        if (await this.d.store.setDecision(c.caseKey, a, "related", 0, now)) fresh.push(a);
      }
      if (fresh.length === 0) continue;
      const prev = this.pendingRelated.get(c.caseKey);
      this.pendingRelated.set(c.caseKey, {subject: rel.subject, addresses: [...(prev?.addresses ?? []), ...fresh]});
    }
  }

  /** 열린 사건에 붙이거나 새 사건을 연다. caseId = keccak256(사건 문자열) (design.md 9장 1단계). */
  private async caseFor(group: Address[], e: DetectorEvent, subject: Address): Promise<CaseRecord> {
    const now = e.timestamp;
    const existing = await this.d.store.findOpenCase(group, now - this.windowSec());
    if (existing) return existing;
    const where = e.kind === "pending" ? `pending:${e.hash}` : `${e.blockNumber}:${e.txHash}`;
    const caseString = `case:${this.cfg().book.chainId}:${where}:${lower(subject)}`;
    const caseKey = keccak256(toBytes(caseString));
    const c = await this.d.store.createCase(caseKey, caseString, now);
    await this.d.store.addAction({caseKey, kind: "case_opened", actor: "detector", ts: now, data: {caseString}});
    return c;
  }

  private async flush(): Promise<void> {
    const {book} = this.cfg();
    const freezes = this.pendingFreeze;
    const reviews = this.pendingReview;
    const related = this.pendingRelated;
    this.pendingFreeze = new Map();
    this.pendingReview = new Map();
    this.pendingRelated = new Map();

    for (const [caseKey, addrs] of freezes) {
      const list = [...addrs];
      this.log.info("auto freeze requested", {caseKey, addresses: list});
      try {
        await this.d.freezer.requestFreeze({caseKey, addresses: list, source: "auto"});
      } catch (err) {
        this.log.error("freeze request failed", {caseKey, err: String(err)});
        await this.d.alerts.alert({
          severity: "critical",
          kind: "freeze.request_failed",
          title: "자동 동결 요청 실패",
          caseKey,
          lines: [String(err), ...list.map((a) => book.label(a))],
        });
      }
    }
    for (const [caseKey, m] of reviews) {
      const links = [...m.keys()].map((a) => ({address: a, url: this.d.approvals.issue(caseKey, a)}));
      await this.d.alerts.alert({
        severity: "warning",
        kind: "human_review",
        title: `사람 확인 필요: ${m.size}개 주소`,
        caseKey,
        lines: [...m].map(([a, v]) => `${book.label(a)} score ${v.score} — ${v.why}`),
        approvalLinks: links,
      });
    }
    for (const [caseKey, r] of related) {
      await this.d.alerts.alert({
        severity: "warning",
        kind: "related_addresses",
        title: `연관 주소 ${r.addresses.length}개: ${book.label(r.subject)}의 분산 송금 수신처`,
        caseKey,
        lines: r.addresses.map((a) => book.label(a)),
        approvalLinks: r.addresses.map((a) => ({address: a, url: this.d.approvals.issue(caseKey, a)})),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // R7 관리 이벤트, R8 비승인 발행, 봇 동결 속도 감시
  // ---------------------------------------------------------------------------

  private async r7(e: Extract<ChainEvent, {kind: "admin"}>, timelockTxs: Set<string>): Promise<void> {
    const {rules, book} = this.cfg();
    // 배포자의 역할 포기 이후에는 배포자가 보낸 관리 이벤트를 승인으로 보지 않는다.
    const deployerDone = (await this.d.store.getMeta(DEPLOYER_DONE)) === "1";
    const fromDeployer = e.sender === book.deployer || e.txFrom === book.deployer;
    let approvedBy: string | null = null;
    if (timelockTxs.has(e.txHash.toLowerCase())) approvedBy = "timelock";
    else if (e.sender === book.opsSafe) approvedBy = "ops-safe";
    else if (fromDeployer && !deployerDone) approvedBy = "deployment";

    if (
      e.name === "RoleRevoked" &&
      e.emitter === book.token &&
      lower(String(e.args.account)) === book.deployer &&
      e.args.role === "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      await this.d.store.setMeta(DEPLOYER_DONE, "1");
    }

    if (!rules.rules.R7.enabled) return;
    const args = Object.entries(e.args).map(([k, v]) => `${k}=${typeof v === "string" && v.startsWith("0x") && v.length === 42 ? book.label(v as Address) : String(v)}`);
    if (approvedBy) {
      this.log.info("approved admin event", {name: e.name, approvedBy, tx: e.txHash});
      return;
    }
    await this.d.alerts.alert({
      severity: "critical",
      kind: "R7",
      title: `R7 승인되지 않은 관리 이벤트: ${e.name}`,
      lines: [`emitter ${book.label(e.emitter)}`, ...args, `sender ${e.sender ?? "?"} txFrom ${e.txFrom ?? "?"}`, `tx ${e.txHash} block ${e.blockNumber}`],
    });
  }

  private async r8(e: Extract<ChainEvent, {kind: "mint"}>): Promise<void> {
    const {rules, book} = this.cfg();
    if (!rules.rules.R8.enabled) return;
    const ok = await this.d.store.consumeMintRequest(e.to, e.amount, eventId(e));
    if (ok) return;
    await this.d.alerts.alert({
      severity: "critical",
      kind: "R8",
      title: "R8 승인된 발행 요청과 맞지 않는 Mint",
      lines: [`minter ${book.label(e.minter)}`, `to ${book.label(e.to)}`, `amount ${e.amount}`, `tx ${e.txHash}`],
    });
  }

  private async onFrozenEvent(e: Extract<ChainEvent, {kind: "frozen"}>): Promise<void> {
    const {book, rules} = this.cfg();
    const c = await this.d.store.getCase(e.reason);
    if (c) await this.d.store.addAction({caseKey: c.caseKey, kind: "frozen_onchain", actor: e.operator, txHash: e.txHash, ts: e.timestamp, data: {address: e.account}});
    if (e.operator !== book.bot) return;
    // 봇 키 오작동·탈취 감시 (design.md 8.3, 12장 시나리오 5): 시간당 봇 동결 수가 상한을 넘으면 최고 등급 알림
    await this.d.window.addSeries("botfreeze", {member: eventId(e), ts: e.timestamp, value: 1n, block: e.blockNumber});
    const n = (await this.d.window.series("botfreeze", e.timestamp - 3600)).filter((i) => i.ts <= e.timestamp).length;
    if (n <= rules.monitor.bot_freezes_per_hour_alert) return;
    const last = await this.d.store.getMeta(BOT_ALERT_KEY);
    if (last && Number(last) > e.timestamp - 3600) return;
    await this.d.store.setMeta(BOT_ALERT_KEY, String(e.timestamp));
    await this.d.alerts.alert({
      severity: "critical",
      kind: "bot.freeze_rate",
      title: `봇 동결 속도 이상: 1시간에 ${n}건 (상한 ${rules.monitor.bot_freezes_per_hour_alert})`,
      lines: [
        "봇 키 탈취 또는 오작동 의심. 운영 Safe가 FREEZER를 회수하고(ops bot revoke) 오탐을 해제한다(ops unfreeze).",
        `bot ${book.label(book.bot)}`,
        `last tx ${e.txHash}`,
      ],
    });
  }

  private async onRecoveryEvent(e: Extract<ChainEvent, {kind: "wiped" | "reissued"}>): Promise<void> {
    const {book} = this.cfg();
    const c = await this.d.store.getCase(e.caseId);
    const who = e.kind === "wiped" ? e.account : e.to;
    if (c) {
      await this.d.store.addAction({caseKey: c.caseKey, kind: e.kind, actor: "chain", txHash: e.txHash, ts: e.timestamp, data: {address: who, amount: e.amount.toString()}});
    }
    await this.d.alerts.alert({
      severity: "info",
      kind: `recovery.${e.kind}`,
      title: e.kind === "wiped" ? "동결 잔고 소각" : "회수 재발행",
      caseKey: e.caseId,
      lines: [`case ${e.caseId}${c ? "" : " (Case Store에 없는 사건)"}`, `${e.kind === "wiped" ? "account" : "to"} ${book.label(who)}`, `amount ${e.amount}`, `tx ${e.txHash}`],
    });
  }
}

export type {Alert};
