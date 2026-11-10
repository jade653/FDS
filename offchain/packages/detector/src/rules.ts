import type {Address, Alert, AddressBook, Hex, RuleId, RulesConfig} from "@stb/common";
import {lower, units} from "@stb/common";
import type {ChainReader} from "./chain";
import {Enricher, ZERO} from "./enricher";
import {eventId, type DetectorEvent} from "./events";
import type {HitRecord, WindowStore} from "./stores/types";

export interface RuleHitOut extends HitRecord {
  /** 사건을 묶을 때 함께 볼 주소 (R1b의 출처 지갑, R4의 감시 지갑들 등) */
  groupWith: Address[];
}

export interface RuleOutput {
  hits: RuleHitOut[];
  /** R3 분산 송금처럼 사람이 확산 추적할 연관 주소 (design.md 9장 2단계) */
  related: {subject: Address; addresses: Address[]; rule: RuleId}[];
  alerts: Alert[];
}

export interface RuleContext {
  cfg: RulesConfig;
  book: AddressBook;
  riskList: Set<Address>;
  enricher: Enricher;
  window: WindowStore;
  chain: ChainReader;
}

const MIN = 60;

/**
 * 점수 룰 R1~R6, R9, R10 (design.md 7.2). R7·R8(알림만)은 Detector가 처리한다.
 * 모든 판단 시각은 이벤트의 블록 시각이라서 같은 이벤트를 다시 처리하면 같은 결과가 나온다.
 */
export class RuleEngine {
  constructor(private readonly ctx: () => RuleContext) {}

  async evaluate(e: DetectorEvent): Promise<RuleOutput> {
    const out: RuleOutput = {hits: [], related: [], alerts: []};
    const c = this.ctx();
    switch (e.kind) {
      case "transfer":
        if (e.from === ZERO || e.to === ZERO) break; // 발행·소각은 R8과 회수 경로가 본다
        await this.onTransfer(c, e, out);
        break;
      case "approval":
        if (c.book.isExit(e.spender)) await this.r5(c, e.owner, e.timestamp, eventId(e), e.blockNumber, e.txHash, `approve ${e.spender}`, out);
        break;
      case "exitCall":
        await this.r5(c, e.from, e.timestamp, eventId(e), e.blockNumber, e.txHash, `call ${e.to}`, out);
        break;
      case "tokenCall":
        await this.r10(c, e.call.parties, e.timestamp, eventId(e), e.blockNumber, e.txHash, out);
        break;
      case "pending": {
        const id = eventId(e);
        if (e.call) {
          if (e.call.fn === "approve" && e.call.spender && c.book.isExit(e.call.spender)) {
            await this.r5(c, e.from, e.timestamp, id, null, e.hash, `pending approve ${e.call.spender}`, out);
          }
          await this.r10(c, e.call.parties, e.timestamp, id, null, e.hash, out);
        } else if (c.book.isExit(e.to)) {
          await this.r5(c, e.from, e.timestamp, id, null, e.hash, `pending call ${e.to}`, out);
        }
        break;
      }
      case "code":
        if (c.cfg.rules.R6.enabled && c.book.isWatched(e.account) && e.code !== "0x") {
          const delegation = e.code.toLowerCase().startsWith("0xef0100");
          out.hits.push(
            hit("R6", e.account, c.cfg.rules.R6.score, e.timestamp, `R6:${e.account}:${e.code.slice(0, 50)}`, e.blockNumber, null,
              delegation ? `EIP-7702 delegation to 0x${e.code.slice(8, 48)}` : `code appeared (${(e.code.length - 2) / 2} bytes)`),
          );
        }
        break;
    }
    return out;
  }

  private async onTransfer(
    c: RuleContext,
    e: Extract<DetectorEvent, {kind: "transfer"}>,
    out: RuleOutput,
  ): Promise<void> {
    const r = c.cfg.rules;
    const id = eventId(e);
    const {from, to, value, timestamp: ts, blockNumber: block, txHash} = e;
    const newTo = await c.enricher.isNew(to, ts, r.R2.new_address_max_age_hours * 3600, r.R2.new_address_max_nonce, block);

    // R1 / R1b: 감시 지갑 유출 속도
    if (r.R1.enabled && c.book.isWatched(from)) {
      await c.window.addSeries(`out:${from}`, {member: id, ts, value, block, ref: to});
      const items = await c.window.series(`out:${from}`, ts - r.R1.window_minutes * MIN);
      const inWindow = items.filter((i) => i.ts <= ts);
      const sum = inWindow.reduce((s, i) => s + i.value, 0n);
      const after = await c.chain.balanceOf(from, block);
      const before = after + sum;
      const pct = before === 0n ? 0 : Number((sum * 10_000n) / before) / 100;
      if (sum > units(r.R1.abs_amount) || pct > r.R1.balance_pct) {
        out.hits.push(
          hit("R1", from, r.R1.score, ts, `R1:${from}:${id}`, block, txHash, `outflow ${sum} in ${r.R1.window_minutes}m (${pct}% of balance)`, inWindow.map((i) => lower(i.ref!))),
        );
        if (r.R1b.enabled) {
          for (const i of inWindow) {
            const rcpt = lower(i.ref!);
            if (c.book.isWhitelabel(rcpt) || rcpt === ZERO) continue;
            out.hits.push(hit("R1b", rcpt, r.R1b.score, ts, `R1b:${rcpt}:${i.member}`, block, txHash, `received ${i.value} from R1 wallet ${from}`, [from]));
          }
        }
      }
    }

    // R2: 신규 주소로 대량 유입
    if (r.R2.enabled && !c.book.isWhitelabel(to) && value >= units(r.R2.min_amount) && newTo) {
      out.hits.push(hit("R2", to, r.R2.score, ts, `R2:${to}:${id}`, block, txHash, `new address received ${value} from ${from}`, [from]));
    }

    // R3: 분산 송금 (신규 주소로)
    if (r.R3.enabled && newTo) {
      await c.window.addSeries(`fanout:${from}`, {member: to, ts, value, block});
      const recipients = (await c.window.series(`fanout:${from}`, ts - r.R3.window_minutes * MIN)).filter((i) => i.ts <= ts);
      if (recipients.length >= r.R3.min_new_recipients) {
        const addrs = recipients.map((i) => lower(i.member));
        out.hits.push(hit("R3", from, r.R3.score, ts, `R3:${from}:${id}`, block, txHash, `sent to ${addrs.length} new addresses in ${r.R3.window_minutes}m`));
        out.related.push({subject: from, addresses: addrs, rule: "R3"});
      }
    }

    // R4: 집중 유입 (여러 감시 지갑 → 같은 주소)
    if (r.R4.enabled && c.book.isWatched(from) && !c.book.isWatched(to)) {
      await c.window.addSeries(`winflow:${to}`, {member: from, ts, value, block});
      const sources = (await c.window.series(`winflow:${to}`, ts - r.R4.window_minutes * MIN)).filter((i) => i.ts <= ts);
      if (sources.length >= r.R4.min_watched_sources) {
        const srcs = sources.map((i) => lower(i.member));
        out.hits.push(hit("R4", to, r.R4.score, ts, `R4:${to}:${id}`, block, txHash, `inflow from ${srcs.length} watched wallets`, srcs));
      }
    }

    // R5 준비: 수신 기록 (대량 수신 주소 판정용)
    if (r.R5.enabled) await c.window.addSeries(`inflow:${to}`, {member: id, ts, value, block});

    // R9: 외부 위험 목록
    if (r.R9.enabled) {
      for (const a of [from, to]) {
        if (c.riskList.has(a)) out.hits.push(hit("R9", a, r.R9.score, ts, `R9:${a}:${id}`, block, txHash, "listed in external risk list"));
      }
    }
  }

  private async r5(c: RuleContext, a: Address, ts: number, id: string, block: bigint | null, txHash: Hex | null, what: string, out: RuleOutput) {
    const r = c.cfg.rules.R5;
    if (!r.enabled) return;
    const items = (await c.window.series(`inflow:${lower(a)}`, ts - r.window_minutes * MIN)).filter((i) => i.ts <= ts);
    const sum = items.reduce((s, i) => s + i.value, 0n);
    if (sum >= units(r.large_inflow_amount)) {
      out.hits.push(hit("R5", lower(a), r.score, ts, `R5:${lower(a)}:${id}`, block, txHash, `${what} after receiving ${sum}`));
    }
  }

  private async r10(c: RuleContext, parties: Address[], ts: number, id: string, block: bigint | null, txHash: Hex | null, out: RuleOutput) {
    const r = c.cfg.rules.R10;
    if (!r.enabled) return;
    const uniq = [...new Set(parties.map(lower))].filter((p) => p !== ZERO);
    const frozen: Address[] = [];
    for (const p of uniq) if (await c.enricher.isFrozen(p)) frozen.push(p);
    if (frozen.length === 0) return;
    for (const p of uniq) {
      if (frozen.includes(p) || c.book.isProtected(p) || c.book.isWhitelabel(p)) continue;
      out.hits.push(hit("R10", p, r.score, ts, `R10:${p}:${id}`, block, txHash, `transaction involving frozen ${frozen.join(", ")}`, frozen));
    }
  }
}

function hit(
  rule: RuleId,
  address: Address,
  points: number,
  ts: number,
  id: string,
  blockNumber: bigint | null,
  txHash: Hex | null,
  detail: string,
  groupWith: Address[] = [],
): RuleHitOut {
  return {id, rule, address: lower(address), points, ts, blockNumber, txHash, detail, groupWith};
}
