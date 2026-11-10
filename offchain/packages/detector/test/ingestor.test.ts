import {describe, expect, it, vi} from "vitest";
import {encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Log, type PublicClient} from "viem";
import {stableTokenAbi} from "@stb/abi";
import {ConfigStore, units, type Address, type Hex} from "@stb/common";
import type {Detector} from "../src/detector";
import type {ChainEvent} from "../src/events";
import {Ingestor, MAX_PENDING_INFLIGHT} from "../src/ingestor";
import {MemoryStore} from "../src/stores/memory";
import {A, D, makeConfig, Sinks} from "./helpers";

interface FakeBlock {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
  transactions: any[];
  logs: Log[];
}

/** 블록·로그를 메모리에 둔 가짜 RPC. 재조직과 RPC 오류를 흉내 낸다. */
class FakeRpc {
  blocks: FakeBlock[] = [];
  failOn = new Set<bigint>();
  calls = 0;
  /** 이 블록 조회를 release가 풀릴 때까지 멈춘다 (RPC가 응답하지 않는 상황) */
  hang?: {block: bigint; release: Promise<void>};
  /** 이 블록보다 오래된 상태는 없다 (비아카이브 노드). getCode에 blockNumber를 주면 오류 */
  prunedBelow?: bigint;
  codeCalls: (bigint | undefined)[] = [];
  /** pending 조회 흉내. 없으면 null */
  getTx?: (hash: Hex) => Promise<any>;

  constructor(n: number, private salt = "a") {
    for (let i = 0; i <= n; i++) this.push();
  }

  push(transfers: [Address, Address, number][] = []) {
    const number = BigInt(this.blocks.length);
    const hash = keccak256(toHex(`${this.salt}:${number}`));
    const parentHash = number === 0n ? (("0x" + "00".repeat(32)) as Hex) : this.blocks[Number(number) - 1].hash;
    const logs = transfers.map(([from, to, amount], i) => this.transferLog(number, hash, i, from, to, amount));
    this.blocks.push({number, hash, parentHash, timestamp: 1_700_000_000n + number * 12n, transactions: [], logs});
  }

  /** k번 블록부터 다른 갈래로 바꾼다. */
  fork(k: number, salt: string) {
    this.salt = salt;
    const n = this.blocks.length;
    this.blocks = this.blocks.slice(0, k);
    while (this.blocks.length < n) this.push();
  }

  private transferLog(block: bigint, blockHash: Hex, i: number, from: Address, to: Address, amount: number): Log {
    return {
      address: D.token,
      topics: encodeEventTopics({abi: stableTokenAbi, eventName: "Transfer", args: {from, to}}) as any,
      data: encodeAbiParameters([{type: "uint256"}], [units(amount)]),
      blockNumber: block,
      blockHash,
      transactionHash: keccak256(toHex(`tx:${blockHash}:${i}`)),
      transactionIndex: i,
      logIndex: i,
      removed: false,
    } as Log;
  }

  client(): PublicClient {
    const self = this;
    return {
      async getBlockNumber() {
        return BigInt(self.blocks.length - 1);
      },
      async getBlock({blockNumber}: {blockNumber: bigint}) {
        self.calls++;
        if (self.hang && self.hang.block === blockNumber) await self.hang.release;
        if (self.failOn.has(blockNumber)) {
          self.failOn.delete(blockNumber);
          throw new Error(`rpc error at ${blockNumber}`);
        }
        const b = self.blocks[Number(blockNumber)];
        if (!b) throw new Error("no block");
        return {...b};
      },
      async getLogs({fromBlock}: {fromBlock: bigint}) {
        return self.blocks[Number(fromBlock)].logs;
      },
      async getCode({blockNumber}: {blockNumber?: bigint}) {
        self.codeCalls.push(blockNumber);
        if (blockNumber !== undefined && self.prunedBelow !== undefined && blockNumber < self.prunedBelow) throw new Error("historical state is not available");
        return "0x";
      },
      async getTransaction({hash}: {hash: Hex}) {
        return self.getTx ? self.getTx(hash) : null;
      },
    } as unknown as PublicClient;
  }
}

function fakeDetector() {
  const seen: {block: bigint; events: ChainEvent[]}[] = [];
  const reorgs: bigint[] = [];
  const det = {
    processBlock: vi.fn(async (events: ChainEvent[]) => {
      seen.push({block: events[0]?.blockNumber ?? -1n, events});
    }),
    onReorg: vi.fn(async (b: bigint) => void reorgs.push(b)),
    processPending: vi.fn(async () => {}),
  };
  return {det: det as unknown as Detector, raw: det, seen, reorgs};
}

function make(rpc: FakeRpc, store = new MemoryStore(), opts: {ws?: PublicClient; watched?: Address[]} = {}) {
  const sinks = new Sinks();
  const det = fakeDetector();
  const ing = new Ingestor({
    client: rpc.client(),
    ws: opts.ws,
    config: new ConfigStore(opts.watched ? makeConfig({watched: opts.watched}) : makeConfig()),
    store,
    detector: det.det,
    alerts: sinks.alertSink,
    startBlock: 1n,
  });
  return {ing, store, sinks, ...det};
}

describe("Ingestor 장애 테스트 (design.md 12장)", () => {
  it("시작 블록부터 최신까지 한 블록씩 처리하고 커서를 남긴다", async () => {
    const rpc = new FakeRpc(0);
    rpc.push([[A(1), A(2), 5]]);
    rpc.push();
    rpc.push([[A(2), A(3), 1]]);
    const t = make(rpc);
    await t.ing.tick();
    expect(t.raw.processBlock).toHaveBeenCalledTimes(3);
    expect((await t.store.getCursor())!.block).toBe(3n);
    const transfers = t.seen.flatMap((s) => s.events).filter((e) => e.kind === "transfer");
    expect(transfers).toHaveLength(2);
  });

  it("RPC 오류: 실패한 블록에서 멈추고 다음 틱에 이어서 처리 (누락·중복 없음)", async () => {
    const rpc = new FakeRpc(6);
    rpc.failOn.add(4n);
    const t = make(rpc);
    await expect(t.ing.tick()).rejects.toThrow("rpc error at 4");
    expect((await t.store.getCursor())!.block).toBe(3n);
    await t.ing.tick();
    expect((await t.store.getCursor())!.block).toBe(6n);
    expect(t.raw.processBlock).toHaveBeenCalledTimes(6); // 1..6 각각 한 번
  });

  it("재시작 (DB 재시작 포함): 같은 저장소로 새 인스턴스를 띄우면 커서 다음 블록부터", async () => {
    const rpc = new FakeRpc(3);
    const store = new MemoryStore();
    const first = make(rpc, store);
    await first.ing.tick();
    rpc.push();
    rpc.push();
    const second = make(rpc, store);
    await second.ing.tick();
    expect(second.raw.processBlock).toHaveBeenCalledTimes(2);
    expect((await store.getCursor())!.block).toBe(5n);
  });

  it("재조직: 부모 해시가 다르면 공통 조상까지 되돌아가 다시 처리", async () => {
    const rpc = new FakeRpc(5);
    const t = make(rpc);
    await t.ing.tick();
    rpc.fork(4, "b"); // 4, 5가 바뀜
    rpc.push(); // 6
    await t.ing.tick();
    expect(t.reorgs).toEqual([4n]);
    expect((await t.store.getCursor())!).toEqual({block: 6n, hash: rpc.blocks[6].hash});
    expect(await t.store.getBlockHash(4n)).toBe(rpc.blocks[4].hash);
  });

  it("지연 경보: 최신 블록보다 N블록 이상 뒤처지면 최고 등급 알림 한 번", async () => {
    const rpc = new FakeRpc(20);
    const t = make(rpc);
    await t.ing.tick();
    const lag = t.sinks.alertsOf("ingestor.lag");
    expect(lag).toHaveLength(1);
    expect(lag[0].severity).toBe("critical");
  });

  it("WebSocket 끊김: 최고 등급 알림을 보내고 HTTP 폴링으로 계속 처리", async () => {
    const rpc = new FakeRpc(2);
    let fail: ((e: Error) => void) | undefined;
    const ws = {
      watchBlockNumber: ({onError}: {onError: (e: Error) => void}) => {
        fail = onError;
        return () => {};
      },
      watchPendingTransactions: () => () => {},
    } as unknown as PublicClient;
    const t = make(rpc, new MemoryStore(), {ws});
    await t.ing.start();
    fail!(new Error("socket closed"));
    await new Promise((r) => setTimeout(r, 10));
    expect(t.sinks.alertsOf("ingestor.ws_down")).toHaveLength(1);
    rpc.push();
    await t.ing.tick();
    expect((await t.store.getCursor())!.block).toBe(3n);
    await t.ing.stop();
  });

  it("pending 폭주: 조회는 줄 밖에서 동시 상한까지만, 블록 처리는 막히지 않는다", async () => {
    const rpc = new FakeRpc(2);
    let inflight = 0;
    let peak = 0;
    rpc.getTx = async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return {to: A(0x999), from: A(1), input: "0x", blockNumber: null}; // 토큰과 무관한 거래
    };
    let emit: ((hs: Hex[]) => void) | undefined;
    const ws = {
      watchBlockNumber: () => () => {},
      watchPendingTransactions: ({onTransactions}: {onTransactions: (hs: Hex[]) => void}) => {
        emit = onTransactions;
        return () => {};
      },
    } as unknown as PublicClient;
    const t = make(rpc, new MemoryStore(), {ws});
    await t.ing.start();
    emit!(Array.from({length: 500}, (_, i) => keccak256(toHex(`p${i}`))));
    rpc.push([[A(1), A(2), 5]]);
    const t0 = Date.now();
    await t.ing.tick();
    expect(Date.now() - t0).toBeLessThan(200); // 500건 x 30ms를 기다리지 않는다
    expect((await t.store.getCursor())!.block).toBe(3n);
    expect(peak).toBeLessThanOrEqual(MAX_PENDING_INFLIGHT);
    // 초당 상한(기본 5)이 동시 상한(8)보다 먼저 걸린다: 한 번에 몰린 500건 중 5건만 조회한다
    expect(t.ing.pendingDropped).toBe(500 - 5);
    expect(t.raw.processPending).not.toHaveBeenCalled();
    await t.ing.stop();
  });

  it("pending: 토큰으로 가는 거래만 Detector로 넘긴다", async () => {
    const rpc = new FakeRpc(1);
    rpc.getTx = async (hash: Hex) =>
      hash === keccak256(toHex("tok")) ? {to: D.token, from: A(1), input: "0x", blockNumber: null} : {to: A(0x999), from: A(1), input: "0x", blockNumber: null};
    let emit: ((hs: Hex[]) => void) | undefined;
    const ws = {
      watchBlockNumber: () => () => {},
      watchPendingTransactions: ({onTransactions}: {onTransactions: (hs: Hex[]) => void}) => {
        emit = onTransactions;
        return () => {};
      },
    } as unknown as PublicClient;
    const t = make(rpc, new MemoryStore(), {ws});
    await t.ing.start();
    emit!([keccak256(toHex("other")), keccak256(toHex("tok"))]);
    await new Promise((r) => setTimeout(r, 20));
    await t.ing.tick();
    expect(t.raw.processPending).toHaveBeenCalledTimes(1);
    await t.ing.stop();
  });

  it("처리가 RPC에서 멈춰도 폴링이 지연 경보를 보낸다", async () => {
    const rpc = new FakeRpc(2);
    const t = make(rpc);
    await t.ing.tick(); // 커서 2
    let release!: () => void;
    rpc.hang = {block: 3n, release: new Promise<void>((r) => (release = r))};
    rpc.push();
    rpc.push(); // head 4: 지연 1블록
    await t.ing.pollOnce(); // 3번 블록 조회에서 멈춘 처리가 줄에 들어간다
    expect(t.sinks.alertsOf("ingestor.lag")).toHaveLength(0);
    for (let i = 0; i < 6; i++) rpc.push(); // head 10: 지연 7블록, 처리는 여전히 멈춰 있다
    await t.ing.pollOnce();
    await t.ing.pollOnce(); // 같은 지연에 두 번 알리지 않는다
    const lag = t.sinks.alertsOf("ingestor.lag");
    expect(lag).toHaveLength(1);
    expect(lag[0].severity).toBe("critical");
    release();
    await t.ing.tick();
    expect((await t.store.getCursor())!.block).toBe(10n);
  });

  it("과거 상태가 없는 노드: R6 코드 조회는 최신 값으로 대신하고 처리를 계속한다", async () => {
    const rpc = new FakeRpc(4);
    rpc.prunedBelow = 100n; // 모든 블록이 '오래된' 블록
    const t = make(rpc, new MemoryStore(), {watched: [A(0x777)]});
    await t.ing.tick();
    expect((await t.store.getCursor())!.block).toBe(4n);
    expect(rpc.codeCalls.some((b) => b === undefined)).toBe(true);
  });

  it("시작할 때 첫 처리가 실패해도 프로세스를 죽이지 않고 다음 폴링에서 이어간다", async () => {
    const rpc = new FakeRpc(3);
    rpc.failOn.add(2n);
    const t = make(rpc);
    await expect(t.ing.start()).resolves.toBeUndefined();
    expect((await t.store.getCursor())!.block).toBe(1n);
    await t.ing.tick();
    expect((await t.store.getCursor())!.block).toBe(3n);
    await t.ing.stop();
  });
});
