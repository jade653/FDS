import {appendFileSync, mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  isHex,
  keccak256,
  parseEventLogs,
  toBytes,
  type PublicClient,
} from "viem";
import {mnemonicToAccount} from "viem/accounts";
import {proxyAdminAbi, stableTokenAbi, timelockControllerAbi} from "@stb/abi";
import type {Address, AddressBook, DeploymentInfo, Hex} from "@stb/common";
import {lower} from "@stb/common";

export interface OpsContext {
  client: PublicClient;
  rpcUrl: string;
  book: AddressBook;
  deployment: DeploymentInfo;
}

/** Safe Transaction Builder 형식. Safe 앱에서 불러와 서명한다. 서명과 제출은 사람이 한다 (design.md 9장). */
export interface SafeBatch {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: {name: string; description: string; txBuilderVersion: string; createdFromSafeAddress: Address};
  transactions: {to: Address; value: "0"; data: Hex; contractMethod: null; contractInputsValues: null}[];
}

export class PreconditionError extends Error {}

/** 사건 번호: 0x + 64자리 hex면 그대로, 아니면 keccak256(사건 문자열) (design.md 9장 1단계). */
export function caseIdOf(s: string): Hex {
  if (isHex(s) && s.length === 66) return lower(s) as Hex;
  return keccak256(toBytes(s));
}

function batch(ctx: OpsContext, safe: Address, name: string, description: string, txs: {to: Address; data: Hex}[]): SafeBatch {
  return {
    version: "1.0",
    chainId: String(ctx.book.chainId),
    createdAt: Date.now(),
    meta: {name, description, txBuilderVersion: "1.16.5", createdFromSafeAddress: safe},
    transactions: txs.map((t) => ({to: t.to, value: "0", data: t.data, contractMethod: null, contractInputsValues: null})),
  };
}

const read = <T>(ctx: OpsContext, functionName: string, args: unknown[] = []) =>
  ctx.client.readContract({address: ctx.book.token, abi: stableTokenAbi, functionName: functionName as any, args: args as any}) as Promise<T>;

// ---------------------------------------------------------------------------
// 사건 조회 (9장 7·8단계)
// ---------------------------------------------------------------------------

export interface CaseStatus {
  caseId: Hex;
  wiped: bigint;
  reissued: bigint;
  remaining: bigint;
  accounts: {address: Address; frozen: boolean; frozenAt: number; balance: bigint; wipeAvailableAt: number | null}[];
}

export async function caseStatus(ctx: OpsContext, caseId: Hex, accounts: Address[] = []): Promise<CaseStatus> {
  const [wiped, reissued, age] = await Promise.all([
    read<bigint>(ctx, "wipedByCase", [caseId]),
    read<bigint>(ctx, "reissuedByCase", [caseId]),
    read<bigint>(ctx, "minFreezeAge"),
  ]);
  const out: CaseStatus["accounts"] = [];
  for (const a of accounts) {
    const [frozenAt, balance] = await Promise.all([read<bigint>(ctx, "frozenAt", [a]), read<bigint>(ctx, "balanceOf", [a])]);
    out.push({
      address: lower(a),
      frozen: frozenAt !== 0n,
      frozenAt: Number(frozenAt),
      balance,
      wipeAvailableAt: frozenAt === 0n ? null : Number(frozenAt + age),
    });
  }
  return {caseId, wiped, reissued, remaining: wiped - reissued, accounts: out};
}

// ---------------------------------------------------------------------------
// 회수 (9장 5·7단계)
// ---------------------------------------------------------------------------

/** 5단계 소각: 회수 Safe가 wipeFrozen(account, caseId). 동결·대기 시간·잔고를 먼저 확인한다. */
export async function planWipe(ctx: OpsContext, accounts: Address[], caseId: Hex): Promise<{batch: SafeBatch; total: bigint}> {
  const block = await ctx.client.getBlock({blockTag: "latest"});
  const st = await caseStatus(ctx, caseId, accounts);
  let total = 0n;
  for (const a of st.accounts) {
    if (!a.frozen) throw new PreconditionError(`${a.address} is not frozen`);
    if (Number(block.timestamp) < a.wipeAvailableAt!) {
      throw new PreconditionError(`${a.address}: minFreezeAge not elapsed (available at ${a.wipeAvailableAt}, now ${block.timestamp})`);
    }
    if (a.balance === 0n) throw new PreconditionError(`${a.address}: nothing to wipe`);
    total += a.balance;
  }
  const txs = st.accounts.map((a) => ({to: ctx.book.token, data: encodeFunctionData({abi: stableTokenAbi, functionName: "wipeFrozen", args: [a.address, caseId]})}));
  return {
    batch: batch(ctx, lower(ctx.deployment.recoverySafe), `wipeFrozen ${caseId.slice(0, 10)}`, `회수 Safe: ${accounts.length}개 주소 소각, 합계 ${total}`, txs),
    total,
  };
}

/**
 * 7단계 재발행: minter가 mintForRecovery(victim, amount, caseId).
 * 남은 재발행 가능액(wiped - reissued)을 넘으면 거부한다 (컨트랙트도 거부한다). minter 한도가 모자라면
 * 금고 Safe의 configureMinter 배치도 같이 만든다(한도는 덮어쓰기라서 현재 한도 + 부족분으로 설정).
 */
export async function planReissue(
  ctx: OpsContext,
  to: Address,
  amount: bigint,
  caseId: Hex,
): Promise<{minter: SafeBatch; treasury?: SafeBatch; remaining: bigint}> {
  if (amount <= 0n) throw new PreconditionError("amount must be positive");
  const st = await caseStatus(ctx, caseId);
  if (st.wiped === 0n) throw new PreconditionError(`case ${caseId} has no wiped amount`);
  if (amount > st.remaining) throw new PreconditionError(`amount ${amount} exceeds remaining reissuable ${st.remaining} (wiped ${st.wiped}, reissued ${st.reissued})`);
  if (await read<boolean>(ctx, "isFrozen", [to])) throw new PreconditionError(`victim ${to} is frozen`);
  const minter = lower(ctx.deployment.minter);
  const allowance = await read<bigint>(ctx, "minterAllowance", [minter]);
  const minterBatch = batch(ctx, minter, `mintForRecovery ${caseId.slice(0, 10)}`, `발행 Safe: ${to}에 ${amount} 재발행 (남은 가능액 ${st.remaining})`, [
    {to: ctx.book.token, data: encodeFunctionData({abi: stableTokenAbi, functionName: "mintForRecovery", args: [to, amount, caseId]})},
  ]);
  let treasury: SafeBatch | undefined;
  if (allowance < amount) {
    treasury = batch(ctx, lower(ctx.deployment.treasurySafe), "configureMinter", `금고 Safe: minter 한도 ${allowance} → ${amount}`, [
      {to: ctx.book.token, data: encodeFunctionData({abi: stableTokenAbi, functionName: "configureMinter", args: [minter, amount]})},
    ]);
  }
  return {minter: minterBatch, treasury, remaining: st.remaining};
}

export interface CaseReconciliation {
  caseId: Hex;
  wiped: bigint;
  reissued: bigint;
  wipedEvents: {account: Address; amount: bigint; tx: Hex}[];
  reissuedEvents: {to: Address; amount: bigint; tx: Hex}[];
  /** 이벤트 합계 = 온체인 누적 */
  consistent: boolean;
  /** 재발행 합계 = 소각 합계 (종결 가능) */
  balanced: boolean;
}

/** 8단계 종결: FrozenFundsWiped와 RecoveryReissued의 caseId·금액을 대조한다. */
export async function reconcileCase(ctx: OpsContext, caseId: Hex): Promise<CaseReconciliation> {
  const logs = await getLogsChunked(ctx, BigInt(ctx.deployment.startBlock), [ctx.book.token]);
  const evs = parseEventLogs({abi: stableTokenAbi, logs, strict: false});
  const wipedEvents = evs
    .filter((e) => e.eventName === "FrozenFundsWiped" && (e.args as any).caseId === caseId)
    .map((e) => ({account: lower((e.args as any).account), amount: (e.args as any).amount as bigint, tx: e.transactionHash!}));
  const reissuedEvents = evs
    .filter((e) => e.eventName === "RecoveryReissued" && (e.args as any).caseId === caseId)
    .map((e) => ({to: lower((e.args as any).to), amount: (e.args as any).amount as bigint, tx: e.transactionHash!}));
  const st = await caseStatus(ctx, caseId);
  const sumW = wipedEvents.reduce((s, e) => s + e.amount, 0n);
  const sumR = reissuedEvents.reduce((s, e) => s + e.amount, 0n);
  return {
    caseId,
    wiped: st.wiped,
    reissued: st.reissued,
    wipedEvents,
    reissuedEvents,
    consistent: sumW === st.wiped && sumR === st.reissued,
    balanced: st.wiped === st.reissued && st.wiped > 0n,
  };
}

/** 6단계 준비금 회계: 오프체인 장부(JSONL)에 남긴다. 테스트 발행 단계에서는 이것만 한다. */
export function recordLedger(path: string, entry: {caseId: Hex; kind: "reserve_released" | "reissued" | "note"; amount?: bigint; note?: string; actor: string}) {
  mkdirSync(dirname(path), {recursive: true});
  appendFileSync(path, JSON.stringify({...entry, amount: entry.amount?.toString(), at: new Date().toISOString()}) + "\n");
}

// ---------------------------------------------------------------------------
// 오탐 해제, 봇 키 교체 (docs/runbooks)
// ---------------------------------------------------------------------------

export function planUnfreeze(ctx: OpsContext, accounts: Address[], why: string): SafeBatch {
  if (accounts.length === 0) throw new PreconditionError("no accounts");
  const txs = accounts.map((a) => ({to: ctx.book.token, data: encodeFunctionData({abi: stableTokenAbi, functionName: "unfreeze", args: [a]})}));
  return batch(ctx, lower(ctx.deployment.opsSafe), `unfreeze ${accounts.length}`, `운영 Safe: 오탐 해제 (${why})`, txs);
}

const FREEZER_ROLE = keccak256(toBytes("FREEZER_ROLE"));

/** 봇 키 탈취 의심: 운영 Safe(GUARDIAN)가 타임락 없이 FREEZER를 회수한다 (design.md 6장). */
export function planBotRevoke(ctx: OpsContext, bot: Address): SafeBatch {
  return batch(ctx, lower(ctx.deployment.opsSafe), "revoke FREEZER", `운영 Safe: 봇 ${bot}의 FREEZER 회수`, [
    {to: ctx.book.token, data: encodeFunctionData({abi: stableTokenAbi, functionName: "revokeRole", args: [FREEZER_ROLE, bot]})},
  ]);
}

/** 봇 키 교체: 새 키에 FREEZER 부여 → 옛 키 회수. 새 키에는 FREEZER 외 아무 권한도 주지 않는다. */
export function planBotRotate(ctx: OpsContext, oldBot: Address, newBot: Address): SafeBatch {
  if (ctx.book.isProtected(newBot)) throw new PreconditionError("new bot must not be a protected address");
  return batch(ctx, lower(ctx.deployment.opsSafe), "rotate bot key", `운영 Safe: FREEZER ${oldBot} → ${newBot}`, [
    {to: ctx.book.token, data: encodeFunctionData({abi: stableTokenAbi, functionName: "grantRole", args: [FREEZER_ROLE, newBot]})},
    {to: ctx.book.token, data: encodeFunctionData({abi: stableTokenAbi, functionName: "revokeRole", args: [FREEZER_ROLE, oldBot]})},
  ]);
}

// ---------------------------------------------------------------------------
// 역할 전수 검사 (이벤트로 보유자를 열거)
// ---------------------------------------------------------------------------

const TOKEN_ROLES = ["DEFAULT_ADMIN", "GUARDIAN", "FREEZER", "UNFREEZER", "PAUSER", "WIPER", "MASTER_MINTER", "MINTER", "RESCUER"] as const;
const roleHash = (n: string) => (n === "DEFAULT_ADMIN" ? (("0x" + "00".repeat(32)) as Hex) : keccak256(toBytes(`${n}_ROLE`)));

export interface RoleReport {
  token: Record<string, Address[]>;
  timelock: Record<string, Address[]>;
  proxyAdminOwner: Address;
  problems: string[];
}

/**
 * RoleGranted/RoleRevoked를 시작 블록부터 훑어 현재 보유자를 전부 찾고 6장 표와 대조한다.
 * Solidity 검증(DeploymentChecks)은 알려진 주체만 보므로, 모르는 주소가 역할을 가진 경우는 여기서 잡는다.
 */
export async function verifyRoles(ctx: OpsContext, opts: {bot?: Address; extraMinters?: Address[]} = {}): Promise<RoleReport> {
  const d = ctx.deployment;
  const logs = await getLogsChunked(ctx, BigInt(d.startBlock), [ctx.book.token, ctx.book.timelock]);
  const fold = (emitter: Address, abi: any) => {
    const m = new Map<Hex, Set<Address>>();
    const parsed = parseEventLogs({abi, logs: logs.filter((l) => lower(l.address) === emitter), strict: false}) as unknown as {
      eventName: string;
      args: Record<string, unknown>;
    }[];
    for (const e of parsed) {
      if (e.eventName !== "RoleGranted" && e.eventName !== "RoleRevoked") continue;
      const {role, account} = e.args as any;
      if (!m.has(role)) m.set(role, new Set());
      if (e.eventName === "RoleGranted") m.get(role)!.add(lower(account));
      else m.get(role)!.delete(lower(account));
    }
    return m;
  };
  const tokenRoles = fold(ctx.book.token, stableTokenAbi);
  const tlRoles = fold(ctx.book.timelock, timelockControllerAbi);

  const bot = lower(opts.bot ?? ctx.book.bot);
  const expected: Record<string, Address[]> = {
    DEFAULT_ADMIN: [d.timelock],
    GUARDIAN: [d.opsSafe],
    FREEZER: [d.opsSafe, bot],
    UNFREEZER: [d.opsSafe],
    PAUSER: [d.opsSafe],
    WIPER: [d.recoverySafe],
    MASTER_MINTER: [d.treasurySafe],
    MINTER: [d.minter, ...(opts.extraMinters ?? [])],
    RESCUER: [d.opsSafe],
  };
  const problems: string[] = [];
  const token: Record<string, Address[]> = {};
  for (const n of TOKEN_ROLES) {
    const holders = [...(tokenRoles.get(roleHash(n)) ?? [])].sort();
    token[n] = holders;
    const want = new Set(expected[n].map(lower));
    for (const h of holders) if (!want.has(h)) problems.push(`token ${n}: unexpected holder ${ctx.book.label(h)}`);
    for (const w of want) if (!holders.includes(w)) problems.push(`token ${n}: missing ${ctx.book.label(w)}`);
    // 이벤트 폴딩 결과를 hasRole로 다시 확인
    for (const h of holders) {
      if (!(await read<boolean>(ctx, "hasRole", [roleHash(n), h]))) problems.push(`token ${n}: event/hasRole mismatch for ${h}`);
    }
  }

  const tlNames: Record<string, Hex> = {
    DEFAULT_ADMIN: ("0x" + "00".repeat(32)) as Hex,
    PROPOSER: keccak256(toBytes("PROPOSER_ROLE")),
    CANCELLER: keccak256(toBytes("CANCELLER_ROLE")),
    EXECUTOR: keccak256(toBytes("EXECUTOR_ROLE")),
  };
  const tlExpected: Record<string, Address[]> = {
    DEFAULT_ADMIN: [d.timelock],
    PROPOSER: [d.governanceSafe],
    CANCELLER: [d.governanceSafe],
    EXECUTOR: ["0x0000000000000000000000000000000000000000"],
  };
  const timelock: Record<string, Address[]> = {};
  for (const [n, h] of Object.entries(tlNames)) {
    const holders = [...(tlRoles.get(h) ?? [])].sort();
    timelock[n] = holders;
    const want = new Set(tlExpected[n].map(lower));
    for (const x of holders) if (!want.has(x)) problems.push(`timelock ${n}: unexpected holder ${ctx.book.label(x)}`);
    for (const w of want) if (!holders.includes(w)) problems.push(`timelock ${n}: missing ${w}`);
  }

  const proxyAdminOwner = lower(
    (await ctx.client.readContract({address: ctx.book.proxyAdmin, abi: proxyAdminAbi, functionName: "owner"})) as Address,
  );
  if (proxyAdminOwner !== lower(d.timelock)) problems.push(`ProxyAdmin owner is ${proxyAdminOwner}, not the timelock`);
  for (const [n, hs] of Object.entries(token)) if (hs.includes(lower(d.deployer))) problems.push(`deployer holds token ${n}`);
  return {token, timelock, proxyAdminOwner, problems};
}

async function getLogsChunked(ctx: OpsContext, from: bigint, address: Address[], step = 10_000n) {
  const head = await ctx.client.getBlockNumber({cacheTime: 0});
  const out = [];
  for (let b = from; b <= head; b += step) {
    const to = b + step - 1n > head ? head : b + step - 1n;
    out.push(...(await ctx.client.getLogs({address, fromBlock: b, toBlock: to})));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 로컬 Anvil 전용 실행
// ---------------------------------------------------------------------------

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * Safe 배치를 로컬 Anvil에서 그 Safe 자리의 Anvil 기본 계정으로 실행한다 (Anvil에는 Safe가 없다).
 * chainId 31337이 아니면 거부한다. 실제 체인에서는 Safe 앱에서 사람이 서명한다.
 */
export async function executeLocal(ctx: OpsContext, b: SafeBatch): Promise<Hex[]> {
  const chainId = await ctx.client.getChainId();
  if (chainId !== 31337) throw new Error(`executeLocal is for local anvil only (chain ${chainId})`);
  const safe = lower(b.meta.createdFromSafeAddress);
  let account;
  for (let i = 0; i < 20; i++) {
    const a = mnemonicToAccount(ANVIL_MNEMONIC, {addressIndex: i});
    if (lower(a.address) === safe) account = a;
  }
  if (!account) throw new Error(`${safe} is not an anvil default account`);
  const wallet = createWalletClient({account, transport: http(ctx.rpcUrl)});
  const hashes: Hex[] = [];
  for (const tx of b.transactions) {
    const hash = await wallet.sendTransaction({to: tx.to, data: tx.data, chain: null});
    const r = await ctx.client.waitForTransactionReceipt({hash});
    if (r.status !== "success") throw new Error(`tx reverted: ${hash}`);
    hashes.push(hash);
  }
  return hashes;
}
