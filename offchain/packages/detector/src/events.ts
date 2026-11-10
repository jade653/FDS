import {decodeFunctionData, parseEventLogs, type Log} from "viem";
import {proxyAdminAbi, stableTokenAbi, timelockControllerAbi, transparentProxyAbi} from "@stb/abi";
import type {Address, AddressBook, Hex} from "@stb/common";
import {lower} from "@stb/common";

/** 블록 안의 위치. 이벤트 id와 재조직 처리에 쓴다. */
export interface EventPos {
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  txIndex: number;
  /** 로그 인덱스. 로그가 아닌 이벤트(트랜잭션 호출, 코드 변경)는 -1 */
  logIndex: number;
  timestamp: number;
  /** 트랜잭션 발신자 (EOA). Safe를 거친 호출이면 Safe가 아니라 실행한 서명자다 */
  txFrom?: Address;
}

/** 토큰 컨트랙트로 가는 호출을 풀어 쓴 것. R5(approve → 출구), R10(동결 주소 관여)에 쓴다. */
export interface DecodedCall {
  fn: "transfer" | "transferFrom" | "approve" | "permit" | "other";
  /** 잔고나 allowance에 관여하는 주소들 (tx.from 포함) */
  parties: Address[];
  spender?: Address;
}

export type ChainEvent =
  | (EventPos & {kind: "transfer"; from: Address; to: Address; value: bigint})
  | (EventPos & {kind: "approval"; owner: Address; spender: Address; value: bigint})
  | (EventPos & {kind: "frozen"; account: Address; operator: Address; reason: Hex})
  | (EventPos & {kind: "unfrozen"; account: Address; operator: Address})
  | (EventPos & {kind: "mint"; minter: Address; to: Address; amount: bigint})
  | (EventPos & {kind: "wiped"; caseId: Hex; account: Address; amount: bigint})
  | (EventPos & {kind: "reissued"; caseId: Hex; to: Address; amount: bigint})
  | (EventPos & {
      kind: "admin";
      name: string;
      emitter: Address;
      /** 이벤트에 담긴 msg.sender (RoleGranted.sender, Paused.account). 없으면 undefined */
      sender?: Address;
      args: Record<string, unknown>;
    })
  | (EventPos & {kind: "timelock"; name: "CallScheduled" | "CallExecuted"; id: Hex; target: Address; data: Hex})
  | (EventPos & {kind: "tokenCall"; from: Address; call: DecodedCall})
  | (EventPos & {kind: "exitCall"; from: Address; to: Address})
  | (EventPos & {kind: "code"; account: Address; code: Hex});

export interface PendingTxEvent {
  kind: "pending";
  hash: Hex;
  from: Address;
  to: Address;
  input: Hex;
  /** 관찰 시점의 최신 블록 시각. 결정을 재현 가능하게 하려고 벽시계 대신 쓴다. */
  timestamp: number;
  call?: DecodedCall;
}

export type DetectorEvent = ChainEvent | PendingTxEvent;

export function eventId(e: DetectorEvent): string {
  if (e.kind === "pending") return `pending:${e.hash}`;
  if (e.kind === "code") return `code:${e.blockNumber}:${e.account}`;
  return `${e.txHash}:${e.logIndex}`;
}

const TOKEN_ADMIN_EVENTS = new Set([
  "RoleGranted",
  "RoleRevoked",
  "RoleAdminChanged",
  "Upgraded",
  "AdminChanged",
  "MinterConfigured",
  "MinterRemoved",
  "ProtectedSet",
  "Paused",
  "Unpaused",
  "MinFreezeAgeSet",
  "Rescued",
  "Initialized",
]);
const TIMELOCK_ADMIN_EVENTS = new Set(["RoleGranted", "RoleRevoked", "RoleAdminChanged", "MinDelayChange"]);

const tokenEventsAbi = [...stableTokenAbi, ...transparentProxyAbi.filter((x) => x.type === "event")];

export interface BlockMeta {
  number: bigint;
  hash: Hex;
  timestamp: number;
  /** txHash(소문자) → txIndex */
  txIndex: Map<string, number>;
  /** txHash(소문자) → 발신자 */
  txFrom: Map<string, Address>;
}

/** 원시 로그를 이벤트로 바꾼다. 관리 이벤트는 `admin`으로 묶는다. */
export function decodeLogs(logs: Log[], book: AddressBook, meta: BlockMeta): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const log of logs) {
    const emitter = lower(log.address);
    const pos: EventPos = {
      blockNumber: meta.number,
      blockHash: meta.hash,
      txHash: log.transactionHash as Hex,
      txIndex: log.transactionIndex ?? meta.txIndex.get(String(log.transactionHash).toLowerCase()) ?? 0,
      logIndex: log.logIndex ?? 0,
      timestamp: meta.timestamp,
      txFrom: meta.txFrom.get(String(log.transactionHash).toLowerCase()),
    };
    if (emitter === book.token) {
      const [ev] = parseEventLogs({abi: tokenEventsAbi, logs: [log], strict: false});
      if (!ev) continue;
      const a = ev.args as Record<string, any>;
      switch (ev.eventName) {
        case "Transfer":
          out.push({...pos, kind: "transfer", from: lower(a.from), to: lower(a.to), value: a.value});
          break;
        case "Approval":
          out.push({...pos, kind: "approval", owner: lower(a.owner), spender: lower(a.spender), value: a.value});
          break;
        case "Frozen":
          out.push({...pos, kind: "frozen", account: lower(a.account), operator: lower(a.operator), reason: a.reason});
          break;
        case "Unfrozen":
          out.push({...pos, kind: "unfrozen", account: lower(a.account), operator: lower(a.operator)});
          break;
        case "Mint":
          out.push({...pos, kind: "mint", minter: lower(a.minter), to: lower(a.to), amount: a.amount});
          break;
        case "FrozenFundsWiped":
          out.push({...pos, kind: "wiped", caseId: a.caseId, account: lower(a.account), amount: a.amount});
          break;
        case "RecoveryReissued":
          out.push({...pos, kind: "reissued", caseId: a.caseId, to: lower(a.to), amount: a.amount});
          break;
        default:
          if (TOKEN_ADMIN_EVENTS.has(ev.eventName)) {
            out.push({...pos, kind: "admin", name: ev.eventName, emitter, sender: senderOf(ev.eventName, a), args: a});
          }
      }
    } else if (emitter === book.timelock) {
      const [ev] = parseEventLogs({abi: timelockControllerAbi, logs: [log], strict: false});
      if (!ev) continue;
      const a = ev.args as Record<string, any>;
      if (ev.eventName === "CallScheduled" || ev.eventName === "CallExecuted") {
        out.push({...pos, kind: "timelock", name: ev.eventName, id: a.id, target: lower(a.target), data: a.data});
      } else if (TIMELOCK_ADMIN_EVENTS.has(ev.eventName)) {
        out.push({...pos, kind: "admin", name: ev.eventName, emitter, sender: senderOf(ev.eventName, a), args: a});
      }
    } else if (emitter === book.proxyAdmin) {
      const [ev] = parseEventLogs({abi: proxyAdminAbi, logs: [log], strict: false});
      if (ev?.eventName === "OwnershipTransferred") {
        out.push({...pos, kind: "admin", name: ev.eventName, emitter, args: ev.args as Record<string, unknown>});
      }
    }
  }
  return out;
}

function senderOf(name: string, a: Record<string, any>): Address | undefined {
  if (name === "RoleGranted" || name === "RoleRevoked") return lower(a.sender);
  if (name === "Paused" || name === "Unpaused") return lower(a.account);
  return undefined;
}

/** 토큰 호출 calldata를 풀어 관여 주소를 뽑는다. */
export function decodeTokenCall(from: Address, input: Hex): DecodedCall {
  const f = lower(from);
  try {
    const {functionName, args} = decodeFunctionData({abi: stableTokenAbi, data: input});
    const a = (args ?? []) as readonly any[];
    switch (functionName) {
      case "transfer":
        return {fn: "transfer", parties: [f, lower(a[0])]};
      case "transferFrom":
        return {fn: "transferFrom", parties: [f, lower(a[0]), lower(a[1])]};
      case "approve":
        return {fn: "approve", parties: [f, lower(a[0])], spender: lower(a[0])};
      case "permit":
        return {fn: "permit", parties: [f, lower(a[0]), lower(a[1])], spender: lower(a[1])};
      default:
        return {fn: "other", parties: [f]};
    }
  } catch {
    return {fn: "other", parties: [f]};
  }
}
