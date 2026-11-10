// 실제 체인 시연 2부: 시나리오 1·3·5·6·7 (design.md 12장). 1부(1b·2·4)는 demo.ts.
// Safe가 서명해야 하는 단계는 Safe Transaction Builder 배치로 만들고, 서명과 실행은 사람이 Safe 앱에서 한다.
// 같은 함수를 로컬 Anvil E2E 테스트(packages/e2e/test/demo.test.ts)가 그대로 부른다.
import {encodeFunctionData, formatUnits, keccak256, maxUint256, parseEventLogs, toBytes, type Account} from "viem";
import {stableTokenAbi, timelockControllerAbi} from "@stb/abi";
import {lower, TOKEN_DECIMALS, units, type Address, type Hex} from "@stb/common";
import {balanceOf, isFrozen, type DemoActors, type DemoChain} from "./demo";
import {planBotRevoke, planUnfreeze, PreconditionError, type OpsContext, type SafeBatch} from "./ops";

/** 2부 발행량 (토큰 단위). 1: 핫월렛 3개, 3: 피해자 1명. 합계 420,000 STB */
export const DEMO_EXTRA_MINT = {hot: 120_000, hotB: 120_000, hotC: 120_000, victim: 60_000} as const;
/** 2부 금고 Safe가 맞출 minter 한도. 2부 발행 420,000 + 회수 재발행 150,000을 덮는다 */
export const DEMO_EXTRA_ALLOWANCE = 1_000_000;

const FREEZER_ROLE = keccak256(toBytes("FREEZER_ROLE"));
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;

function safeBatch(ctx: OpsContext, safe: Address, name: string, description: string, txs: {to: Address; data: Hex}[]): SafeBatch {
  return {
    version: "1.0",
    chainId: String(ctx.book.chainId),
    createdAt: Date.now(),
    meta: {name, description, txBuilderVersion: "1.16.5", createdFromSafeAddress: safe},
    transactions: txs.map((t) => ({to: t.to, value: "0" as const, data: t.data, contractMethod: null, contractInputsValues: null})),
  };
}

const tokenCall = (ctx: OpsContext, functionName: string, args: unknown[]) => ({
  to: ctx.book.token,
  data: encodeFunctionData({abi: stableTokenAbi, functionName: functionName as any, args: args as any}),
});

// ---------------------------------------------------------------------------
// Safe 배치
// ---------------------------------------------------------------------------

/** 7b: 금고 Safe가 minter 한도를 맞춘다. 금고 Safe는 R7 승인 발신자가 아니므로 감시탑은 최고 등급 알림을 낸다
 *  (docs/decisions.md 4.1의 해석 그대로를 시연한다). */
export function demoAllowancePlan(ctx: OpsContext, allowance = DEMO_EXTRA_ALLOWANCE): SafeBatch {
  const minter = ctx.deployment.minter as Address;
  return safeBatch(ctx, ctx.deployment.treasurySafe as Address, "demo minter allowance", `금고 Safe: minter 한도 ${allowance} STB`, [
    tokenCall(ctx, "configureMinter", [minter, units(allowance)]),
  ]);
}

/** 1·3 준비: 발행 Safe가 핫월렛 3개와 피해자에게 발행한다. 요청 기록 없는 발행이라 R8 알림이 난다 (7). */
export async function demoExtraMintPlan(ctx: OpsContext, a: DemoActors): Promise<SafeBatch> {
  const minter = ctx.deployment.minter as Address;
  const total = units(DEMO_EXTRA_MINT.hot + DEMO_EXTRA_MINT.hotB + DEMO_EXTRA_MINT.hotC + DEMO_EXTRA_MINT.victim);
  const allowance = (await ctx.client.readContract({address: ctx.book.token, abi: stableTokenAbi, functionName: "minterAllowance", args: [minter]})) as bigint;
  if (allowance < total) {
    throw new PreconditionError(`minter allowance ${formatUnits(allowance, TOKEN_DECIMALS)} STB < ${formatUnits(total, TOKEN_DECIMALS)} STB: 금고 Safe 배치(allowance)를 먼저 실행`);
  }
  return safeBatch(ctx, minter, `demo round ${a.round} extra mint`, `시연 ${a.round}회차 2부 발행 (시나리오 1·3)`, [
    tokenCall(ctx, "mint", [a.hot.address, units(DEMO_EXTRA_MINT.hot)]),
    tokenCall(ctx, "mint", [a.hotB.address, units(DEMO_EXTRA_MINT.hotB)]),
    tokenCall(ctx, "mint", [a.hotC.address, units(DEMO_EXTRA_MINT.hotC)]),
    tokenCall(ctx, "mint", [a.victim.address, units(DEMO_EXTRA_MINT.victim)]),
  ]);
}

/** 7a 정상 경로: 거버넌스 Safe가 타임락에 "거래소 주소를 보호 주소로 지정"을 예약한다. 지연 뒤 누구나 실행한다. */
export function demoTimelockCall(ctx: OpsContext, a: DemoActors) {
  const data = encodeFunctionData({abi: stableTokenAbi, functionName: "setProtected", args: [a.exchange, true]});
  const salt = keccak256(toBytes(`demo-r${a.round}-protect-exchange`));
  return {target: ctx.book.token, value: 0n, data, predecessor: ZERO32, salt};
}

export async function demoTimelockPlan(ctx: OpsContext, a: DemoActors): Promise<SafeBatch> {
  const tl = ctx.deployment.timelock as Address;
  const delay = (await ctx.client.readContract({address: tl, abi: timelockControllerAbi, functionName: "getMinDelay"})) as bigint;
  const call = demoTimelockCall(ctx, a);
  return safeBatch(ctx, ctx.deployment.governanceSafe as Address, "demo timelock schedule", `거버넌스 Safe: ${a.exchange}를 보호 주소로 지정 (지연 ${delay}초)`, [
    {
      to: tl,
      data: encodeFunctionData({abi: timelockControllerAbi, functionName: "schedule", args: [call.target, call.value, call.data, call.predecessor, call.salt, delay]}),
    },
  ]);
}

/** 7a: 지연이 지난 예약 작업을 실행한다. executor가 개방(address(0))이라 시연 지갑이 실행해도 된다. */
export async function demoTimelockExecute(c: DemoChain, ctx: OpsContext, a: DemoActors, executor: Account): Promise<{tx: Hex; protectedNow: boolean}> {
  const tl = ctx.deployment.timelock as Address;
  const call = demoTimelockCall(ctx, a);
  const id = (await c.client.readContract({
    address: tl,
    abi: timelockControllerAbi,
    functionName: "hashOperation",
    args: [call.target, call.value, call.data, call.predecessor, call.salt],
  })) as Hex;
  if (!(await c.client.readContract({address: tl, abi: timelockControllerAbi, functionName: "isOperationPending", args: [id]}))) {
    throw new PreconditionError("예약된 작업이 없다: 거버넌스 Safe 배치(timelock-plan)를 먼저 실행 (이미 실행됐을 수도 있다)");
  }
  if (!(await c.client.readContract({address: tl, abi: timelockControllerAbi, functionName: "isOperationReady", args: [id]}))) {
    const ts = (await c.client.readContract({address: tl, abi: timelockControllerAbi, functionName: "getTimestamp", args: [id]})) as bigint;
    throw new PreconditionError(`아직 지연 중: ${new Date(Number(ts) * 1000).toISOString()} 이후 실행 가능`);
  }
  const tx = await c.wallet(executor).writeContract({
    account: executor,
    address: tl,
    abi: timelockControllerAbi,
    functionName: "execute",
    args: [call.target, call.value, call.data, call.predecessor, call.salt],
    chain: null,
  });
  const r = await c.client.waitForTransactionReceipt({hash: tx});
  if (r.status !== "success") throw new Error(`timelock execute reverted: ${tx}`);
  const protectedNow = (await c.client.readContract({address: c.token, abi: stableTokenAbi, functionName: "isProtected", args: [a.exchange]})) as boolean;
  return {tx, protectedNow};
}

/** 5 대응: 운영 Safe가 봇의 FREEZER를 회수하고 잘못 동결된 주소를 해제한다 (한 배치). */
export function demoBotIncidentPlan(ctx: OpsContext, a: DemoActors): SafeBatch {
  const revoke = planBotRevoke(ctx, ctx.book.bot);
  const unfreeze = planUnfreeze(ctx, a.innocents, "봇 키 탈취 시연: 무차별 동결 해제");
  return {
    ...revoke,
    meta: {...revoke.meta, name: "demo bot incident", description: `운영 Safe: 봇 FREEZER 회수 + 무관한 주소 ${a.innocents.length}개 해제`},
    transactions: [...revoke.transactions, ...unfreeze.transactions],
  };
}

/** 5 복구: 시연이 끝나면 운영 Safe가 같은 봇에 FREEZER를 돌려준다. 실제 탈취였다면 새 키로 교체한다 (bot-rotate). */
export function demoBotRestorePlan(ctx: OpsContext): SafeBatch {
  return safeBatch(ctx, ctx.deployment.opsSafe as Address, "demo bot restore", `운영 Safe: 봇 ${ctx.book.bot}에 FREEZER 재부여 (시연 복구)`, [
    tokenCall(ctx, "grantRole", [FREEZER_ROLE, ctx.book.bot]),
  ]);
}

// ---------------------------------------------------------------------------
// 시나리오
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function transferGas(c: DemoChain, from: Account, to: Address, tokens: number): Promise<bigint> {
  const data = encodeFunctionData({abi: stableTokenAbi, functionName: "transfer", args: [to, units(tokens)]});
  return ((await c.client.estimateGas({account: from.address, to: c.token, data})) * 15n) / 10n;
}

async function requireTokens(c: DemoChain, who: Address, minTokens: number, role: string) {
  if (await isFrozen(c, who)) throw new PreconditionError(`${role} ${who} is already frozen: 다음 회차(--round)를 쓴다`);
  const bal = await balanceOf(c, who);
  if (bal < units(minTokens)) throw new PreconditionError(`${role} ${who} has ${formatUnits(bal, TOKEN_DECIMALS)} STB < ${minTokens}: 2부 발행 배치를 먼저 실행`);
  if ((await c.client.getBalance({address: who})) === 0n) throw new PreconditionError(`${role} ${who} has no ETH: demo fund --set extra`);
}

async function frozenAt(c: DemoChain, a: Address): Promise<{block: bigint; tx: Hex; index: number} | undefined> {
  const head = await c.client.getBlockNumber();
  const logs = await c.client.getLogs({address: c.token, fromBlock: head > 5000n ? head - 5000n : 0n, toBlock: head});
  const ev = parseEventLogs({abi: stableTokenAbi, eventName: "Frozen", logs})
    .filter((l) => lower(l.args.account) === lower(a))
    .pop();
  return ev ? {block: ev.blockNumber, tx: ev.transactionHash, index: ev.transactionIndex} : undefined;
}

async function waitFrozen(c: DemoChain, a: Address, what: string) {
  const deadline = Date.now() + c.timeoutMs;
  while (Date.now() < deadline) {
    if (await isFrozen(c, a)) {
      const f = await frozenAt(c, a);
      if (f) return f;
    }
    await sleep(c.pollMs);
  }
  throw new Error(`timeout: ${what} (${a}) not frozen within ${c.timeoutMs / 1000}s`);
}

export interface Result1 {
  outflows: {from: Address; tx: Hex; block: bigint; ok: boolean}[];
  attacker: {freezeTx: Hex; freezeBlock: bigint; blocksAfterFirstOutflow: number};
  hotFrozen: number;
  drainedBeforeFreeze: string;
  attackerBalanceFrozen: string;
}

/** 1 대형 탈취: 핫월렛 3개 → 같은 공격자로 110,000씩 거의 동시에. 기대: R1(핫월렛), R1b·R4(공격자) → 전부 자동 동결. */
export async function scenario1(c: DemoChain, a: DemoActors, amount = 110_000): Promise<Result1> {
  const hots = [a.hot, a.hotB, a.hotC];
  for (const [i, h] of hots.entries()) await requireTokens(c, h.address, amount, `hot${i}`);
  if (await isFrozen(c, a.attacker1)) throw new PreconditionError("attacker1 already frozen: 다음 회차를 쓴다");
  const gas = await transferGas(c, a.hot, a.attacker1, amount);
  const hashes = await Promise.all(
    hots.map((h) =>
      c.wallet(h).writeContract({account: h, address: c.token, abi: stableTokenAbi, functionName: "transfer", args: [a.attacker1, units(amount)], chain: null, gas}),
    ),
  );
  c.log(`  유출 ${hashes.length}건 동시 제출: hot·hotB·hotC → attacker 각 ${amount.toLocaleString()} STB`);
  const receipts = await Promise.all(hashes.map((hash) => c.client.waitForTransactionReceipt({hash, timeout: c.timeoutMs})));
  const outflows = receipts.map((r, i) => ({from: hots[i].address, tx: r.transactionHash, block: r.blockNumber, ok: r.status === "success"}));
  const ok = outflows.filter((o) => o.ok);
  if (!ok.length) throw new Error("all outflows reverted");
  const first = ok.reduce((m, o) => (o.block < m ? o.block : m), ok[0].block);
  const att = await waitFrozen(c, a.attacker1, "attacker");
  let hotFrozen = 0;
  for (const o of ok) {
    await waitFrozen(c, o.from, "hot wallet");
    hotFrozen++;
  }
  return {
    outflows,
    attacker: {freezeTx: att.tx, freezeBlock: att.block, blocksAfterFirstOutflow: Number(att.block - first)},
    hotFrozen,
    drainedBeforeFreeze: (ok.length * amount).toLocaleString(),
    attackerBalanceFrozen: formatUnits(await balanceOf(c, a.attacker1), TOKEN_DECIMALS),
  };
}

export interface Result3 {
  inflowTx: Hex;
  approveTx: Hex;
  approveBlock: bigint;
  approveIndex: number;
  approveStatus: "success" | "reverted";
  freeze: {tx: Hex; block: bigint; index: number};
  /** 동결이 approve보다 먼저 포함됐는가 (같은 블록이면 앞 순번, 아니면 앞 블록) */
  freezeFirst: boolean;
  allowance: string;
}

/** 3 출구 경쟁: 피해자 → 공격자 60,000 (R2·대량 수신) 뒤 공격자가 DEX 라우터에 approve를 낸다.
 *  감시탑이 pending approve를 보고 R5로 동결을 먼저 넣는지 본다 (pending 구독이 되는 RPC일 때만 가능). */
export async function scenario3(c: DemoChain, a: DemoActors, opts: {settleMs?: number; skipInflow?: boolean; beforeApprove?: () => Promise<void>; afterSubmit?: () => Promise<void>} = {}): Promise<Result3> {
  if (await isFrozen(c, a.attacker3.address)) throw new PreconditionError("attacker3 already frozen: 다음 회차를 쓴다");
  if ((await c.client.getBalance({address: a.attacker3.address})) === 0n) throw new PreconditionError("attacker3 has no ETH: demo fund --set extra");
  let inflowTx: Hex = "0x";
  if (opts.skipInflow) {
    // 앞선 실행에서 이미 받았다 (점수 윈도우 30분 안에 다시 시도할 때)
    if ((await balanceOf(c, a.attacker3.address)) < units(60_000)) throw new PreconditionError("attacker3 has < 60,000 STB: --skip-inflow 없이 실행");
  } else {
  await requireTokens(c, a.victim.address, 60_000, "victim");
  inflowTx = await c.wallet(a.victim).writeContract({
    account: a.victim,
    address: c.token,
    abi: stableTokenAbi,
    functionName: "transfer",
    args: [a.attacker3.address, units(60_000)],
    chain: null,
    gas: await transferGas(c, a.victim, a.attacker3.address, 60_000),
  });
  const ir = await c.client.waitForTransactionReceipt({hash: inflowTx});
  if (ir.status !== "success") throw new Error(`inflow reverted: ${inflowTx}`);
  c.log(`  유입: victim → attacker 60,000 STB (block ${ir.blockNumber}). 감시탑이 이 블록을 처리할 때까지 기다린다`);
  await sleep(opts.settleMs ?? 15_000);
  }
  if (await isFrozen(c, a.attacker3.address)) throw new Error("attacker3 was frozen before the approve: R2만으로 동결되면 안 된다 (설정 확인)");

  await opts.beforeApprove?.();
  const approveTx = await c.wallet(a.attacker3).writeContract({
    account: a.attacker3,
    address: c.token,
    abi: stableTokenAbi,
    functionName: "approve",
    args: [a.router, maxUint256],
    chain: null,
    // 체인마다 저장소 접근 비용이 달라 고정값을 쓰지 않는다 (Sepolia에서 100k 고정은 가스 부족으로 실패했다)
    gas: ((await c.client.estimateGas({
      account: a.attacker3.address,
      to: c.token,
      data: encodeFunctionData({abi: stableTokenAbi, functionName: "approve", args: [a.router, maxUint256]}),
    })) * 15n) / 10n,
  });
  c.log(`  출구 접근: attacker → router approve 제출 (${approveTx})`);
  await opts.afterSubmit?.();
  const ar = await c.client.waitForTransactionReceipt({hash: approveTx, timeout: c.timeoutMs});
  const fz = await waitFrozen(c, a.attacker3.address, "attacker");
  const freezeFirst = fz.block < ar.blockNumber || (fz.block === ar.blockNumber && fz.index < ar.transactionIndex);
  const allowance = (await c.client.readContract({address: c.token, abi: stableTokenAbi, functionName: "allowance", args: [a.attacker3.address, a.router]})) as bigint;
  return {
    inflowTx,
    approveTx,
    approveBlock: ar.blockNumber,
    approveIndex: ar.transactionIndex,
    approveStatus: ar.status,
    freeze: {tx: fz.tx, block: fz.block, index: fz.index},
    freezeFirst,
    allowance: allowance === maxUint256 ? "max" : formatUnits(allowance, TOKEN_DECIMALS),
  };
}

/** 서명만 하는 키 (봇 키스토어 또는 테스트 키). 시연에서는 탈취된 봇 키를 흉내 낸다. */
export interface RawSigner {
  address: Address;
  signTransaction(tx: any): Promise<Hex>;
}

export interface Result5 {
  tx: Hex;
  block: bigint;
  frozen: number;
}

/** 5 봇 키 탈취: 공격자가 봇 키로 무관한 주소 21개를 한 번에 동결한다 (시간당 상한 20 초과).
 *  기대: 감시탑의 봇 동결 속도 최고 등급 알림 → 운영 Safe가 FREEZER 회수 + 해제 (demoBotIncidentPlan). */
export async function scenario5StolenBot(c: DemoChain, a: DemoActors, bot: RawSigner): Promise<Result5> {
  for (const x of a.innocents) if (await isFrozen(c, x)) throw new PreconditionError(`${x} already frozen: 다음 회차를 쓴다`);
  const data = encodeFunctionData({abi: stableTokenAbi, functionName: "freezeBatch", args: [a.innocents, keccak256(toBytes(`demo-r${a.round}-stolen-bot`))]});
  const chainId = await c.client.getChainId();
  const nonce = await c.client.getTransactionCount({address: bot.address, blockTag: "pending"});
  const gas = ((await c.client.estimateGas({account: bot.address, to: c.token, data})) * 12n) / 10n;
  const fees = await c.client.estimateFeesPerGas();
  const raw = await bot.signTransaction({type: "eip1559", chainId, nonce, to: c.token, data, gas, value: 0n, ...fees});
  const tx = await c.client.sendRawTransaction({serializedTransaction: raw});
  const r = await c.client.waitForTransactionReceipt({hash: tx, timeout: c.timeoutMs});
  if (r.status !== "success") throw new Error(`stolen-bot freezeBatch reverted: ${tx}`);
  let frozen = 0;
  for (const x of a.innocents) if (await isFrozen(c, x)) frozen++;
  return {tx, block: r.blockNumber, frozen};
}

/** 5 확인: 회수된 봇 키로는 더 이상 동결할 수 없다 (eth_call로 확인, 거래는 보내지 않는다). */
export async function botCanStillFreeze(c: DemoChain, bot: Address, target: Address): Promise<boolean> {
  try {
    await c.client.simulateContract({account: bot, address: c.token, abi: stableTokenAbi, functionName: "freeze", args: [target, ZERO32]});
    return true;
  } catch {
    return false;
  }
}
