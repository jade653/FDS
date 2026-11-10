import {describe, expect, it} from "vitest";
import {newDb} from "pg-mem";
import RedisMock from "ioredis-mock";
import type {Redis} from "ioredis";
import type {Hex} from "@stb/common";
import {MemoryStore, MemoryWindowStore} from "../src/stores/memory";
import {PgStore} from "../src/stores/postgres";
import {RedisWindowStore} from "../src/stores/redis";
import type {HitRecord, Store, WindowStore} from "../src/stores/types";
import {A} from "./helpers";

const CASE = ("0x" + "ab".repeat(32)) as Hex;
const CASE2 = ("0x" + "cd".repeat(32)) as Hex;

async function pgStore(): Promise<PgStore> {
  const db = newDb();
  const {Pool} = db.adapters.createPg();
  const s = new PgStore(new Pool());
  await s.migrate();
  return s;
}

const stores: [string, () => Promise<Store>][] = [
  ["memory", async () => new MemoryStore()],
  ["postgres (pg-mem)", pgStore],
];

const hit = (id: string, rule: HitRecord["rule"], ts: number, block: bigint | null = 10n, address = A(1)): HitRecord => ({
  id,
  address,
  rule,
  points: 40,
  ts,
  blockNumber: block,
  txHash: null,
  detail: "d",
});

describe.each(stores)("Store 계약: %s", (_name, make) => {
  it("커서와 블록 해시 (재시작 뒤 이어서 처리)", async () => {
    const s = await make();
    expect(await s.getCursor()).toBeUndefined();
    await s.setCursor({block: 5n, hash: "0x05"});
    await s.setCursor({block: 6n, hash: "0x06"});
    expect(await s.getCursor()).toEqual({block: 6n, hash: "0x06"});
    await s.setBlockHash(6n, "0x06");
    await s.setBlockHash(3n, "0x03");
    await s.pruneBlockHashes(5n);
    expect(await s.getBlockHash(6n)).toBe("0x06");
    expect(await s.getBlockHash(3n)).toBeUndefined();
    await s.setMeta("k", "v");
    expect(await s.getMeta("k")).toBe("v");
  });

  it("주소 정보", async () => {
    const s = await make();
    await s.putAddress({address: A(7), firstSeenTs: 1, firstSeenBlock: 2n, txCount: 3, lastPos: "p", nonce: null, frozen: true});
    expect(await s.getAddress(A(7))).toEqual({address: A(7), firstSeenTs: 1, firstSeenBlock: 2n, txCount: 3, lastPos: "p", nonce: null, frozen: true});
    await s.putAddress({address: A(7), firstSeenTs: 1, firstSeenBlock: 2n, txCount: 4, lastPos: "q", nonce: 9, frozen: false});
    expect((await s.getAddress(A(7)))!.nonce).toBe(9);
  });

  it("사건: 결정은 올라갈 때만 true, 열린 사건 찾기, 재조직 표시", async () => {
    const s = await make();
    await s.createCase(CASE, "case-1", 100);
    expect(await s.setDecision(CASE, A(1), "human_review", 60, 100)).toBe(true);
    expect(await s.setDecision(CASE, A(1), "human_review", 70, 101)).toBe(false);
    expect(await s.setDecision(CASE, A(1), "related", 0, 101)).toBe(false);
    expect(await s.setDecision(CASE, A(1), "auto_freeze", 90, 102)).toBe(true);
    const c = (await s.getCase(CASE))!;
    expect(c.addresses).toEqual([{address: A(1), decision: "auto_freeze", score: 90}]);

    expect((await s.findOpenCase([A(9), A(1)], 50))!.caseKey).toBe(CASE);
    expect(await s.findOpenCase([A(1)], 200)).toBeUndefined(); // 윈도우 밖
    expect(await s.findOpenCase([A(2)], 0)).toBeUndefined();

    await s.recordHit(hit("h1", "R1", 100, 10n), CASE);
    await s.recordHit(hit("h1", "R1", 100, 10n), null); // 재처리: 사건 연결 유지
    expect(await s.markReorged(11n)).toEqual([]);
    expect(await s.markReorged(10n)).toEqual([CASE]);
    expect((await s.getCase(CASE))!.needsReview).toBe(true);
    expect(await s.hitsFor(A(1))).toHaveLength(1);

    await s.setStatus(CASE, "false_positive", 300);
    expect(await s.findOpenCase([A(1)], 0)).toBeUndefined();
  });

  it("조치 기록과 시간당 집계 (자동 동결 상한)", async () => {
    const s = await make();
    await s.createCase(CASE, "c", 1);
    await s.addAction({caseKey: CASE, kind: "freeze_sent", actor: "bot", ts: 100, data: {addresses: [A(1), A(2)]}});
    await s.addAction({caseKey: CASE, kind: "freeze_sent", actor: "bot", ts: 200, data: {addresses: [A(3)]}});
    await s.addAction({caseKey: CASE, kind: "other", actor: "x", ts: 200});
    expect(await s.countActionsSince("freeze_sent", 150)).toBe(1);
    expect(await s.countActionsSince("freeze_sent", 0)).toBe(3);
    expect((await s.actions(CASE)).map((a) => a.kind)).toEqual(["freeze_sent", "freeze_sent", "other"]);
  });

  it("승인 토큰은 한 번만 쓴다", async () => {
    const s = await make();
    expect(await s.useApprovalToken("j1", CASE, A(1), "alice", 1)).toBe(true);
    expect(await s.useApprovalToken("j1", CASE2, A(1), "bob", 2)).toBe(false);
  });

  it("발행 요청 소비 (R8)", async () => {
    const s = await make();
    await s.addMintRequest(A(1), 100n, "r", 1);
    expect(await s.consumeMintRequest(A(1), 100n, "ev1")).toBe(true);
    expect(await s.consumeMintRequest(A(1), 100n, "ev1")).toBe(true); // 같은 이벤트 재처리
    expect(await s.consumeMintRequest(A(1), 100n, "ev2")).toBe(false);
    expect(await s.consumeMintRequest(A(2), 5n, "ev3")).toBe(false);
  });
});

const windows: [string, () => WindowStore][] = [
  ["memory", () => new MemoryWindowStore()],
  ["redis (ioredis-mock)", () => new RedisWindowStore(new (RedisMock as any)() as Redis, `t${Math.random()}:`)],
];

describe.each(windows)("WindowStore 계약: %s", (_name, make) => {
  it("점수는 윈도우 안 룰별 최신 하나씩의 합", async () => {
    const w = make();
    await w.addHit(hit("a", "R2", 100));
    await w.addHit(hit("b", "R2", 110)); // 같은 룰 두 번 → 한 번만
    await w.addHit({...hit("c", "R1b", 120), points: 60});
    await w.addHit(hit("a", "R2", 100)); // 같은 id 재처리
    expect(await w.score(A(1), 120, 1800)).toMatchObject({score: 100, rules: ["R1b", "R2"]});
    expect((await w.score(A(1), 110 + 1800 - 5, 1800)).score).toBe(100);
    expect(await w.score(A(1), 100 + 1800 + 15, 1800)).toMatchObject({score: 60, rules: ["R1b"]});
  });

  it("시계열과 재조직 제거, 정리", async () => {
    const w = make();
    await w.addSeries("k", {member: "m1", ts: 10, value: 5n, block: 1n, ref: A(3)});
    await w.addSeries("k", {member: "m2", ts: 20, value: 7n, block: 2n});
    await w.addSeries("k", {member: "m1", ts: 10, value: 5n, block: 1n, ref: A(3)});
    await w.addHit(hit("h", "R1", 20, 2n));
    expect((await w.series("k", 0)).map((i) => [i.member, i.value])).toEqual([["m1", 5n], ["m2", 7n]]);
    expect((await w.series("k", 0))[0].ref).toBe(A(3));

    await w.removeFromBlock(2n);
    expect((await w.series("k", 0)).map((i) => i.member)).toEqual(["m1"]);
    expect((await w.score(A(1), 20, 100)).score).toBe(0);

    await w.prune(15);
    expect(await w.series("k", 0)).toEqual([]);
  });
});
