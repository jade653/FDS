import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createWalletClient, http, type Account} from "viem";
import {lower} from "@stb/common";
import {
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
import {Anvil, deploy, isFrozen, MNEMONIC, sleep, startWatchtower, waitFor, type Env} from "./harness";

// Sepolia 시연 스크립트(packages/ops-cli/src/demo.ts)를 로컬 Anvil에서 그대로 돌린다.
// 실제 체인과 다른 점: 발행 Safe 대신 Anvil 계정이 발행 배치를 실행하고(executeLocal), 니모닉이 Anvil 기본 니모닉이다.

const anvil = new Anvil(8646);
const actors = demoActors(MNEMONIC, 0);
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
