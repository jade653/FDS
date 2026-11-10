import type {Redis} from "ioredis";

/** 리더 선출 락 (design.md 8.3 단일 작성자 nonce 관리). 락을 쥔 인스턴스만 서명한다. */
export interface LeaderLock {
  /** 비어 있으면 잡고, 이미 내 것이면 연장한다. 쥐고 있으면 true. */
  acquire(owner: string, ttlMs: number): Promise<boolean>;
  release(owner: string): Promise<void>;
}

export class MemoryLock implements LeaderLock {
  private owner: string | null = null;
  private until = 0;
  async acquire(owner: string, ttlMs: number) {
    const now = Date.now();
    if (this.owner === null || this.owner === owner || this.until < now) {
      this.owner = owner;
      this.until = now + ttlMs;
      return true;
    }
    return false;
  }
  async release(owner: string) {
    if (this.owner === owner) this.owner = null;
  }
}

/** Redis SET NX PX 락. 연장과 해제는 소유자 확인 후에만 한다 (Lua). */
export class RedisLock implements LeaderLock {
  constructor(
    private readonly redis: Redis,
    private readonly key = "stb:responder:leader",
  ) {}

  async acquire(owner: string, ttlMs: number): Promise<boolean> {
    const ok = await this.redis.set(this.key, owner, "PX", ttlMs, "NX");
    if (ok === "OK") return true;
    const renewed = await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      this.key,
      owner,
      String(ttlMs),
    );
    return Number(renewed) === 1;
  }

  async release(owner: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      this.key,
      owner,
    );
  }
}
