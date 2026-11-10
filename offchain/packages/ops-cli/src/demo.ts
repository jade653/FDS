// 실제 체인(Sepolia) 시연 시나리오 (design.md 12장 1b·2·4, 13장 6단계).
// 감시탑은 별도 프로세스(packages/service)로 돌고, 이 모듈은 공격자·사용자 역할로 거래를 보낸 뒤
// 체인에서 동결 여부와 걸린 블록 수를 잰다. 같은 함수를 로컬 Anvil E2E 테스트가 그대로 부른다.
//
// 시연 지갑은 DEMO_MNEMONIC(.env, gitignore)에서 파생한다. 테스트넷 전용 키이며 저장소에 넣지 않는다.
import {
  encodeFunctionData,
  formatEther,
  formatUnits,
  parseEther,
  parseEventLogs,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import {mnemonicToAccount} from "viem/accounts";
import {stableTokenAbi} from "@stb/abi";
import {lower, TOKEN_DECIMALS, units, type Address, type Hex} from "@stb/common";
import {PreconditionError, type OpsContext, type SafeBatch} from "./ops";

// ---------------------------------------------------------------------------
// 시연 지갑
// ---------------------------------------------------------------------------

/** 회차(round)마다 지갑을 새로 쓴다. 한 번 동결된 지갑은 해제 전까지 다시 못 쓰기 때문이다. */
export const DEMO_ROUNDS = 3;
const LAUNDER_COUNT = 20;

export interface DemoActors {
  round: number;
  /** 가스 배분용. 토큰은 받지 않는다. 모든 회차가 같이 쓴다 */
  funder: Account;
  /** 자사 핫월렛 (hot). 1b에서 탈취된다 */
  hot: Account;
  /** 일반 사용자. 2에서 공격자에게 송금한다 (공격자가 사용자 지갑을 털었다고 가정) */
  victim: Account;
  /** 파트너 지갑 (watched). 4에서 거래소로 대량 송금한다 */
  partner: Account;
  /** 거래소 입금 주소 (whitelabel). 받기만 한다 */
  exchange: Address;
  /** 1b 공격자. 받기만 한다 */
  attacker1b: Address;
  /** 2 공격자. 받은 돈을 20개 신규 주소로 나눠 보낸다 */
  attacker2: Account;
  launder: Address[];
}

export function demoActors(mnemonic: string, round: number): DemoActors {
  if (!Number.isInteger(round) || round < 0 || round >= DEMO_ROUNDS) throw new Error(`round must be 0..${DEMO_ROUNDS - 1}`);
  const at = (i: number) => mnemonicToAccount(mnemonic, {addressIndex: i});
  const base = 100 * (round + 1);
  return {
    round,
    funder: at(0),
    hot: at(base + 1),
    victim: at(base + 2),
    partner: at(base + 3),
    exchange: at(base + 4).address,
    attacker1b: at(base + 10).address,
    attacker2: at(base + 11),
    launder: Array.from({length: LAUNDER_COUNT}, (_, i) => at(base + 20 + i).address),
  };
}

/** 회차별 발행량 (토큰 단위). 합계 700,000 STB. minter 한도(1,000,000) 안에서 한 회차씩 발행한다 */
export const DEMO_MINT = {hot: 300_000, victim: 200_000, partner: 200_000} as const;
/** 회차별 가스 배분 (ETH). 2의 공격자는 송금 21건을 낸다 */
export const DEMO_GAS = {hot: "0.005", victim: "0.005", partner: "0.005", attacker2: "0.02"} as const;

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

/** KEY가 없거나 비어 있을 때만 값을 넣는다. 이미 있는 값은 건드리지 않는다. 바꿨으면 true. */
export function setEnvIfEmpty(lines: string[], key: string, value: string): boolean {
  const i = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (i >= 0) {
    if (lines[i].split("=").slice(1).join("=").trim() !== "") return false;
    lines[i] = `${key}=${value}`;
    return true;
  }
  if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, `${key}=${value}`);
  else lines.push(`${key}=${value}`);
  return true;
}

// ---------------------------------------------------------------------------
// 주소 분류 (config/addresses.<chain>.yaml)
// ---------------------------------------------------------------------------

/** 감시탑이 읽는 주소 분류 파일. 모든 회차의 시연 지갑을 넣는다 (감시탑은 이 파일을 재시작 없이 다시 읽는다). */
export function demoAddressesYaml(opts: {chainId: number; deployment: string; mnemonic: string; bot?: Address}): string {
  const all = Array.from({length: DEMO_ROUNDS}, (_, r) => demoActors(opts.mnemonic, r));
  const list = (xs: {address: Address; label: string}[]) =>
    xs.length ? "\n" + xs.map((x) => `  - address: "${x.address}"\n    label: "${x.label}"`).join("\n") : " []";
  return [
    "# 시연용 주소 분류. `demo init`이 DEMO_MNEMONIC에서 만든다. 손으로 고치면 다음 init에서 덮어쓴다.",
    "# hot은 R1·R6 발동 시 점수와 무관하게 자동 동결, whitelabel은 자동 동결하지 않는다 (design.md 8.1).",
    "",
    `chain_id: ${opts.chainId}`,
    `deployment: ${JSON.stringify(opts.deployment)}`,
    ...(opts.bot ? [`bot: "${opts.bot}"`] : []),
    `hot:${list(all.map((a) => ({address: a.hot.address, label: `demo-hot-r${a.round}`})))}`,
    `watched:${list(all.map((a) => ({address: a.partner.address, label: `demo-partner-r${a.round}`})))}`,
    "protected: []",
    `whitelabel:${list(all.map((a) => ({address: a.exchange, label: `demo-exchange-r${a.round}`})))}`,
    "exits: []",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 준비: 발행(Safe)과 가스 배분
// ---------------------------------------------------------------------------

/** 발행 Safe가 실행할 Safe Transaction Builder 배치. 서명과 실행은 사람이 Safe 앱에서 한다. */
export async function demoMintPlan(ctx: OpsContext, a: DemoActors): Promise<SafeBatch> {
  const minter = ctx.deployment.minter as Address;
  const total = units(DEMO_MINT.hot + DEMO_MINT.victim + DEMO_MINT.partner);
  const allowance = (await ctx.client.readContract({
    address: ctx.book.token,
    abi: stableTokenAbi,
    functionName: "minterAllowance",
    args: [minter],
  })) as bigint;
  if (allowance < total) {
    throw new PreconditionError(
      `minter allowance ${formatUnits(allowance, TOKEN_DECIMALS)} STB < ${formatUnits(total, TOKEN_DECIMALS)} STB: 금고 Safe가 configureMinter로 한도를 올려야 한다`,
    );
  }
  const mint = (to: Address, n: number) => ({
    to: ctx.book.token,
    data: encodeFunctionData({abi: stableTokenAbi, functionName: "mint", args: [to, units(n)]}),
  });
  return {
    version: "1.0",
    chainId: String(ctx.book.chainId),
    createdAt: Date.now(),
    meta: {
      name: `demo round ${a.round} mint`,
      description: `시연 ${a.round}회차 발행: hot ${DEMO_MINT.hot}, victim ${DEMO_MINT.victim}, partner ${DEMO_MINT.partner} STB`,
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: minter,
    },
    transactions: [mint(a.hot.address, DEMO_MINT.hot), mint(a.victim.address, DEMO_MINT.victim), mint(a.partner.address, DEMO_MINT.partner)].map(
      (t) => ({to: t.to, value: "0" as const, data: t.data, contractMethod: null, contractInputsValues: null}),
    ),
  };
}

export interface DemoChain {
  client: PublicClient;
  wallet(account: Account): WalletClient;
  token: Address;
  /** 체인 블록 간격에 맞춘 대기 한도 */
  timeoutMs: number;
  pollMs: number;
  log(line: string): void;
}

/** funder → 회차 지갑 가스 배분. 이미 목표 이상이면 건너뛴다. */
export async function demoFund(c: DemoChain, a: DemoActors): Promise<Hex[]> {
  const targets: [Address, string][] = [
    [a.hot.address, DEMO_GAS.hot],
    [a.victim.address, DEMO_GAS.victim],
    [a.partner.address, DEMO_GAS.partner],
    [a.attacker2.address, DEMO_GAS.attacker2],
  ];
  const w = c.wallet(a.funder);
  const hashes: Hex[] = [];
  for (const [to, eth] of targets) {
    const want = parseEther(eth);
    const have = await c.client.getBalance({address: to});
    if (have >= want / 2n) {
      c.log(`  skip ${to}: already ${formatEther(have)} ETH`);
      continue;
    }
    const hash = await w.sendTransaction({account: a.funder, to, value: want - have, chain: null});
    await c.client.waitForTransactionReceipt({hash});
    c.log(`  sent ${formatEther(want - have)} ETH → ${to} (${hash})`);
    hashes.push(hash);
  }
  return hashes;
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

const tokenRead = <T>(c: DemoChain, functionName: string, args: unknown[]) =>
  c.client.readContract({address: c.token, abi: stableTokenAbi, functionName: functionName as any, args: args as any}) as Promise<T>;

export const isFrozen = (c: DemoChain, a: Address) => tokenRead<boolean>(c, "isFrozen", [a]);
export const balanceOf = (c: DemoChain, a: Address) => tokenRead<bigint>(c, "balanceOf", [a]);

export async function demoStatus(c: DemoChain, a: DemoActors) {
  const rows: {role: string; address: Address; eth: string; stb: string; frozen: boolean}[] = [];
  const roles: [string, Address][] = [
    ["funder", a.funder.address],
    ["hot", a.hot.address],
    ["victim", a.victim.address],
    ["partner", a.partner.address],
    ["exchange", a.exchange],
    ["attacker1b", a.attacker1b],
    ["attacker2", a.attacker2.address],
  ];
  for (const [role, address] of roles) {
    rows.push({
      role,
      address,
      eth: formatEther(await c.client.getBalance({address})),
      stb: formatUnits(await balanceOf(c, address), TOKEN_DECIMALS),
      frozen: await isFrozen(c, address),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 시나리오
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFrozen(c: DemoChain, a: Address, what: string): Promise<{block: bigint; tx: Hex}> {
  const deadline = Date.now() + c.timeoutMs;
  while (Date.now() < deadline) {
    if (await isFrozen(c, a)) {
      const ev = await frozenEventOf(c, a);
      if (ev) return ev;
    }
    await sleep(c.pollMs);
  }
  throw new Error(`timeout: ${what} (${a}) not frozen within ${c.timeoutMs / 1000}s. 감시탑이 auto 모드로 돌고 있는지, 봇에 가스가 있는지 확인`);
}

/** 가장 최근 Frozen 이벤트. 시연 회차마다 새 주소를 쓰므로 하나뿐이다. */
async function frozenEventOf(c: DemoChain, a: Address): Promise<{block: bigint; tx: Hex} | undefined> {
  const head = await c.client.getBlockNumber();
  const from = head > 5000n ? head - 5000n : 0n;
  const logs = await c.client.getLogs({address: c.token, fromBlock: from, toBlock: head});
  const ev = parseEventLogs({abi: stableTokenAbi, eventName: "Frozen", logs})
    .filter((l) => lower(l.args.account) === lower(a))
    .pop();
  return ev ? {block: ev.blockNumber, tx: ev.transactionHash} : undefined;
}

/** 송금 가스 추정 (×1.5). 체인마다 저장소 접근 비용이 달라 고정값을 쓰지 않는다 (Sepolia 첫 수신은 약 155k). */
async function transferGas(c: DemoChain, from: Account, to: Address, tokens: number): Promise<bigint> {
  const data = encodeFunctionData({abi: stableTokenAbi, functionName: "transfer", args: [to, units(tokens)]});
  return ((await c.client.estimateGas({account: from.address, to: c.token, data})) * 15n) / 10n;
}

/** gas를 주지 않으면 추정한다. 분산 송금처럼 앞선 거래 결과를 기다리지 않고 연달아 낼 때는 미리 추정한 값을 넘긴다. */
async function send(c: DemoChain, from: Account, to: Address, tokens: number, nonce?: number, gas?: bigint): Promise<Hex> {
  return c.wallet(from).writeContract({
    account: from,
    address: c.token,
    abi: stableTokenAbi,
    functionName: "transfer",
    args: [to, units(tokens)],
    chain: null,
    gas: gas ?? (await transferGas(c, from, to, tokens)),
    nonce,
  });
}

async function requireReady(c: DemoChain, who: Address, minTokens: number, role: string) {
  if (await isFrozen(c, who)) throw new PreconditionError(`${role} ${who} is already frozen: 다음 회차(--round)를 쓰거나 운영 Safe로 해제`);
  const bal = await balanceOf(c, who);
  if (bal < units(minTokens)) {
    throw new PreconditionError(`${role} ${who} has ${formatUnits(bal, TOKEN_DECIMALS)} STB < ${minTokens}: 발행 Safe 배치(demo mint-plan)를 먼저 실행`);
  }
  const eth = await c.client.getBalance({address: who});
  if (eth === 0n) throw new PreconditionError(`${role} ${who} has no ETH for gas: demo fund를 먼저 실행`);
}

export interface Result1b {
  outflowTx: Hex;
  outflowBlock: bigint;
  attacker: {freezeTx: Hex; freezeBlock: bigint; blocksAfterOutflow: number};
  hot: {freezeTx: Hex; freezeBlock: bigint; blocksAfterOutflow: number};
  secondsToBothFrozen: number;
  attackerBalance: string;
}

/** 1b 단일 핫월렛 탈취: 핫월렛 → 신규 주소 150,000 STB. 기대: R1(핫월렛), R1b·R2(공격자) → 둘 다 자동 동결. */
export async function scenario1b(c: DemoChain, a: DemoActors): Promise<Result1b> {
  await requireReady(c, a.hot.address, 150_000, "hot");
  if (await isFrozen(c, a.attacker1b)) throw new PreconditionError("attacker1b already frozen: 다음 회차를 쓴다");
  const t0 = Date.now();
  const outflowTx = await send(c, a.hot, a.attacker1b, 150_000);
  const r = await c.client.waitForTransactionReceipt({hash: outflowTx});
  if (r.status !== "success") throw new Error(`outflow reverted: ${outflowTx}`);
  c.log(`  유출: hot → attacker 150,000 STB (block ${r.blockNumber}, ${outflowTx})`);
  const att = await waitFrozen(c, a.attacker1b, "attacker");
  const hot = await waitFrozen(c, a.hot.address, "hot wallet");
  return {
    outflowTx,
    outflowBlock: r.blockNumber,
    attacker: {freezeTx: att.tx, freezeBlock: att.block, blocksAfterOutflow: Number(att.block - r.blockNumber)},
    hot: {freezeTx: hot.tx, freezeBlock: hot.block, blocksAfterOutflow: Number(hot.block - r.blockNumber)},
    secondsToBothFrozen: Math.round((Date.now() - t0) / 1000),
    attackerBalance: formatUnits(await balanceOf(c, a.attacker1b), TOKEN_DECIMALS),
  };
}

export interface Result2 {
  stealTx: Hex;
  attacker: {freezeTx: Hex; freezeBlock: bigint; blocksAfterFirstSplit: number};
  splits: {sent: number; succeeded: number; reverted: number};
  stillWithAttacker: string;
  launderedOut: string;
}

/** 2 세탁 시도: 사용자 → 공격자 100,000 (R2), 공격자 → 신규 주소 20개에 5,000씩 (R3). 기대: 공격자 자동 동결,
 *  남은 분할 송금은 실패, 받은 주소들은 감시탑 콘솔의 원클릭 승인 링크로 사람이 동결. */
export async function scenario2(c: DemoChain, a: DemoActors): Promise<Result2> {
  await requireReady(c, a.victim.address, 100_000, "victim");
  if (await isFrozen(c, a.attacker2.address)) throw new PreconditionError("attacker2 already frozen: 다음 회차를 쓴다");
  if ((await c.client.getBalance({address: a.attacker2.address})) === 0n) throw new PreconditionError("attacker2 has no ETH: demo fund");
  const stealTx = await send(c, a.victim, a.attacker2.address, 100_000);
  const sr = await c.client.waitForTransactionReceipt({hash: stealTx});
  if (sr.status !== "success") throw new Error(`steal reverted: ${stealTx}`);
  c.log(`  탈취: victim → attacker 100,000 STB (block ${sr.blockNumber})`);

  const base = await c.client.getTransactionCount({address: a.attacker2.address, blockTag: "pending"});
  // 동결 뒤에는 추정이 실패하므로, 받는 주소가 모두 신규라 비용이 같은 점을 이용해 한 번만 추정한다.
  const gas = await transferGas(c, a.attacker2, a.launder[0], 5_000);
  const hashes: Hex[] = [];
  for (const [i, to] of a.launder.entries()) hashes.push(await send(c, a.attacker2, to, 5_000, base + i, gas));
  c.log(`  분산 송금 ${hashes.length}건 제출`);
  const receipts = await Promise.all(hashes.map((hash) => c.client.waitForTransactionReceipt({hash, timeout: c.timeoutMs})));
  const ok = receipts.filter((x) => x.status === "success");
  const first = receipts.reduce((m, x) => (x.blockNumber < m ? x.blockNumber : m), receipts[0].blockNumber);
  const att = await waitFrozen(c, a.attacker2.address, "attacker");
  let out = 0n;
  for (const l of a.launder) out += await balanceOf(c, l);
  return {
    stealTx,
    attacker: {freezeTx: att.tx, freezeBlock: att.block, blocksAfterFirstSplit: Number(att.block - first)},
    splits: {sent: hashes.length, succeeded: ok.length, reverted: receipts.length - ok.length},
    stillWithAttacker: formatUnits(await balanceOf(c, a.attacker2.address), TOKEN_DECIMALS),
    launderedOut: formatUnits(out, TOKEN_DECIMALS),
  };
}

export interface Result4 {
  tx: Hex;
  block: bigint;
  waitedBlocks: number;
  partnerFrozen: boolean;
  exchangeFrozen: boolean;
}

/** 4 오탐 방지: 파트너(watched) → 거래소(whitelabel) 150,000. 기대: R1으로 사람 확인 알림만, 자동 동결 없음. */
export async function scenario4(c: DemoChain, a: DemoActors, waitBlocks = 3): Promise<Result4> {
  await requireReady(c, a.partner.address, 150_000, "partner");
  const tx = await send(c, a.partner, a.exchange, 150_000);
  const r = await c.client.waitForTransactionReceipt({hash: tx});
  if (r.status !== "success") throw new Error(`transfer reverted: ${tx}`);
  c.log(`  송금: partner → exchange 150,000 STB (block ${r.blockNumber}). ${waitBlocks}블록 동안 동결되지 않는지 본다`);
  const deadline = Date.now() + c.timeoutMs;
  while ((await c.client.getBlockNumber()) < r.blockNumber + BigInt(waitBlocks)) {
    if (Date.now() > deadline) break;
    await sleep(c.pollMs);
  }
  const head = await c.client.getBlockNumber();
  return {
    tx,
    block: r.blockNumber,
    waitedBlocks: Number(head - r.blockNumber),
    partnerFrozen: await isFrozen(c, a.partner.address),
    exchangeFrozen: await isFrozen(c, a.exchange),
  };
}
