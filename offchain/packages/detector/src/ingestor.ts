import type {Block, PublicClient, Transaction} from "viem";
import type {Address, AlertSink, ConfigStore, Hex, Logger} from "@stb/common";
import {lower, silentLogger} from "@stb/common";
import {decodeLogs, decodeTokenCall, type BlockMeta, type ChainEvent, type PendingTxEvent} from "./events";
import type {Detector} from "./detector";
import type {CursorStore} from "./stores/types";

export interface IngestorDeps {
  /** HTTP 클라이언트. 블록·로그 조회와 누락 메우기에 쓴다. */
  client: PublicClient;
  /** WebSocket 클라이언트. 새 블록 알림과 pending 구독에 쓴다. 없으면 HTTP 폴링만 한다. */
  ws?: PublicClient;
  config: ConfigStore;
  store: CursorStore;
  detector: Detector;
  alerts: AlertSink;
  /** 커서가 없을 때 시작할 블록 (보통 deployment.startBlock) */
  startBlock: bigint;
  log?: Logger;
}

/**
 * 새 블록과 토큰 이벤트를 읽어 Detector에 넘긴다 (design.md 7.1 Ingestor, 7.4 신뢰성 요건).
 *
 * - 처리는 언제나 "커서+1부터 최신 블록까지"를 HTTP로 읽는다. WebSocket은 깨우는 신호일 뿐이라
 *   끊겨도 다음 폴링이 마지막 처리 블록부터 메운다.
 * - 블록을 처리할 때마다 커서와 블록 해시를 저장한다. 재시작하면 커서 다음 블록부터 이어간다.
 * - 부모 해시가 저장된 해시와 다르면 재조직으로 보고 공통 조상까지 되돌아가 다시 처리한다.
 * - 최신 블록보다 N블록 이상 뒤처지거나 WebSocket이 끊기면 최고 등급 알림을 보낸다. 지연은 폴링 타이머가
 *   처리 줄과 따로 재므로, 처리가 멈춰도 알림이 나간다.
 * - pending 거래는 처리 줄 밖에서 동시에 최대 MAX_PENDING_INFLIGHT개, 초당 pending_fetch_per_sec개까지만
 *   조회하고 넘치면 버린다 (최선 노력).
 *   토큰·출구로 가는 거래만 처리 줄에 넣는다. 공개 체인의 pending 폭주가 블록 처리를 막지 않게 하기 위해서다.
 */
export const MAX_PENDING_INFLIGHT = 8;

export class Ingestor {
  private readonly log: Logger;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private unwatch: (() => void)[] = [];
  private lagAlerted = false;
  private wsAlerted = false;
  private stopped = false;
  private lastCode = new Map<Address, Hex>();
  private latestTs = 0;
  private syncing = false;
  private pendingInflight = 0;
  /** pending 조회 토큰 버킷 (초당 상한) */
  private pendingTokens = 0;
  private pendingRefillAt = 0;
  /** 동시 조회 상한에 걸려 버린 pending 해시 수 (관찰용) */
  pendingDropped = 0;
  /** 처리 지연 측정: 블록 도착부터 Detector 처리 완료까지 (목표 1초) */
  readonly latencies: number[] = [];

  constructor(private readonly d: IngestorDeps) {
    this.log = d.log ?? silentLogger;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const cfg = this.d.config.current().rules.ingestor;
    // 첫 처리의 RPC 오류로 프로세스를 죽이지 않는다. 폴링이 커서부터 다시 시도한다.
    await this.tick().catch((err) => this.log.error("initial sync failed", {err: String(err)}));
    const poll = () => {
      if (this.stopped) return;
      this.timer = setTimeout(async () => {
        await this.pollOnce().catch((err) => this.log.error("poll failed", {err: String(err)}));
        poll();
      }, this.d.config.current().rules.ingestor.poll_interval_ms);
    };
    poll();

    if (this.d.ws) {
      this.unwatch.push(
        this.d.ws.watchBlockNumber({
          emitOnBegin: false,
          onBlockNumber: (n) => {
            this.wsAlerted = false;
            this.enqueue(n).catch((err) => this.log.error("ws sync failed", {err: String(err)}));
          },
          onError: (err) => this.wsDown(err),
        }),
      );
      if (cfg.pending) {
        this.unwatch.push(
          this.d.ws.watchPendingTransactions({
            onTransactions: (hashes) => {
              for (const h of hashes) this.onPendingHash(h);
            },
            onError: (err) => this.wsDown(err),
          }),
        );
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const u of this.unwatch) u();
    this.unwatch = [];
    await this.chain;
  }

  /**
   * 폴링 한 번: 지연을 처리 줄과 따로 재고, 앞선 처리가 끝났을 때만 새 처리를 줄에 넣는다.
   * 처리가 RPC에서 멈춰도 지연 경보는 나간다.
   */
  async pollOnce(): Promise<void> {
    const head = await this.d.client.getBlockNumber({cacheTime: 0});
    await this.checkLag(head);
    if (this.syncing) return;
    this.syncing = true;
    this.enqueue(head)
      .catch((err) => this.log.error("sync failed", {err: String(err)}))
      .finally(() => (this.syncing = false));
  }

  private async checkLag(head: bigint): Promise<void> {
    const cfg = this.d.config.current().rules.ingestor;
    const cursor = await this.d.store.getCursor();
    const next = cursor ? cursor.block + 1n : this.d.startBlock;
    const lag = head >= next ? head - next : 0n;
    if (lag < BigInt(cfg.lag_alert_blocks)) {
      this.lagAlerted = false;
      return;
    }
    if (this.lagAlerted) return;
    this.lagAlerted = true;
    await this.d.alerts.alert({
      severity: "critical",
      kind: "ingestor.lag",
      title: `Ingestor 지연: 최신 블록보다 ${lag}블록 뒤처짐`,
      lines: [`head ${head}`, `next ${next}`, this.syncing ? "처리가 진행 중이거나 멈춤 (RPC 응답 확인)" : "따라잡는 중"],
    });
  }

  /** 최신 블록까지 처리하고 끝날 때까지 기다린다. 테스트와 폴링에서 쓴다. */
  async tick(): Promise<void> {
    const head = await this.d.client.getBlockNumber({cacheTime: 0});
    await this.enqueue(head);
  }

  private enqueue(head: bigint): Promise<void> {
    const run = this.chain.then(() => this.syncTo(head));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async wsDown(err: unknown) {
    this.log.error("websocket error", {err: String(err)});
    if (this.wsAlerted) return;
    this.wsAlerted = true;
    await this.d.alerts.alert({
      severity: "critical",
      kind: "ingestor.ws_down",
      title: "Ingestor WebSocket 끊김. HTTP 폴링으로 계속 처리 중",
      lines: [String(err)],
    });
  }

  private async syncTo(head: bigint): Promise<void> {
    const cfg = this.d.config.current().rules.ingestor;
    let cursor = await this.d.store.getCursor();
    let next = cursor ? cursor.block + 1n : this.d.startBlock;
    while (next <= head && !this.stopped) {
      const lag = head - next;
      if (lag >= BigInt(cfg.lag_alert_blocks) && !this.lagAlerted) {
        this.lagAlerted = true;
        await this.d.alerts.alert({
          severity: "critical",
          kind: "ingestor.lag",
          title: `Ingestor 지연: 최신 블록보다 ${lag}블록 뒤처짐`,
          lines: [`head ${head}`, `next ${next}`],
        });
      }
      if (lag >= BigInt(cfg.lag_alert_blocks) && next % 20n === 0n) this.log.info("catching up", {block: next.toString(), behind: lag.toString()});
      const res = await this.processBlockNumber(next);
      if (res.reorgTo !== undefined) {
        next = res.reorgTo;
        continue;
      }
      next += 1n;
    }
    cursor = await this.d.store.getCursor();
    if (cursor && head - cursor.block < BigInt(cfg.lag_alert_blocks)) this.lagAlerted = false;
  }

  private async processBlockNumber(n: bigint): Promise<{reorgTo?: bigint}> {
    const arrived = Date.now();
    const {book, rules} = this.d.config.current();
    const block = (await this.d.client.getBlock({blockNumber: n, includeTransactions: true})) as Block<bigint, true>;
    if (!block.hash) throw new Error(`block ${n} has no hash`);

    // 재조직 확인
    if (n > this.d.startBlock) {
      const prevHash = await this.d.store.getBlockHash(n - 1n);
      if (prevHash && prevHash !== block.parentHash) {
        const fork = await this.findFork(n - 1n, rules.ingestor.reorg_depth);
        this.log.warn("reorg detected", {at: n, fork});
        await this.d.detector.onReorg(fork);
        const parent = await this.d.client.getBlock({blockNumber: fork - 1n});
        await this.d.store.setCursor({block: fork - 1n, hash: parent.hash!});
        return {reorgTo: fork};
      }
    }

    const txs = block.transactions as Transaction[];
    const meta: BlockMeta = {
      number: n,
      hash: block.hash,
      timestamp: Number(block.timestamp),
      txIndex: new Map(txs.map((t, i) => [t.hash.toLowerCase(), t.transactionIndex ?? i])),
      txFrom: new Map(txs.map((t) => [t.hash.toLowerCase(), lower(t.from)])),
    };
    this.latestTs = meta.timestamp;

    const logs = await this.d.client.getLogs({address: [book.token, book.timelock, book.proxyAdmin], fromBlock: n, toBlock: n});
    const events: ChainEvent[] = decodeLogs(logs, book, meta);

    // 토큰 호출과 출구(DEX·브리지) 호출 (R5, R10)
    for (const [i, t] of txs.entries()) {
      if (!t.to) continue;
      const to = lower(t.to);
      const pos = {blockNumber: n, blockHash: block.hash, txHash: t.hash, txIndex: t.transactionIndex ?? i, logIndex: -1, timestamp: meta.timestamp, txFrom: lower(t.from)};
      if (to === book.token) events.push({...pos, kind: "tokenCall", from: lower(t.from), call: decodeTokenCall(t.from, t.input)});
      else if (book.isExit(to)) events.push({...pos, kind: "exitCall", from: lower(t.from), to});
    }

    // 감시 EOA의 코드 변화 (R6: EIP-7702 위임 또는 코드 생성)
    if (rules.rules.R6.enabled) {
      for (const a of book.watched()) {
        const code = await this.codeAt(a, n);
        if (code !== "0x" && this.lastCode.get(a) !== code) {
          events.push({blockNumber: n, blockHash: block.hash, txHash: block.hash, txIndex: 1_000_000, logIndex: -1, timestamp: meta.timestamp, kind: "code", account: a, code});
        }
        this.lastCode.set(a, code);
      }
    }

    await this.d.detector.processBlock(events);
    await this.d.store.setBlockHash(n, block.hash);
    await this.d.store.setCursor({block: n, hash: block.hash});
    if (n % 100n === 0n) await this.d.store.pruneBlockHashes(n - BigInt(rules.ingestor.reorg_depth));
    this.latencies.push(Date.now() - arrived);
    if (this.latencies.length > 1000) this.latencies.shift();
    return {};
  }

  /** 그 블록 시점의 코드. 노드가 과거 상태를 보관하지 않으면(비아카이브, 오래된 블록) 최신 코드로 대신한다. */
  private async codeAt(a: Address, n: bigint): Promise<Hex> {
    try {
      return ((await this.d.client.getCode({address: a, blockNumber: n})) ?? "0x") as Hex;
    } catch {
      return ((await this.d.client.getCode({address: a})) ?? "0x") as Hex;
    }
  }

  /** 저장된 해시와 체인의 해시가 같아지는 곳(공통 조상)의 다음 블록을 돌려준다. */
  private async findFork(from: bigint, depth: number): Promise<bigint> {
    let k = from;
    const floor = from - BigInt(depth) > this.d.startBlock ? from - BigInt(depth) : this.d.startBlock;
    while (k >= floor) {
      const stored = await this.d.store.getBlockHash(k);
      const onchain = (await this.d.client.getBlock({blockNumber: k})).hash;
      if (stored === undefined || stored === onchain) return k + 1n;
      k -= 1n;
    }
    // 재조직 깊이를 넘음: 가능한 가장 이른 블록부터 다시 처리하고 알린다.
    await this.d.alerts.alert({
      severity: "critical",
      kind: "ingestor.deep_reorg",
      title: `재조직 깊이 ${depth}블록 초과`,
      lines: [`from ${from}`],
    });
    return floor;
  }

  /** pending 해시 하나: 처리 줄 밖에서 조회하고, 토큰·출구로 가는 거래만 줄에 넣는다. */
  private onPendingHash(hash: Hex): void {
    if (this.stopped) return;
    if (this.pendingInflight >= MAX_PENDING_INFLIGHT || !this.takePendingToken()) {
      this.pendingDropped++;
      return;
    }
    this.pendingInflight++;
    this.fetchPending(hash)
      .then((ev) => {
        if (!ev || this.stopped) return;
        // Detector 상태는 블록 처리와 같은 줄에서 한 번에 하나만 바꾼다.
        this.chain = this.chain.then(() => this.d.detector.processPending(ev)).catch((err) => this.log.warn("pending failed", {err: String(err)}));
      })
      .catch((err) => this.log.warn("pending fetch failed", {err: String(err)}))
      .finally(() => this.pendingInflight--);
  }

  private takePendingToken(): boolean {
    const rate = this.d.config.current().rules.ingestor.pending_fetch_per_sec;
    const now = Date.now();
    if (this.pendingRefillAt === 0) this.pendingTokens = rate;
    else this.pendingTokens = Math.min(rate, this.pendingTokens + ((now - this.pendingRefillAt) / 1000) * rate);
    this.pendingRefillAt = now;
    if (this.pendingTokens < 1) return false;
    this.pendingTokens -= 1;
    return true;
  }

  private async fetchPending(hash: Hex): Promise<PendingTxEvent | undefined> {
    const {book} = this.d.config.current();
    const tx = await this.d.client.getTransaction({hash}).catch(() => null);
    if (!tx || !tx.to || tx.blockNumber !== null) return undefined;
    const to = lower(tx.to);
    if (to !== book.token && !book.isExit(to)) return undefined;
    return {
      kind: "pending",
      hash,
      from: lower(tx.from),
      to,
      input: tx.input,
      timestamp: this.latestTs || Math.floor(Date.now() / 1000),
      call: to === book.token ? decodeTokenCall(tx.from, tx.input) : undefined,
    };
  }
}
