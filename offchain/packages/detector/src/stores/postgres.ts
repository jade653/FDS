import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import type {Address, Decision, Hex, RuleId} from "@stb/common";
import {lower} from "@stb/common";
import {
  DECISION_RANK,
  type ActionRecord,
  type AddressInfo,
  type CaseRecord,
  type CaseStatus,
  type Cursor,
  type HitRecord,
  type Store,
} from "./types";

/** pg.Pool과 pg-mem 어댑터가 공통으로 갖는 최소 인터페이스 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{rows: any[]; rowCount: number | null}>;
}

export const MIGRATION_SQL = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../sql/001_init.sql"),
  "utf8",
);

/** PostgreSQL 저장소 (design.md 7.1). 탐지기는 한 인스턴스만 쓴다(단일 작성자). */
export class PgStore implements Store {
  constructor(private readonly db: Queryable) {}

  async migrate(): Promise<void> {
    for (const stmt of MIGRATION_SQL.split(/;\s*$/m)) {
      const sql = stmt
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (sql) await this.db.query(sql);
    }
  }

  // --- cursor ---
  async getCursor(): Promise<Cursor | undefined> {
    const {rows} = await this.db.query("SELECT block, hash FROM cursor WHERE id = 1");
    return rows[0] ? {block: BigInt(rows[0].block), hash: rows[0].hash} : undefined;
  }
  async setCursor(c: Cursor): Promise<void> {
    await this.db.query(
      "INSERT INTO cursor (id, block, hash) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET block = EXCLUDED.block, hash = EXCLUDED.hash",
      [c.block.toString(), c.hash],
    );
  }
  async getBlockHash(block: bigint): Promise<Hex | undefined> {
    const {rows} = await this.db.query("SELECT hash FROM block_hashes WHERE block = $1", [block.toString()]);
    return rows[0]?.hash;
  }
  async setBlockHash(block: bigint, hash: Hex): Promise<void> {
    await this.db.query(
      "INSERT INTO block_hashes (block, hash) VALUES ($1, $2) ON CONFLICT (block) DO UPDATE SET hash = EXCLUDED.hash",
      [block.toString(), hash],
    );
  }
  async pruneBlockHashes(below: bigint): Promise<void> {
    await this.db.query("DELETE FROM block_hashes WHERE block < $1", [below.toString()]);
  }

  async getMeta(key: string): Promise<string | undefined> {
    const {rows} = await this.db.query("SELECT value FROM meta WHERE key = $1", [key]);
    return rows[0]?.value;
  }
  async setMeta(key: string, value: string): Promise<void> {
    await this.db.query(
      "INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value],
    );
  }

  // --- addresses ---
  async getAddress(a: Address): Promise<AddressInfo | undefined> {
    const {rows} = await this.db.query("SELECT * FROM addresses WHERE address = $1", [lower(a)]);
    const r = rows[0];
    if (!r) return undefined;
    return {
      address: r.address,
      firstSeenTs: Number(r.first_seen_ts),
      firstSeenBlock: BigInt(r.first_seen_block),
      txCount: Number(r.tx_count),
      lastPos: r.last_pos,
      nonce: r.nonce === null ? null : Number(r.nonce),
      frozen: Boolean(r.frozen),
    };
  }
  async putAddress(i: AddressInfo): Promise<void> {
    await this.db.query(
      `INSERT INTO addresses (address, first_seen_ts, first_seen_block, tx_count, last_pos, nonce, frozen)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (address) DO UPDATE SET first_seen_ts = EXCLUDED.first_seen_ts, first_seen_block = EXCLUDED.first_seen_block,
         tx_count = EXCLUDED.tx_count, last_pos = EXCLUDED.last_pos, nonce = EXCLUDED.nonce, frozen = EXCLUDED.frozen`,
      [lower(i.address), i.firstSeenTs, i.firstSeenBlock.toString(), i.txCount, i.lastPos, i.nonce, i.frozen],
    );
  }

  // --- detections ---
  async recordHit(h: HitRecord, caseKey: Hex | null): Promise<void> {
    await this.db.query(
      `INSERT INTO detections (id, address, rule, points, ts, block, tx_hash, detail, case_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET case_key = COALESCE(EXCLUDED.case_key, detections.case_key)`,
      [h.id, lower(h.address), h.rule, h.points, h.ts, h.blockNumber?.toString() ?? null, h.txHash, h.detail, caseKey],
    );
  }
  async hitsFor(address: Address): Promise<HitRecord[]> {
    const {rows} = await this.db.query("SELECT * FROM detections WHERE address = $1 ORDER BY ts", [lower(address)]);
    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      rule: r.rule as RuleId,
      points: Number(r.points),
      ts: Number(r.ts),
      blockNumber: r.block === null ? null : BigInt(r.block),
      txHash: r.tx_hash,
      detail: r.detail,
    }));
  }

  // --- cases ---
  private async loadCase(caseKey: string): Promise<CaseRecord | undefined> {
    const {rows} = await this.db.query("SELECT * FROM cases WHERE case_key = $1", [caseKey]);
    const c = rows[0];
    if (!c) return undefined;
    const addrs = await this.db.query("SELECT address, decision, score FROM case_addresses WHERE case_key = $1", [
      caseKey,
    ]);
    return {
      caseKey: c.case_key,
      caseString: c.case_string,
      status: c.status,
      needsReview: Boolean(c.needs_review),
      createdTs: Number(c.created_ts),
      updatedTs: Number(c.updated_ts),
      addresses: addrs.rows.map((r) => ({address: r.address, decision: r.decision, score: Number(r.score)})),
    };
  }
  async findOpenCase(addresses: Address[], sinceTs: number): Promise<CaseRecord | undefined> {
    if (addresses.length === 0) return undefined;
    const params = addresses.map(lower);
    const placeholders = params.map((_, i) => `$${i + 2}`).join(", ");
    const {rows} = await this.db.query(
      `SELECT DISTINCT c.case_key, c.created_ts FROM cases c JOIN case_addresses a ON a.case_key = c.case_key
       WHERE c.status = 'open' AND c.updated_ts >= $1 AND a.address IN (${placeholders}) ORDER BY c.created_ts`,
      [sinceTs, ...params],
    );
    return rows[0] ? this.loadCase(rows[0].case_key) : undefined;
  }
  async createCase(caseKey: Hex, caseString: string, ts: number): Promise<CaseRecord> {
    await this.db.query(
      `INSERT INTO cases (case_key, case_string, status, needs_review, created_ts, updated_ts)
       VALUES ($1, $2, 'open', FALSE, $3, $3) ON CONFLICT (case_key) DO NOTHING`,
      [caseKey, caseString, ts],
    );
    return (await this.loadCase(caseKey))!;
  }
  async getCase(caseKey: Hex): Promise<CaseRecord | undefined> {
    return this.loadCase(caseKey);
  }
  async listCases(): Promise<CaseRecord[]> {
    const {rows} = await this.db.query("SELECT case_key FROM cases ORDER BY created_ts");
    const out: CaseRecord[] = [];
    for (const r of rows) out.push((await this.loadCase(r.case_key))!);
    return out;
  }
  async setDecision(caseKey: Hex, address: Address, decision: Decision | "related", score: number, ts: number) {
    const a = lower(address);
    await this.db.query("UPDATE cases SET updated_ts = GREATEST(updated_ts, $2) WHERE case_key = $1", [caseKey, ts]);
    const {rows} = await this.db.query("SELECT decision, score FROM case_addresses WHERE case_key = $1 AND address = $2", [
      caseKey,
      a,
    ]);
    if (!rows[0]) {
      await this.db.query("INSERT INTO case_addresses (case_key, address, decision, score) VALUES ($1, $2, $3, $4)", [
        caseKey,
        a,
        decision,
        score,
      ]);
      return true;
    }
    const cur = rows[0].decision as Decision | "related";
    const escalate = DECISION_RANK[decision] > DECISION_RANK[cur];
    await this.db.query("UPDATE case_addresses SET decision = $3, score = $4 WHERE case_key = $1 AND address = $2", [
      caseKey,
      a,
      escalate ? decision : cur,
      Math.max(Number(rows[0].score), score),
    ]);
    return escalate;
  }
  async addAction(x: ActionRecord): Promise<void> {
    const n = Array.isArray(x.data?.addresses) ? (x.data!.addresses as unknown[]).length : 1;
    await this.db.query(
      "INSERT INTO actions (case_key, kind, actor, tx_hash, ts, n_addresses, data) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [x.caseKey, x.kind, x.actor, x.txHash ?? null, x.ts, n, x.data ? JSON.stringify(x.data, bigintJson) : null],
    );
  }
  async actions(caseKey: Hex): Promise<ActionRecord[]> {
    const {rows} = await this.db.query("SELECT * FROM actions WHERE case_key = $1 ORDER BY id", [caseKey]);
    return rows.map((r) => ({
      caseKey: r.case_key,
      kind: r.kind,
      actor: r.actor,
      txHash: r.tx_hash,
      ts: Number(r.ts),
      data: r.data ? JSON.parse(r.data) : undefined,
    }));
  }
  async countActionsSince(kind: string, sinceTs: number): Promise<number> {
    const {rows} = await this.db.query("SELECT n_addresses FROM actions WHERE kind = $1 AND ts >= $2", [kind, sinceTs]);
    return rows.reduce((s, r) => s + Number(r.n_addresses), 0);
  }
  async setStatus(caseKey: Hex, status: CaseStatus, ts: number): Promise<void> {
    await this.db.query("UPDATE cases SET status = $2, updated_ts = $3 WHERE case_key = $1", [caseKey, status, ts]);
  }
  async markReorged(fromBlock: bigint): Promise<Hex[]> {
    const {rows} = await this.db.query(
      "SELECT DISTINCT case_key FROM detections WHERE case_key IS NOT NULL AND block >= $1",
      [fromBlock.toString()],
    );
    for (const r of rows) await this.db.query("UPDATE cases SET needs_review = TRUE WHERE case_key = $1", [r.case_key]);
    return rows.map((r) => r.case_key);
  }
  async useApprovalToken(jti: string, caseKey: Hex, address: Address, usedBy: string, ts: number): Promise<boolean> {
    // 기본 키 충돌(23505)로 1회용을 강제한다. 동시에 두 요청이 와도 하나만 성공한다.
    try {
      await this.db.query(
        "INSERT INTO approval_tokens (jti, case_key, address, used_by, used_ts) VALUES ($1, $2, $3, $4, $5)",
        [jti, caseKey, lower(address), usedBy, ts],
      );
      return true;
    } catch (err: any) {
      if (err?.code === "23505" || /duplicate|unique|already exists/i.test(String(err?.message))) return false;
      throw err;
    }
  }
  async addMintRequest(to: Address, amount: bigint, ref: string, ts: number): Promise<void> {
    await this.db.query("INSERT INTO mint_requests (to_address, amount, ref, created_ts) VALUES ($1, $2, $3, $4)", [
      lower(to),
      amount.toString(),
      ref,
      ts,
    ]);
  }
  async consumeMintRequest(to: Address, amount: bigint, eventRef: string): Promise<boolean> {
    const done = await this.db.query("SELECT id FROM mint_requests WHERE consumed_by = $1", [eventRef]);
    if (done.rows.length > 0) return true;
    const {rows} = await this.db.query(
      "SELECT id FROM mint_requests WHERE consumed_by IS NULL AND to_address = $1 AND amount = $2 ORDER BY id LIMIT 1",
      [lower(to), amount.toString()],
    );
    if (!rows[0]) return false;
    await this.db.query("UPDATE mint_requests SET consumed_by = $2 WHERE id = $1", [rows[0].id, eventRef]);
    return true;
  }
}

function bigintJson(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}
