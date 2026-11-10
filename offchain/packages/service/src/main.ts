#!/usr/bin/env node
// 감시탑 프로세스: Ingestor → Detector → Responder, Notifier, 승인 서버.
//   CHAIN=sepolia pnpm watchtower
// 환경 변수는 저장소 루트의 .env에서 읽는다 (.env.example 참고). 비밀값은 저장소에 넣지 않는다.
import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Pool} from "pg";
import {Redis} from "ioredis";
import {ConfigStore, createLogger, type Hex} from "@stb/common";
import {MemoryStore, MemoryWindowStore, PgStore, RedisWindowStore, type Store, type WindowStore} from "@stb/detector";
import {keystoreSigner, kmsSigner, MemoryLock, RedisLock, type LeaderLock, type ResponderMode, type TxSigner} from "@stb/responder";
import {createWatchtower} from "./watchtower";

const ROOT = resolve(import.meta.dirname, "../../../..");

function loadDotEnv() {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

async function main() {
  loadDotEnv();
  const log = createLogger("watchtower");
  const chain = process.env.CHAIN ?? "anvil";
  const config = new ConfigStore({rules: resolve(ROOT, "config/rules.yaml"), addresses: resolve(ROOT, `config/addresses.${chain}.yaml`)});
  config.watch();

  const prefix = chain === "sepolia" ? "SEPOLIA" : chain === "anvil" ? "ANVIL" : "CUSTOM_CHAIN";
  const httpUrl = process.env[`${prefix}_RPC_URL`] ?? (chain === "anvil" ? "http://127.0.0.1:8545" : need(`${prefix}_RPC_URL`));
  const wsUrl = process.env[`${prefix}_WS_URL`] ?? (chain === "anvil" ? "ws://127.0.0.1:8545" : undefined);

  let store: Store;
  let window: WindowStore;
  let lock: LeaderLock;
  if (process.env.DATABASE_URL && process.env.REDIS_URL && process.env.STORE !== "memory") {
    const pg = new PgStore(new Pool({connectionString: process.env.DATABASE_URL}));
    await pg.migrate();
    const redis = new Redis(process.env.REDIS_URL);
    store = pg;
    window = new RedisWindowStore(redis);
    lock = new RedisLock(redis);
  } else {
    log.warn("DATABASE_URL/REDIS_URL not set: using in-memory stores (restart loses state)");
    store = new MemoryStore();
    window = new MemoryWindowStore();
    lock = new MemoryLock();
  }

  let signer: TxSigner;
  if (process.env.BOT_KMS_KEY_ID) signer = kmsSigner(process.env.BOT_KMS_KEY_ID);
  else signer = keystoreSigner(need("BOT_KEYSTORE_PATH"), need("BOT_KEYSTORE_PASSWORD"));
  const bot = config.current().book.bot;
  if (signer.address !== bot) throw new Error(`signer ${signer.address} is not the configured bot ${bot} (addresses.<chain>.yaml bot / deployment.bot)`);

  const mode = (): ResponderMode => {
    const m = process.env.RESPONDER_MODE ?? "shadow";
    if (m !== "shadow" && m !== "auto" && m !== "off") throw new Error(`invalid RESPONDER_MODE ${m}`);
    return m;
  };
  // 커서가 없을 때 시작할 블록. 기본은 배포 블록부터 전부 읽는다. 메모리 저장소로 시연할 때는 WATCH_FROM=latest로
  // 지금 블록부터 본다 (재시작마다 과거 이벤트를 다시 처리하지 않도록).
  let startBlock: bigint | undefined;
  const from = process.env.WATCH_FROM;
  if (from === "latest") {
    const {createPublicClient, http} = await import("viem");
    startBlock = await createPublicClient({transport: http(httpUrl)}).getBlockNumber();
  } else if (from) {
    if (!/^\d+$/.test(from)) throw new Error(`invalid WATCH_FROM ${from} (block number or "latest")`);
    startBlock = BigInt(from);
  }
  log.info("starting", {chain, mode: mode(), bot, startBlock: startBlock?.toString() ?? "deployment"});

  const wt = createWatchtower({
    config,
    httpUrl,
    wsUrl,
    privateUrl: process.env.PRIVATE_RPC_URL,
    store,
    window,
    signer,
    mode,
    approvalSecret: need("APPROVAL_SIGNING_KEY"),
    operators: need("APPROVAL_OPERATORS"),
    approvalPort: Number(process.env.APPROVAL_PORT ?? 8787),
    lock,
    log,
    startBlock,
  });
  await wt.start();
  const shutdown = async () => {
    log.info("stopping");
    await wt.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});

export type {Hex};
