import {describe, expect, it} from "vitest";
import {units, type Address, type RuleId} from "@stb/common";
import {A, Blocks, D, makeConfig, makeDetector, type BookOpts} from "./helpers";

// design.md 12장: 각 룰에 대해 발동해야 하는 이벤트 열과 발동하면 안 되는 이벤트 열을 고정 데이터로 둔다.

const HOT = A(0x101);
const WATCHED = A(0x102);
const EXCHANGE = A(0x103);
const ROUTER = A(0x104);
const USER = A(0x201);
const OLD = A(0x202);
const X = A(0x301);

function setup(opts: BookOpts = {hot: [HOT], watched: [WATCHED], whitelabel: [EXCHANGE], exits: [ROUTER]}, risk: Address[] = []) {
  const t = makeDetector(makeConfig(opts, undefined, risk));
  const b = new Blocks();
  const rulesOf = async (a: Address) => [...new Set((await t.store.hitsFor(a)).map((h) => h.rule))].sort() as RuleId[];
  return {...t, b, rulesOf};
}

describe("R1 감시 지갑 유출 속도", () => {
  it("발동: 10분 안에 잔고의 30% 초과 유출", async () => {
    const t = setup();
    t.chain.balances.set(HOT, units(600_000)); // 유출 뒤 잔고
    await t.detector.processBlock([t.b.transfer(HOT, USER, 400_000)]); // 400k / 1,000k = 40%
    expect(await t.rulesOf(HOT)).toContain("R1");
  });

  it("발동: 비율은 낮아도 절대량 100,000 초과", async () => {
    const t = setup();
    t.chain.balances.set(WATCHED, units(10_000_000));
    await t.detector.processBlock([t.b.transfer(WATCHED, USER, 100_001)]);
    expect(await t.rulesOf(WATCHED)).toContain("R1");
  });

  it("발동: 윈도우 안의 여러 유출을 합산", async () => {
    const t = setup();
    t.chain.balances.set(WATCHED, units(10_000_000));
    await t.detector.processBlock([t.b.transfer(WATCHED, USER, 60_000)]);
    t.b.next(9 * 60);
    await t.detector.processBlock([t.b.transfer(WATCHED, X, 60_000)]);
    expect(await t.rulesOf(WATCHED)).toContain("R1");
  });

  it("미발동: 기준 이하이거나 윈도우 밖", async () => {
    const t = setup();
    t.chain.balances.set(WATCHED, units(10_000_000));
    await t.detector.processBlock([t.b.transfer(WATCHED, USER, 100_000)]); // 정확히 100,000은 초과가 아님, 1%
    t.b.next(11 * 60);
    await t.detector.processBlock([t.b.transfer(WATCHED, X, 60_000)]); // 앞 유출은 윈도우 밖
    expect(await t.rulesOf(WATCHED)).not.toContain("R1");
  });

  it("미발동: 감시 지갑이 아니면 보지 않는다", async () => {
    const t = setup();
    t.chain.balances.set(USER, 0n);
    await t.detector.processBlock([t.b.transfer(USER, X, 900_000)]);
    expect(await t.rulesOf(USER)).not.toContain("R1");
  });
});

describe("R1b 유출 수신", () => {
  it("발동: R1 유출의 수신 주소 / 미발동: 화이트 라벨 수신자", async () => {
    const t = setup();
    t.chain.balances.set(HOT, 0n);
    await t.detector.processBlock([t.b.transfer(HOT, USER, 300_000), t.b.transfer(HOT, EXCHANGE, 300_000)]);
    expect(await t.rulesOf(USER)).toContain("R1b");
    expect(await t.rulesOf(EXCHANGE)).toEqual([]);
  });
});

describe("R2 신규 주소로 대량 유입", () => {
  it("발동: 처음 보는 주소(nonce ≤ 5)가 50,000 이상 수신", async () => {
    const t = setup();
    t.chain.nonces.set(X, 5);
    await t.detector.processBlock([t.b.transfer(USER, X, 50_000)]);
    expect(await t.rulesOf(X)).toEqual(["R2"]);
  });

  it("발동: 감시탑이 늦게 처리해 최신 nonce가 커졌어도, 유입 블록 시점 nonce로 판정한다", async () => {
    // 공격자가 유입 직후 분산 송금 20건을 연달아 내 최신 nonce는 20이지만, 유입 블록에서는 0이었다.
    const t = setup();
    t.chain.nonces.set(X, 20);
    t.chain.noncesAt.set(`${X.toLowerCase()}@${t.b.block}`, 0);
    await t.detector.processBlock([t.b.transfer(USER, X, 100_000)]);
    expect(await t.rulesOf(X)).toEqual(["R2"]);
  });

  it("미발동: 오래된 지갑(nonce > 5)의 첫 입금", async () => {
    const t = setup();
    t.chain.nonces.set(OLD, 6);
    await t.detector.processBlock([t.b.transfer(USER, OLD, 500_000)]);
    expect(await t.rulesOf(OLD)).toEqual([]);
  });

  it("미발동: 토큰 첫 등장이 24시간 넘음", async () => {
    const t = setup();
    await t.detector.processBlock([t.b.transfer(USER, X, 1)]);
    t.b.next(25 * 3600);
    await t.detector.processBlock([t.b.transfer(USER, X, 100_000)]);
    expect(await t.rulesOf(X)).toEqual([]);
  });

  it("미발동: 기준 미만, 화이트 라벨", async () => {
    const t = setup();
    await t.detector.processBlock([t.b.transfer(USER, X, 49_999), t.b.transfer(USER, EXCHANGE, 900_000)]);
    expect(await t.rulesOf(X)).toEqual([]);
    expect(await t.rulesOf(EXCHANGE)).toEqual([]);
  });
});

describe("R3 분산 송금", () => {
  it("발동: 10분 안에 신규 주소 10개로 송금", async () => {
    const t = setup();
    const evs = Array.from({length: 10}, (_, i) => t.b.transfer(USER, A(0x5000 + i), 10));
    await t.detector.processBlock(evs);
    expect(await t.rulesOf(USER)).toContain("R3");
  });

  it("미발동: 9개, 또는 10분을 넘겨 나눠 보냄", async () => {
    const t = setup();
    await t.detector.processBlock(Array.from({length: 9}, (_, i) => t.b.transfer(USER, A(0x5000 + i), 10)));
    expect(await t.rulesOf(USER)).not.toContain("R3");
    t.b.next(11 * 60);
    await t.detector.processBlock([t.b.transfer(USER, A(0x6000), 10)]);
    expect(await t.rulesOf(USER)).not.toContain("R3");
  });

  it("미발동: 수신자가 신규가 아님", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) t.chain.nonces.set(A(0x5000 + i), 100);
    await t.detector.processBlock(Array.from({length: 10}, (_, i) => t.b.transfer(USER, A(0x5000 + i), 10)));
    expect(await t.rulesOf(USER)).not.toContain("R3");
  });
});

describe("R4 집중 유입", () => {
  it("발동: 감시 지갑 2개 → 같은 주소 / 미발동: 1개", async () => {
    const t = setup({hot: [HOT], watched: [WATCHED]});
    t.chain.balances.set(HOT, units(1_000_000_000));
    t.chain.balances.set(WATCHED, units(1_000_000_000));
    await t.detector.processBlock([t.b.transfer(HOT, X, 10)]);
    expect(await t.rulesOf(X)).not.toContain("R4");
    t.b.next();
    await t.detector.processBlock([t.b.transfer(WATCHED, X, 10)]);
    expect(await t.rulesOf(X)).toContain("R4");
  });
});

describe("R5 출구 접근", () => {
  it("발동: 대량 수신 뒤 DEX 라우터 approve", async () => {
    const t = setup();
    t.chain.nonces.set(X, 100);
    await t.detector.processBlock([t.b.transfer(USER, X, 60_000)]);
    t.b.next();
    await t.detector.processBlock([t.b.approval(X, ROUTER, 60_000)]);
    expect(await t.rulesOf(X)).toEqual(["R5"]);
  });

  it("발동: pending 단계의 approve", async () => {
    const t = setup();
    t.chain.nonces.set(X, 100);
    await t.detector.processBlock([t.b.transfer(USER, X, 60_000)]);
    await t.detector.processPending({
      kind: "pending",
      hash: "0x01",
      from: X,
      to: D.token,
      input: "0x",
      timestamp: t.b.ts + 1,
      call: {fn: "approve", parties: [X, ROUTER], spender: ROUTER},
    });
    expect(await t.rulesOf(X)).toEqual(["R5"]);
  });

  it("미발동: 소량 수신, 출구가 아닌 spender", async () => {
    const t = setup();
    t.chain.nonces.set(X, 100);
    await t.detector.processBlock([t.b.transfer(USER, X, 49_000), t.b.approval(X, ROUTER, 1)]);
    await t.detector.processBlock([t.b.transfer(USER, OLD, 900_000), t.b.approval(OLD, USER, 1)]);
    expect(await t.rulesOf(X)).toEqual([]);
    expect(await t.rulesOf(OLD)).not.toContain("R5");
  });
});

describe("R6 위임·코드 변경", () => {
  it("발동: 감시 EOA에 EIP-7702 위임 / 미발동: 감시 대상 아님, 빈 코드", async () => {
    const t = setup();
    await t.detector.processBlock([
      t.b.code(HOT, "0xef0100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      t.b.code(USER, "0x6000"),
      t.b.code(WATCHED, "0x"),
    ]);
    expect(await t.rulesOf(HOT)).toEqual(["R6"]);
    expect(await t.rulesOf(USER)).toEqual([]);
    expect(await t.rulesOf(WATCHED)).toEqual([]);
    expect((await t.store.hitsFor(HOT))[0].detail).toContain("EIP-7702");
  });
});

describe("R9 외부 위험 목록", () => {
  it("발동: 목록 주소가 관여 / 미발동: 목록에 없음", async () => {
    const t = setup(undefined, [X]);
    await t.detector.processBlock([t.b.transfer(USER, X, 1), t.b.transfer(USER, OLD, 1)]);
    expect(await t.rulesOf(X)).toContain("R9");
    expect(await t.rulesOf(OLD)).not.toContain("R9");
  });
});

describe("R10 동결 주소 관련 시도", () => {
  it("발동: 동결 주소의 실패한 전송 → 상대 주소, 동결 전 allowance 사용 시도 → spender", async () => {
    const t = setup();
    await t.detector.processBlock([t.b.frozen(X, D.bot)]);
    t.b.next();
    await t.detector.processBlock([t.b.tokenCall(X, [USER]), t.b.tokenCall(OLD, [X, A(0x777)], "transferFrom")]);
    expect(await t.rulesOf(USER)).toEqual(["R10"]);
    expect(await t.rulesOf(OLD)).toEqual(["R10"]);
    expect(await t.rulesOf(A(0x777))).toEqual(["R10"]);
    expect(await t.rulesOf(X)).toEqual([]); // 동결 주소 자신은 대상이 아님
  });

  it("미발동: 동결 주소가 없음, 보호 주소는 제외", async () => {
    const t = setup();
    await t.detector.processBlock([t.b.tokenCall(USER, [OLD])]);
    expect(await t.rulesOf(OLD)).toEqual([]);
    await t.detector.processBlock([t.b.frozen(X, D.bot)]);
    await t.detector.processBlock([t.b.tokenCall(D.minter, [X])]);
    expect(await t.rulesOf(D.minter)).toEqual([]);
  });
});

describe("R7 관리 이벤트 (알림만)", () => {
  const role = "0x" + "11".repeat(32);

  it("발동: 승인 목록에 없는 RoleGranted → 최고 등급 알림", async () => {
    const t = setup();
    await t.detector.processBlock([t.b.admin("RoleGranted", {role, account: X, sender: D.timelock}, D.timelock, X)]);
    const a = t.sinks.alertsOf("R7");
    expect(a).toHaveLength(1);
    expect(a[0].severity).toBe("critical");
  });

  it("미발동: 타임락이 실행한 트랜잭션 안의 변경", async () => {
    const t = setup();
    const ev = t.b.admin("RoleGranted", {role, account: X, sender: D.timelock}, D.timelock, X);
    await t.detector.processBlock([ev, t.b.sameTx(ev, t.b.timelockExecuted(D.token))]);
    expect(t.sinks.alertsOf("R7")).toHaveLength(0);
  });

  it("미발동: 운영 Safe가 보낸 FREEZER 회수·pause", async () => {
    const t = setup();
    await t.detector.processBlock([
      t.b.admin("RoleRevoked", {role, account: D.bot, sender: D.opsSafe}, D.opsSafe),
      t.b.admin("Paused", {account: D.opsSafe}, D.opsSafe),
    ]);
    expect(t.sinks.alertsOf("R7")).toHaveLength(0);
  });

  it("배포자: 역할 포기 전에는 승인, 포기 뒤에는 알림", async () => {
    const t = setup();
    const zero = "0x" + "00".repeat(32);
    await t.detector.processBlock([
      t.b.admin("ProtectedSet", {account: X, on: true}, undefined, D.deployer),
      t.b.admin("RoleRevoked", {role: zero, account: D.deployer, sender: D.deployer}, D.deployer, D.deployer),
    ]);
    expect(t.sinks.alertsOf("R7")).toHaveLength(0);
    t.b.next();
    await t.detector.processBlock([t.b.admin("ProtectedSet", {account: X, on: false}, undefined, D.deployer)]);
    expect(t.sinks.alertsOf("R7")).toHaveLength(1);
  });
});

describe("R8 비승인 발행 (알림만)", () => {
  it("발동: 발행 요청 기록이 없음 / 미발동: 요청과 일치, 같은 이벤트 재처리", async () => {
    const t = setup();
    await t.store.addMintRequest(X, units(1000), "req-1", 0);
    const ok = t.b.mint(D.minter, X, 1000);
    await t.detector.processBlock([ok]);
    await t.detector.processBlock([ok]); // 재처리해도 요청을 두 번 쓰지 않는다
    expect(t.sinks.alertsOf("R8")).toHaveLength(0);
    await t.detector.processBlock([t.b.mint(D.minter, X, 1000)]);
    expect(t.sinks.alertsOf("R8")).toHaveLength(1);
  });
});
