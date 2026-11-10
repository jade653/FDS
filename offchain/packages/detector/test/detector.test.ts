import {describe, expect, it} from "vitest";
import {units} from "@stb/common";
import {A, Blocks, D, makeConfig, makeDetector} from "./helpers";

const HOT1 = A(0x101);
const HOT2 = A(0x102);
const HOT3 = A(0x103);
const PARTNER = A(0x104); // 감시만 하는 지갑 (hot 아님)
const EXCHANGE = A(0x105);
const ATTACKER = A(0xbad);
const USER = A(0x201);

const book = {hot: [HOT1, HOT2, HOT3], watched: [PARTNER], whitelabel: [EXCHANGE]};

describe("R1b 전파 (design.md 12장)", () => {
  it("핫월렛 하나 → 신규 주소 하나 대량 유출: 수신 주소가 R1b + R2로 80 이상, 둘 다 자동 동결 (시나리오 1b)", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    t.chain.balances.set(HOT1, units(100_000)); // 유출 뒤 잔고
    await t.detector.processBlock([b.transfer(HOT1, ATTACKER, 900_000)]);

    const s = await t.window.score(ATTACKER, b.ts, 1800);
    expect(s.rules).toEqual(["R1b", "R2"]);
    expect(s.score).toBe(100);
    expect(t.sinks.freezes).toHaveLength(1); // 같은 사건으로 묶여 한 요청
    expect(new Set(t.sinks.frozenAddrs())).toEqual(new Set([HOT1, ATTACKER]));
    expect(t.sinks.freezes[0].source).toBe("auto");
  });

  it("수신자가 화이트 라벨이면 전파되지 않는다 (핫월렛은 R1으로 자동 동결)", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    t.chain.balances.set(HOT1, 0n);
    await t.detector.processBlock([b.transfer(HOT1, EXCHANGE, 900_000)]);
    expect((await t.window.score(EXCHANGE, b.ts, 1800)).score).toBe(0);
    expect(t.sinks.frozenAddrs()).toEqual([HOT1]);
  });
});

describe("시나리오 탐지 (design.md 12장 종단 간 시나리오 1·2·4)", () => {
  it("1. 대형 탈취: 핫월렛 3개 → 공격자. R1·R1b·R4 발동, 핫월렛과 공격자 자동 동결", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    for (const h of [HOT1, HOT2, HOT3]) t.chain.balances.set(h, units(50_000));
    t.chain.nonces.set(ATTACKER, 0);
    await t.detector.processBlock([b.transfer(HOT1, ATTACKER, 450_000)]);
    b.next();
    await t.detector.processBlock([b.transfer(HOT2, ATTACKER, 450_000)]);
    b.next();
    await t.detector.processBlock([b.transfer(HOT3, ATTACKER, 450_000)]);

    const s = await t.window.score(ATTACKER, b.ts, 1800);
    expect(s.rules).toEqual(["R1b", "R2", "R4"]);
    expect(new Set(t.sinks.frozenAddrs())).toEqual(new Set([HOT1, HOT2, HOT3, ATTACKER]));
    // 공격자는 첫 블록에서 이미 80을 넘으므로 한 번만 요청된다.
    expect(t.sinks.frozenAddrs().filter((a) => a === ATTACKER)).toHaveLength(1);
    // 모두 한 사건
    expect(new Set(t.sinks.freezes.map((f) => f.caseKey)).size).toBe(1);
  });

  it("2. 세탁 시도: 신규 주소 20개로 분산 송금 → R3 발동, 공격자 자동 동결, 연관 주소는 원클릭 승인 대상", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    await t.detector.processBlock([b.transfer(USER, ATTACKER, 1_000_000)]); // R2 40: 기록만
    expect(t.sinks.freezes).toHaveLength(0);
    b.next();
    const recipients = Array.from({length: 20}, (_, i) => A(0x9000 + i));
    await t.detector.processBlock(recipients.map((r) => b.transfer(ATTACKER, r, 50_000)));

    expect(t.sinks.frozenAddrs()).toEqual([ATTACKER]);
    const s = await t.window.score(ATTACKER, b.ts, 1800);
    expect(s.rules).toEqual(["R2", "R3"]);
    const rel = t.sinks.alertsOf("related_addresses");
    expect(rel).toHaveLength(1);
    expect(rel[0].approvalLinks!.map((l) => l.address).sort()).toEqual(recipients.slice(0, 20).sort());
    expect(rel[0].caseKey).toBe(t.sinks.freezes[0].caseKey);
  });

  it("4. 오탐 방지: 감시 지갑 → 거래소 입금 주소 대량 송금은 자동 동결 없이 사람 확인 알림만", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    t.chain.balances.set(PARTNER, 0n);
    await t.detector.processBlock([b.transfer(PARTNER, EXCHANGE, 900_000), b.transfer(USER, EXCHANGE, 900_000)]);
    expect(t.sinks.freezes).toHaveLength(0);
    const reviews = t.sinks.alertsOf("human_review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0].approvalLinks!.map((l) => l.address)).toEqual([PARTNER]);
    expect((await t.window.score(EXCHANGE, b.ts, 1800)).score).toBe(0);
  });

  it("핫월렛은 R1·R6 외 룰만으로 80을 넘어도 사람 확인", async () => {
    const t = makeDetector(makeConfig(book, undefined, [HOT1]));
    const b = new Blocks();
    await t.detector.processBlock([b.transfer(USER, HOT1, 1)]); // R9 80
    expect(t.sinks.freezes).toHaveLength(0);
    expect(t.sinks.alertsOf("human_review")[0].approvalLinks![0].address).toBe(HOT1);
  });
});

describe("멱등성과 재처리", () => {
  it("같은 블록을 두 번 처리해도 점수·요청·알림이 같다", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    t.chain.balances.set(HOT1, 0n);
    const evs = [b.transfer(HOT1, ATTACKER, 900_000), b.transfer(PARTNER, USER, 500_000)];
    await t.detector.processBlock(evs);
    const before = {
      score: await t.window.score(ATTACKER, b.ts, 1800),
      freezes: t.sinks.freezes.length,
      alerts: t.sinks.alerts.length,
      cases: (await t.store.listCases()).length,
    };
    await t.detector.processBlock(evs);
    expect(await t.window.score(ATTACKER, b.ts, 1800)).toEqual(before.score);
    expect(t.sinks.freezes.length).toBe(before.freezes);
    expect(t.sinks.alerts.length).toBe(before.alerts);
    expect((await t.store.listCases()).length).toBe(before.cases);
  });

  it("이미 동결된 주소는 다시 요청하지 않는다", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    await t.detector.processBlock([b.frozen(ATTACKER, D.opsSafe)]);
    b.next();
    t.chain.balances.set(HOT1, 0n);
    await t.detector.processBlock([b.transfer(HOT1, ATTACKER, 900_000)]);
    expect(t.sinks.frozenAddrs()).toEqual([HOT1]);
  });
});

describe("재조직", () => {
  it("사라진 블록의 윈도우 항목을 지우고 사건을 재검토 대상으로 표시한다", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    t.chain.balances.set(HOT1, 0n);
    await t.detector.processBlock([b.transfer(HOT1, ATTACKER, 900_000)]);
    const forkBlock = b.block;
    const [c] = await t.store.listCases();
    expect(c.needsReview).toBe(false);

    await t.detector.onReorg(forkBlock);
    expect((await t.window.score(ATTACKER, b.ts, 1800)).score).toBe(0);
    expect((await t.store.getCase(c.caseKey))!.needsReview).toBe(true);
    expect(t.sinks.alertsOf("reorg")).toHaveLength(1);
  });
});

describe("봇 동결 속도 감시 (시나리오 5)", () => {
  it("봇 operator의 Frozen이 시간당 상한을 넘으면 최고 등급 알림 한 번", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    await t.detector.processBlock(Array.from({length: 20}, (_, i) => b.frozen(A(0x7000 + i), D.bot)));
    expect(t.sinks.alertsOf("bot.freeze_rate")).toHaveLength(0);
    b.next();
    await t.detector.processBlock(Array.from({length: 5}, (_, i) => b.frozen(A(0x8000 + i), D.bot)));
    expect(t.sinks.alertsOf("bot.freeze_rate")).toHaveLength(1);
    expect(t.sinks.alertsOf("bot.freeze_rate")[0].severity).toBe("critical");
  });

  it("운영 Safe의 동결은 세지 않는다", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    await t.detector.processBlock(Array.from({length: 30}, (_, i) => b.frozen(A(0x7000 + i), D.opsSafe)));
    expect(t.sinks.alertsOf("bot.freeze_rate")).toHaveLength(0);
  });
});

describe("설정 핫리로드", () => {
  it("임계값을 바꾸면 다음 이벤트부터 새 값으로 판단한다", async () => {
    const t = makeDetector(makeConfig(book));
    const b = new Blocks();
    await t.detector.processBlock([b.transfer(USER, A(0x9001), 60_000)]); // R2 40 → 기록만
    expect(t.sinks.alerts.filter((a) => a.kind === "human_review")).toHaveLength(0);

    const cfg = makeConfig(book);
    cfg.rules.thresholds.human_review = 40;
    t.config.set(cfg);
    b.next();
    await t.detector.processBlock([b.transfer(USER, A(0x9002), 60_000)]);
    expect(t.sinks.alertsOf("human_review")).toHaveLength(1);
  });
});
