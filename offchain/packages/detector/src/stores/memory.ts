import type {Address, Decision, Hex} from "@stb/common";
import {lower} from "@stb/common";
import {
  DECISION_RANK,
  type ActionRecord,
  type AddressInfo,
  type CaseRecord,
  type CaseStatus,
  type Cursor,
  type HitRecord,
  type ScoreResult,
  type SeriesItem,
  type Store,
  type WindowStore,
} from "./types";

/** 메모리 윈도우 저장소. 단일 프로세스·테스트용. 운영은 RedisWindowStore. */
export class MemoryWindowStore implements WindowStore {
  private hits = new Map<Address, Map<string, HitRecord>>();
  private seriesMap = new Map<string, Map<string, SeriesItem>>();

  async addHit(h: HitRecord): Promise<void> {
    const k = lower(h.address);
    if (!this.hits.has(k)) this.hits.set(k, new Map());
    this.hits.get(k)!.set(h.id, h);
  }

  async score(address: Address, now: number, windowSec: number): Promise<ScoreResult> {
    const all = [...(this.hits.get(lower(address))?.values() ?? [])].filter(
      (h) => h.ts >= now - windowSec && h.ts <= now,
    );
    return scoreOf(all);
  }

  async addSeries(key: string, item: SeriesItem): Promise<void> {
    if (!this.seriesMap.has(key)) this.seriesMap.set(key, new Map());
    this.seriesMap.get(key)!.set(item.member, item);
  }

  async series(key: string, fromTs: number): Promise<SeriesItem[]> {
    return [...(this.seriesMap.get(key)?.values() ?? [])].filter((i) => i.ts >= fromTs).sort((a, b) => a.ts - b.ts);
  }

  async removeFromBlock(block: bigint): Promise<void> {
    for (const m of this.hits.values()) {
      for (const [id, h] of m) if (h.blockNumber !== null && h.blockNumber >= block) m.delete(id);
    }
    for (const m of this.seriesMap.values()) {
      for (const [id, i] of m) if (i.block !== null && i.block >= block) m.delete(id);
    }
  }

  async prune(beforeTs: number): Promise<void> {
    for (const m of this.hits.values()) for (const [id, h] of m) if (h.ts < beforeTs) m.delete(id);
    for (const m of this.seriesMap.values()) for (const [id, i] of m) if (i.ts < beforeTs) m.delete(id);
  }
}

/** 룰별 최신 발동 하나씩만 센다. */
export function scoreOf(hits: HitRecord[]): ScoreResult {
  const byRule = new Map<string, HitRecord>();
  for (const h of hits) {
    const prev = byRule.get(h.rule);
    if (!prev || h.ts > prev.ts || (h.ts === prev.ts && h.id > prev.id)) byRule.set(h.rule, h);
  }
  const picked = [...byRule.values()].sort((a, b) => a.rule.localeCompare(b.rule));
  return {score: picked.reduce((s, h) => s + h.points, 0), rules: picked.map((h) => h.rule), hits: picked};
}

/** 메모리 사건·주소·커서 저장소. 테스트와 로컬 E2E용. 운영은 PgStore. */
export class MemoryStore implements Store {
  private cursor: Cursor | undefined;
  private blockHashes = new Map<bigint, Hex>();
  private addresses = new Map<Address, AddressInfo>();
  private hits = new Map<string, HitRecord & {caseKey: Hex | null}>();
  private cases = new Map<Hex, CaseRecord>();
  private actionList: ActionRecord[] = [];
  private tokens = new Set<string>();
  private mintRequests: {to: Address; amount: bigint; ref: string; consumedBy: string | null}[] = [];

  async getCursor() {
    return this.cursor;
  }
  async setCursor(c: Cursor) {
    this.cursor = c;
  }
  async getBlockHash(b: bigint) {
    return this.blockHashes.get(b);
  }
  async setBlockHash(b: bigint, h: Hex) {
    this.blockHashes.set(b, h);
  }
  async pruneBlockHashes(below: bigint) {
    for (const b of this.blockHashes.keys()) if (b < below) this.blockHashes.delete(b);
  }
  private meta = new Map<string, string>();
  async getMeta(key: string) {
    return this.meta.get(key);
  }
  async setMeta(key: string, value: string) {
    this.meta.set(key, value);
  }

  async getAddress(a: Address) {
    const v = this.addresses.get(lower(a));
    return v ? {...v} : undefined;
  }
  async putAddress(info: AddressInfo) {
    this.addresses.set(lower(info.address), {...info, address: lower(info.address)});
  }

  async recordHit(h: HitRecord, caseKey: Hex | null) {
    const prev = this.hits.get(h.id);
    this.hits.set(h.id, {...h, caseKey: caseKey ?? prev?.caseKey ?? null});
  }
  async hitsFor(address: Address) {
    return [...this.hits.values()].filter((h) => h.address === lower(address));
  }

  async findOpenCase(addresses: Address[], sinceTs: number) {
    const want = new Set(addresses.map(lower));
    for (const c of this.cases.values()) {
      if (c.status !== "open" || c.updatedTs < sinceTs) continue;
      if (c.addresses.some((x) => want.has(x.address))) return structuredClone(c);
    }
    return undefined;
  }
  async createCase(caseKey: Hex, caseString: string, ts: number) {
    const existing = this.cases.get(caseKey);
    if (existing) return structuredClone(existing);
    const c: CaseRecord = {caseKey, caseString, status: "open", needsReview: false, createdTs: ts, updatedTs: ts, addresses: []};
    this.cases.set(caseKey, c);
    return structuredClone(c);
  }
  async getCase(caseKey: Hex) {
    const c = this.cases.get(caseKey);
    return c ? structuredClone(c) : undefined;
  }
  async listCases() {
    return [...this.cases.values()].map((c) => structuredClone(c));
  }
  async setDecision(caseKey: Hex, address: Address, decision: Decision | "related", score: number, ts: number) {
    const c = this.cases.get(caseKey);
    if (!c) throw new Error(`unknown case ${caseKey}`);
    c.updatedTs = Math.max(c.updatedTs, ts);
    const a = lower(address);
    const cur = c.addresses.find((x) => x.address === a);
    if (!cur) {
      c.addresses.push({address: a, decision, score});
      return true;
    }
    cur.score = Math.max(cur.score, score);
    if (DECISION_RANK[decision] > DECISION_RANK[cur.decision]) {
      cur.decision = decision;
      return true;
    }
    return false;
  }
  async addAction(a: ActionRecord) {
    this.actionList.push({...a});
  }
  async actions(caseKey: Hex) {
    return this.actionList.filter((a) => a.caseKey === caseKey);
  }
  async countActionsSince(kind: string, sinceTs: number) {
    return this.actionList
      .filter((a) => a.kind === kind && a.ts >= sinceTs)
      .reduce((n, a) => n + (Array.isArray(a.data?.addresses) ? (a.data!.addresses as unknown[]).length : 1), 0);
  }
  async setStatus(caseKey: Hex, status: CaseStatus, ts: number) {
    const c = this.cases.get(caseKey);
    if (!c) throw new Error(`unknown case ${caseKey}`);
    c.status = status;
    c.updatedTs = ts;
  }
  async markReorged(fromBlock: bigint) {
    const keys = new Set<Hex>();
    for (const h of this.hits.values()) {
      if (h.caseKey && h.blockNumber !== null && h.blockNumber >= fromBlock) keys.add(h.caseKey);
    }
    for (const k of keys) this.cases.get(k)!.needsReview = true;
    return [...keys];
  }
  async useApprovalToken(jti: string) {
    if (this.tokens.has(jti)) return false;
    this.tokens.add(jti);
    return true;
  }
  async addMintRequest(to: Address, amount: bigint, ref: string, _ts?: number) {
    this.mintRequests.push({to: lower(to), amount, ref, consumedBy: null});
  }
  async consumeMintRequest(to: Address, amount: bigint, eventRef: string) {
    if (this.mintRequests.some((r) => r.consumedBy === eventRef)) return true; // 재처리 멱등
    const r = this.mintRequests.find((x) => x.consumedBy === null && x.to === lower(to) && x.amount === amount);
    if (!r) return false;
    r.consumedBy = eventRef;
    return true;
  }
}
