import type {Block, PublicClient, Transaction} from "viem";
import type {Address, AlertSink, ConfigStore, Hex, Logger} from "@stb/common";
import {lower, silentLogger} from "@stb/common";
import {decodeLogs, decodeTokenCall, type BlockMeta, type ChainEvent} from "./events";
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
 * - 최신 블록보다 N블록 이상 뒤처지거나 WebSocket이 끊기면 최고 등급 알림을 보낸다.
 */
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
  /** 처리 지연 측정: 블록 도착부터 Detector 처리 완료까지 (목표 1초) */
  readonly latencies: number[] = [];

  constructor(private readonly d: IngestorDeps) {
    this.log = d.log ?? silentLogger;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const cfg = this.d.config.current().rules.ingestor;
    await this.tick();
    const poll = () => {
      if (this.stopped) return;
      this.timer = setTimeout(async () => {
        await this.tick().catch((err) => this.log.error("poll failed", {err: String(err)}));
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
              // 블록 처리와 같은 큐에 넣어 Detector 상태를 한 번에 하나만 바꾼다.
              for (const h of hashes) {
                this.chain = this.chain
                  .then(() => this.onPending(h))
                  .catch((err) => this.log.warn("pending failed", {err: String(err)}));
              }
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
        const code = ((await this.d.client.getCode({address: a, blockNumber: n})) ?? "0x") as Hex;
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

  private async onPending(hash: Hex): Promise<void> {
    const {book} = this.d.config.current();
    const tx = await this.d.client.getTransaction({hash}).catch(() => null);
    if (!tx || !tx.to || tx.blockNumber !== null) return;
    const to = lower(tx.to);
    if (to !== book.token && !book.isExit(to)) return;
    await this.d.detector.processPending({
      kind: "pending",
      hash,
      from: lower(tx.from),
      to,
      input: tx.input,
      timestamp: this.latestTs || Math.floor(Date.now() / 1000),
      call: to === book.token ? decodeTokenCall(tx.from, tx.input) : undefined,
    });
  }
}
