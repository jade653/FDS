import {createPublicClient, http, webSocket, type PublicClient} from "viem";
import type {ConfigStore, Logger} from "@stb/common";
import {silentLogger} from "@stb/common";
import {Detector, Ingestor, viemChainReader, type Store, type WindowStore} from "@stb/detector";
import {MemoryLock, Responder, type LeaderLock, type ResponderMode, type TxSigner} from "@stb/responder";
import {ApprovalServer, ApprovalTokens, Notifier, OperatorAuth, type Channel} from "@stb/notifier";

export interface WatchtowerOptions {
  config: ConfigStore;
  httpUrl: string;
  wsUrl?: string;
  /** 프라이빗 제출 RPC (선택) */
  privateUrl?: string;
  store: Store;
  window: WindowStore;
  signer: TxSigner;
  mode: () => ResponderMode;
  approvalSecret: string;
  /** "name:sha256hex,..." */
  operators: string;
  approvalPort?: number;
  channels?: Channel[];
  lock?: LeaderLock;
  log?: Logger;
  startBlock?: bigint;
  pollMs?: number;
}

/** Ingestor → Detector → Responder / Notifier를 한 프로세스로 묶는다 (design.md 4장). */
export function createWatchtower(o: WatchtowerOptions) {
  const log = o.log ?? silentLogger;
  const {book} = o.config.current();
  const client = createPublicClient({transport: http(o.httpUrl), pollingInterval: o.pollMs ?? 250}) as PublicClient;
  const ws = o.wsUrl ? (createPublicClient({transport: webSocket(o.wsUrl), pollingInterval: o.pollMs ?? 250}) as PublicClient) : undefined;
  const privateClient = o.privateUrl ? (createPublicClient({transport: http(o.privateUrl)}) as PublicClient) : undefined;

  const notifier = new Notifier({config: o.channels ? undefined : o.config, channels: o.channels, log});
  const approvals = new ApprovalTokens(o.approvalSecret, {
    baseUrl: () => o.config.current().rules.approval.base_url,
    ttlSec: () => o.config.current().rules.approval.link_ttl_minutes * 60,
  });
  const responder = new Responder({
    config: o.config,
    mode: o.mode,
    client,
    privateClient,
    signer: o.signer,
    store: o.store,
    alerts: notifier,
    approvals,
    lock: o.lock ?? new MemoryLock(),
    log,
    pollMs: o.pollMs,
  });
  const detector = new Detector({
    config: o.config,
    store: o.store,
    window: o.window,
    chain: viemChainReader(client, book.token),
    freezer: responder,
    alerts: notifier,
    approvals,
    log,
  });
  const ingestor = new Ingestor({
    client,
    ws,
    config: o.config,
    store: o.store,
    detector,
    alerts: notifier,
    startBlock: o.startBlock ?? BigInt(book.deployment.startBlock),
    log,
  });
  const approvalServer = new ApprovalServer({
    tokens: approvals,
    auth: new OperatorAuth(o.operators),
    store: o.store,
    freezer: responder,
    log,
    port: o.approvalPort ?? 8787,
  });

  // 설정 핫리로드 실패: 이전 설정 유지, 알림 (design.md 7.4)
  o.config.on("error", (err) => {
    void notifier.alert({severity: "critical", kind: "config.reload_failed", title: "설정 다시 읽기 실패. 이전 설정으로 계속 운영", lines: [String(err)]});
  });
  o.config.on("change", () => {
    void notifier.alert({severity: "info", kind: "config.reloaded", title: "설정 다시 읽음", lines: []});
  });

  let gasTimer: NodeJS.Timeout | undefined;

  return {
    client,
    notifier,
    approvals,
    responder,
    detector,
    ingestor,
    approvalServer,
    async start(opts: {approvalServer?: boolean} = {}) {
      if (opts.approvalServer !== false) await approvalServer.listen();
      await ingestor.start();
      await responder.checkGas().catch((err) => log.warn("gas check failed", {err: String(err)}));
      gasTimer = setInterval(() => void responder.checkGas().catch(() => undefined), 10 * 60_000);
    },
    async stop() {
      clearInterval(gasTimer);
      await ingestor.stop();
      await approvalServer.close();
      o.config.close();
    },
  };
}

export type Watchtower = ReturnType<typeof createWatchtower>;
