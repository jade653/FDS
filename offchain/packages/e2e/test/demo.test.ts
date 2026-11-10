import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createWalletClient, http, toHex, type Account, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {lower} from "@stb/common";
import {
  botCanStillFreeze,
  demoAllowancePlan,
  demoBotIncidentPlan,
  demoBotRestorePlan,
  demoExtraMintPlan,
  demoTimelockExecute,
  demoTimelockPlan,
  planReissue,
  planWipe,
  reconcileCase,
  scenario1,
  scenario3,
  scenario5StolenBot,
  demoActors,
  demoAddressesYaml,
  demoFund,
  demoMintPlan,
  demoStatus,
  executeLocal,
  PreconditionError,
  scenario1b,
  scenario2,
  scenario4,
  type DemoChain,
} from "@stb/ops-cli";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Anvil, deploy, frozenEvent, isFrozen, MNEMONIC, rpc, sleep, startWatchtower, waitFor, type Env} from "./harness";

// Sepolia 시연 스크립트(packages/ops-cli/src/demo.ts)를 로컬 Anvil에서 그대로 돌린다.
// 실제 체인과 다른 점: 발행 Safe 대신 Anvil 계정이 발행 배치를 실행하고(executeLocal), 니모닉이 Anvil 기본 니모닉이다.

const anvil = new Anvil(8646);
const actors = demoActors(MNEMONIC, 0);
const r1 = demoActors(MNEMONIC, 1);
const BOT_KEY: Hex = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"; // Anvil 기본 키 6 (배포 설정의 봇)
let env: Env;
let c: DemoChain;

beforeAll(async () => {
  await anvil.start();
  const {deploymentPath} = deploy(anvil);
  const dir = mkdtempSync(join(tmpdir(), "stb-demo-e2e-"));
  const addressesPath = join(dir, "addresses.yaml");
  writeFileSync(addressesPath, demoAddressesYaml({chainId: 31337, deployment: deploymentPath.replace(/\\/g, "/"), mnemonic: MNEMONIC}));
  env = await startWatchtower(anvil, addressesPath);
  c = {
    client: env.client,
    wallet: (account: Account) => createWalletClient({account, transport: http(anvil.http)}),
    token: env.token,
    timeoutMs: 30_000,
    pollMs: 200,
    log: () => {},
  };
});

afterAll(async () => {
  await env?.wt.stop();
  anvil.stop();
});

describe("Sepolia 시연 스크립트 (Anvil에서 실행)", () => {
  it("준비 전에는 시나리오가 원인을 알려 주며 거부한다", async () => {
    await expect(scenario1b(c, actors)).rejects.toBeInstanceOf(PreconditionError);
  });

  it("준비: 발행 배치와 가스 배분", async () => {
    const plan = await demoMintPlan(env.ops, actors);
    expect(lower(plan.meta.createdFromSafeAddress)).toBe(lower(env.ops.deployment.minter));
    expect(plan.transactions).toHaveLength(3);
    await executeLocal(env.ops, plan);
    await demoFund(c, actors);
    // 두 번째 실행은 이미 충분해 아무것도 보내지 않는다.
    expect(await demoFund(c, actors)).toEqual([]);
    const rows = await demoStatus(c, actors);
    const row = (role: string) => rows.find((r) => r.role === role)!;
    expect(row("hot").stb).toBe("300000");
    expect(row("victim").stb).toBe("200000");
    expect(row("partner").stb).toBe("200000");
    expect(Number(row("attacker2").eth)).toBeGreaterThan(0);
  });

  it("1b: 핫월렛과 공격자가 자동 동결된다", async () => {
    const r = await scenario1b(c, actors);
    expect(r.attacker.blocksAfterOutflow).toBeLessThanOrEqual(3);
    expect(r.hot.blocksAfterOutflow).toBeLessThanOrEqual(3);
    expect(r.attackerBalance).toBe("150000");
    expect((await env.store.hitsFor(lower(actors.attacker1b))).map((h) => h.rule).sort()).toEqual(["R1b", "R2"]);
    // 같은 회차를 다시 돌리면 이미 동결돼 거부한다.
    await expect(scenario1b(c, actors)).rejects.toBeInstanceOf(PreconditionError);
  });

  it("2: 분산 송금 공격자가 자동 동결되고 수신 주소는 승인 링크로 올라온다", async () => {
    const r = await scenario2(c, actors);
    expect(r.splits.sent).toBe(20);
    expect(r.splits.succeeded + r.splits.reverted).toBe(20);
    expect((await env.store.hitsFor(lower(actors.attacker2.address))).map((h) => h.rule)).toContain("R3");
    const rel = env.capture.of("related_addresses")[0];
    expect(rel?.approvalLinks?.length ?? 0).toBeGreaterThanOrEqual(10);
  });

  it("4: 파트너 → 거래소 송금은 자동 동결 없이 사람 확인 알림만", async () => {
    // Anvil은 거래가 없으면 블록을 만들지 않으므로 블록 대기 대신 알림을 기다린다.
    const r = await scenario4(c, actors, 0);
    const review = await waitFor("human review", async () =>
      env.capture.of("human_review").find((a) => (a.approvalLinks ?? []).some((l) => l.address === lower(actors.partner.address))),
    );
    expect(review).toBeDefined();
    await sleep(1500);
    expect(await isFrozen(env, actors.partner.address)).toBe(false);
    expect(await isFrozen(env, actors.exchange)).toBe(false);
    expect(r.tx).toMatch(/^0x/);
  });
});

describe("Sepolia 시연 2부: 시나리오 1·3·5·6·7 (Anvil에서 실행, Safe 배치는 Anvil 계정이 대신 실행)", () => {
  it("7b·7 R8: 금고 Safe 한도 변경은 R7, 요청 없는 발행은 R8 최고 등급 알림", async () => {
    const r7Before = env.capture.of("R7").length;
    await executeLocal(env.ops, demoAllowancePlan(env.ops));
    const r7 = await waitFor("R7", async () => env.capture.of("R7").length > r7Before && env.capture.of("R7").at(-1));
    expect(r7.severity).toBe("critical");
    expect(r7.title).toContain("MinterConfigured");
    const r8Before = env.capture.of("R8").length;
    await executeLocal(env.ops, await demoExtraMintPlan(env.ops, r1));
    await waitFor("R8 x4", async () => env.capture.of("R8").length >= r8Before + 4);
    await demoFund(c, r1, "extra");
  });

  it("1: 핫월렛 3개 동시 유출 → 공격자와 핫월렛 자동 동결", async () => {
    const r = await scenario1(c, r1);
    expect(r.outflows.filter((o) => o.ok).length).toBeGreaterThanOrEqual(1);
    expect(r.hotFrozen).toBe(r.outflows.filter((o) => o.ok).length);
    expect(r.attacker.blocksAfterFirstOutflow).toBeLessThanOrEqual(3);
    const rules = (await env.store.hitsFor(lower(r1.attacker1))).map((h) => h.rule);
    expect(rules).toContain("R1b");
  });

  it("3: pending approve를 보고 동결이 approve보다 먼저 들어간다", async () => {
    const bot = lower(env.ops.deployment.bot);
    try {
      const r = await scenario3(c, r1, {
        settleMs: 1500,
        beforeApprove: async () => {
          await rpc(env.client, "evm_setAutomine", [false]);
        },
        afterSubmit: async () => {
          await waitFor(
            "freeze in mempool",
            async () => Object.keys(((await rpc(env.client, "txpool_content")) as any).pending ?? {}).some((k) => lower(k) === bot),
            20_000,
          );
          await rpc(env.client, "evm_mine");
        },
      });
      expect(r.freezeFirst).toBe(true);
      expect(r.approveStatus).toBe("reverted");
      expect(r.allowance).toBe("0");
      expect((await env.store.hitsFor(lower(r1.attacker3.address))).map((h) => h.rule)).toContain("R5");
    } finally {
      await rpc(env.client, "evm_setAutomine", [true]);
    }
  });

  it("6: 1b의 공격자 잔고 소각 → 회사 새 지갑에 재발행 → 대조", async () => {
    const fe = (await frozenEvent(env, actors.attacker1b))!;
    const caseId = fe.args.reason as Hex;
    await rpc(env.client, "evm_increaseTime", [toHex(600)]);
    await rpc(env.client, "evm_mine");
    const wipe = await planWipe(env.ops, [actors.attacker1b], caseId);
    expect(wipe.total).toBe(150_000_000_000n);
    await executeLocal(env.ops, wipe.batch);
    const re = await planReissue(env.ops, actors.recovered, wipe.total, caseId);
    if (re.treasury) await executeLocal(env.ops, re.treasury);
    await executeLocal(env.ops, re.minter);
    expect(await reconcileCase(env.ops, caseId)).toMatchObject({consistent: true, balanced: true});
  });

  it("7a: 타임락 경유 관리 작업은 알림 없이 실행된다", async () => {
    const r7Before = env.capture.of("R7").length;
    await executeLocal(env.ops, await demoTimelockPlan(env.ops, r1));
    await expect(demoTimelockExecute(c, env.ops, r1, r1.funder)).rejects.toThrow(/지연/);
    await rpc(env.client, "evm_increaseTime", [toHex(601)]);
    await rpc(env.client, "evm_mine");
    const r = await demoTimelockExecute(c, env.ops, r1, r1.funder);
    expect(r.protectedNow).toBe(true);
    await waitFor("timelock executed", async () => env.capture.of("timelock.CallExecuted").length > 0);
    await sleep(500);
    expect(env.capture.of("R7").length).toBe(r7Before);
  });

  it("5: 탈취된 봇 키의 무차별 동결 → 속도 알림 → 운영 Safe 회수·해제 → 복구", async () => {
    const acct = privateKeyToAccount(BOT_KEY);
    const r = await scenario5StolenBot(c, r1, {address: lower(acct.address), signTransaction: (tx) => acct.signTransaction(tx)});
    expect(r.frozen).toBe(21);
    await waitFor("bot rate alert", async () => env.capture.of("bot.freeze_rate")[0]);
    await executeLocal(env.ops, demoBotIncidentPlan(env.ops, r1));
    for (const x of r1.innocents) expect(await isFrozen(env, x)).toBe(false);
    expect(await botCanStillFreeze(c, env.ops.book.bot, r1.innocents[0])).toBe(false);
    await executeLocal(env.ops, demoBotRestorePlan(env.ops));
    expect(await botCanStillFreeze(c, env.ops.book.bot, r1.innocents[0])).toBe(true);
  });
});
