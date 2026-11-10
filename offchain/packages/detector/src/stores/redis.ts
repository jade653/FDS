import type {Redis} from "ioredis";
import type {Address} from "@stb/common";
import {lower} from "@stb/common";
import {scoreOf} from "./memory";
import type {HitRecord, ScoreResult, SeriesItem, WindowStore} from "./types";

/**
 * Redis 윈도우 저장소 (design.md 7.1: Redis sorted set으로 윈도우 집계).
 *
 * - `{p}hits:{addr}`   ZSET  member = hit id, score = ts
 * - `{p}hitd`          HASH  hit id → JSON
 * - `{p}s:{key}`       ZSET  member, score = ts
 * - `{p}sd:{key}`      HASH  member → JSON
 * - `{p}byblock`       ZSET  "<kind>\0<key>\0<member>", score = block (재조직 때 지울 항목)
 *
 * 같은 member를 다시 넣으면 덮어쓰므로 재처리해도 결과가 같다.
 */
export class RedisWindowStore implements WindowStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "stb:",
  ) {}

  private k(s: string) {
    return this.prefix + s;
  }

  async addHit(h: HitRecord): Promise<void> {
    const addr = lower(h.address);
    const m = this.redis.multi();
    m.zadd(this.k(`hits:${addr}`), h.ts, h.id);
    m.hset(this.k("hitd"), h.id, JSON.stringify({...h, address: addr, blockNumber: h.blockNumber?.toString() ?? null}));
    if (h.blockNumber !== null) m.zadd(this.k("byblock"), Number(h.blockNumber), `h\0${addr}\0${h.id}`);
    await m.exec();
  }

  async score(address: Address, now: number, windowSec: number): Promise<ScoreResult> {
    const ids = await this.redis.zrangebyscore(this.k(`hits:${lower(address)}`), now - windowSec, now);
    if (ids.length === 0) return {score: 0, rules: [], hits: []};
    const raw = await this.redis.hmget(this.k("hitd"), ...ids);
    const hits: HitRecord[] = raw
      .filter((r): r is string => r !== null)
      .map((r) => {
        const o = JSON.parse(r);
        return {...o, blockNumber: o.blockNumber === null ? null : BigInt(o.blockNumber)};
      });
    return scoreOf(hits);
  }

  async addSeries(key: string, item: SeriesItem): Promise<void> {
    const m = this.redis.multi();
    m.zadd(this.k(`s:${key}`), item.ts, item.member);
    m.hset(
      this.k(`sd:${key}`),
      item.member,
      JSON.stringify({...item, value: item.value.toString(), block: item.block?.toString() ?? null}),
    );
    if (item.block !== null) m.zadd(this.k("byblock"), Number(item.block), `s\0${key}\0${item.member}`);
    await m.exec();
  }

  async series(key: string, fromTs: number): Promise<SeriesItem[]> {
    const members = await this.redis.zrangebyscore(this.k(`s:${key}`), fromTs, "+inf");
    if (members.length === 0) return [];
    const raw = await this.redis.hmget(this.k(`sd:${key}`), ...members);
    return raw
      .filter((r): r is string => r !== null)
      .map((r) => {
        const o = JSON.parse(r);
        return {...o, value: BigInt(o.value), block: o.block === null ? null : BigInt(o.block)};
      });
  }

  async removeFromBlock(block: bigint): Promise<void> {
    const entries = await this.redis.zrangebyscore(this.k("byblock"), Number(block), "+inf");
    if (entries.length === 0) return;
    const m = this.redis.multi();
    for (const e of entries) {
      const [kind, key, member] = e.split("\0");
      if (kind === "h") {
        m.zrem(this.k(`hits:${key}`), member);
        m.hdel(this.k("hitd"), member);
      } else {
        m.zrem(this.k(`s:${key}`), member);
        m.hdel(this.k(`sd:${key}`), member);
      }
    }
    m.zremrangebyscore(this.k("byblock"), Number(block), "+inf");
    await m.exec();
  }

  async prune(beforeTs: number): Promise<void> {
    // 윈도우 밖 항목을 지운다. byblock 색인은 재조직 깊이만큼만 의미가 있으므로 함께 정리하지 않아도 무해하다.
    const stream = this.redis.scanStream({match: this.k("*"), count: 200});
    for await (const keys of stream as AsyncIterable<string[]>) {
      for (const key of keys) {
        const isHits = key.startsWith(this.k("hits:"));
        if (!isHits && !key.startsWith(this.k("s:"))) continue;
        const old = await this.redis.zrangebyscore(key, "-inf", `(${beforeTs}`);
        if (old.length === 0) continue;
        const dataKey = isHits ? this.k("hitd") : this.k("sd:" + key.slice(this.k("s:").length));
        await this.redis.multi().zrem(key, ...old).hdel(dataKey, ...old).exec();
      }
    }
  }
}
