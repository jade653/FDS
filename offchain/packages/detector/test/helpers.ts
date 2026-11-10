import {resolve} from "node:path";
import {keccak256, toHex} from "viem";
import {
  AddressBook,
  ConfigStore,
  loadRulesFile,
  units,
  type Address,
  type Alert,
  type FreezeRequest,
  type Hex,
  type RulesConfig,
  type RuntimeConfig,
} from "@stb/common";
import type {ChainReader} from "../src/chain";
import {Detector} from "../src/detector";
import type {ChainEvent} from "../src/events";
import {MemoryStore, MemoryWindowStore} from "../src/stores/memory";

export const REPO = resolve(__dirname, "../../../..");

export function loadRules(): RulesConfig {
  return loadRulesFile(resolve(REPO, "config/rules.yaml"));
}

export const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

export const D = {
  token: A(0x7070),
  timelock: A(0x7171),
  proxyAdmin: A(0x7272),
  deployer: A(0xd0),
  governanceSafe: A(0x61),
  opsSafe: A(0x62),
  recoverySafe: A(0x63),
  treasurySafe: A(0x64),
  minter: A(0x65),
  bot: A(0xb0),
};

export interface BookOpts {
  hot?: Address[];
  watched?: Address[];
  whitelabel?: Address[];
  exits?: Address[];
  protected?: Address[];
}

export function makeConfig(opts: BookOpts = {}, rules = loadRules(), risk: Address[] = []): RuntimeConfig {
  const e = (xs: Address[] = []) => xs.map((address, i) => ({address, label: `x${i}`}));
  const book = new AddressBook(
    {
      chain_id: 31337,
      deployment: "x",
      hot: e(opts.hot),
      watched: e(opts.watched),
      whitelabel: e(opts.whitelabel),
      exits: e(opts.exits),
      protected: e(opts.protected),
    },
    {
      chainId: 31337,
      startBlock: 0,
      ...D,
      implementation: A(0x7373),
      protected: [D.timelock, D.token, D.governanceSafe, D.opsSafe, D.recoverySafe, D.treasurySafe, D.minter],
      minFreezeAge: 600,
      timelockDelay: 600,
    },
  );
  return {rules, book, riskList: new Set(risk), loadedAt: 0};
}

export class FakeChain implements ChainReader {
  balances = new Map<Address, bigint>();
  nonces = new Map<Address, number>();
  /** `${address}@${block}` → 그 블록 시점 nonce. 없으면 nonces(최신)를 쓴다 */
  noncesAt = new Map<string, number>();
  code = new Map<Address, Hex>();
  frozen = new Set<Address>();
  async getTransactionCount(a: Address, blockNumber?: bigint) {
    if (blockNumber !== undefined) {
      const at = this.noncesAt.get(`${a.toLowerCase()}@${blockNumber}`);
      if (at !== undefined) return at;
    }
    return this.nonces.get(a) ?? 0;
  }
  async balanceOf(a: Address) {
    return this.balances.get(a) ?? 0n;
  }
  async getCode(a: Address) {
    return this.code.get(a) ?? "0x";
  }
  async isFrozen(a: Address) {
    return this.frozen.has(a);
  }
}

export class Sinks {
  freezes: FreezeRequest[] = [];
  alerts: Alert[] = [];
  freezer = {requestFreeze: async (r: FreezeRequest) => void this.freezes.push(r)};
  alertSink = {alert: async (a: Alert) => void this.alerts.push(a)};
  approvals = {issue: (c: Hex, a: Address) => `approve:${c}:${a}`};
  frozenAddrs(): Address[] {
    return this.freezes.flatMap((f) => f.addresses);
  }
  alertsOf(kind: string): Alert[] {
    return this.alerts.filter((a) => a.kind === kind);
  }
}

export function makeDetector(cfg: RuntimeConfig, chain = new FakeChain()) {
  const store = new MemoryStore();
  const window = new MemoryWindowStore();
  const sinks = new Sinks();
  const config = new ConfigStore(cfg);
  const detector = new Detector({
    config,
    store,
    window,
    chain,
    freezer: sinks.freezer,
    alerts: sinks.alertSink,
    approvals: sinks.approvals,
  });
  return {detector, store, window, sinks, chain, config};
}

/** 블록 이벤트 빌더 */
export class Blocks {
  block = 100n;
  ts = 1_700_000_000;
  private log = 0;
  private tx = 0;

  next(seconds = 12) {
    this.block += 1n;
    this.ts += seconds;
    this.log = 0;
    this.tx = 0;
  }

  private pos(): {blockNumber: bigint; blockHash: Hex; txHash: Hex; txIndex: number; logIndex: number; timestamp: number} {
    const txIndex = this.tx++;
    return {
      blockNumber: this.block,
      blockHash: keccak256(toHex(`b${this.block}`)),
      txHash: keccak256(toHex(`t${this.block}:${txIndex}`)),
      txIndex,
      logIndex: this.log++,
      timestamp: this.ts,
    };
  }

  transfer(from: Address, to: Address, tokens: number): ChainEvent {
    return {...this.pos(), kind: "transfer", from, to, value: units(tokens)};
  }
  approval(owner: Address, spender: Address, tokens: number): ChainEvent {
    return {...this.pos(), kind: "approval", owner, spender, value: units(tokens)};
  }
  frozen(account: Address, operator: Address, reason: Hex = keccak256(toHex("r"))): ChainEvent {
    return {...this.pos(), kind: "frozen", account, operator, reason};
  }
  mint(minter: Address, to: Address, tokens: number): ChainEvent {
    return {...this.pos(), kind: "mint", minter, to, amount: units(tokens)};
  }
  admin(name: string, args: Record<string, unknown>, sender?: Address, txFrom?: Address, emitter: Address = D.token): ChainEvent {
    return {...this.pos(), kind: "admin", name, emitter, sender, args, txFrom};
  }
  timelockExecuted(target: Address): ChainEvent {
    return {...this.pos(), kind: "timelock", name: "CallExecuted", id: keccak256(toHex("op")), target, data: "0x"};
  }
  /** 같은 트랜잭션 안의 다음 로그 (tx 인덱스를 늘리지 않음) */
  sameTx<T extends ChainEvent>(prev: ChainEvent, e: T): T {
    return {...e, txHash: prev.txHash, txIndex: prev.txIndex, logIndex: prev.logIndex + 1};
  }
  tokenCall(from: Address, parties: Address[], fn: "transfer" | "transferFrom" | "approve" = "transfer"): ChainEvent {
    return {...this.pos(), logIndex: -1, kind: "tokenCall", from, call: {fn, parties: [from, ...parties]}};
  }
  code(account: Address, code: Hex): ChainEvent {
    return {...this.pos(), logIndex: -1, kind: "code", account, code};
  }
}
