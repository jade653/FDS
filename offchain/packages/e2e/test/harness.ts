import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEventLogs,
  toHex,
  type Account,
  type PublicClient,
} from "viem";
import {mnemonicToAccount, privateKeyToAccount} from "viem/accounts";
import {stableTokenAbi} from "@stb/abi";
import {ConfigStore, loadRuntimeConfig, lower, units, type Address, type Hex} from "@stb/common";
import {MemoryStore, MemoryWindowStore} from "@stb/detector";
import {privateKeySigner, type ResponderMode} from "@stb/responder";
import {OperatorAuth, type Channel} from "@stb/notifier";
import {createWatchtower, type Watchtower} from "@stb/service";
import type {OpsContext} from "@stb/ops-cli";

export const REPO = resolve(__dirname, "../../../..");
const WSL_REPO = "/mnt/" + REPO.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d: string) => d.toLowerCase());
export const MNEMONIC = "test test test test test test test test test test test junk";
export const anvilAccount = (i: number) => mnemonicToAccount(MNEMONIC, {addressIndex: i});
/** 결정적 테스트 키 (Anvil 밖에서는 쓰지 않는다) */
export const testAccount = (label: string) => privateKeyToAccount(keccak256(toHex(`e2e:${label}`)));

function wsl(cmd: string, opts: {timeoutMs?: number} = {}) {
  const r = spawnSync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lc", cmd], {encoding: "utf8", timeout: opts.timeoutMs ?? 300_000});
  if (r.status !== 0) throw new Error(`wsl failed (${r.status}): ${cmd}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

export class Anvil {
  proc: ChildProcess | undefined;
  constructor(readonly port: number) {}
  get http() {
    return `http://127.0.0.1:${this.port}`;
  }
  get ws() {
    return `ws://127.0.0.1:${this.port}`;
  }

  async start() {
    this.proc = spawn("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lc", `exec $HOME/.foundry/bin/anvil --host 0.0.0.0 --port ${this.port} --silent`], {stdio: "ignore"});
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(this.http, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_chainId", params: []})});
        if (r.ok) return;
      } catch {
        // 아직 안 떴다
      }
      await sleep(250);
    }
    throw new Error("anvil did not start");
  }

  stop() {
    this.proc?.kill();
    spawnSync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lc", `pkill -f "anvil --host 0.0.0.0 --port ${this.port}" || true`]);
  }
}

/** 실제 배포 스크립트(Deploy.s.sol)로 로컬 Anvil에 배포한다. 배포 직후 온체인 검증도 스크립트 안에서 돈다. */
export function deploy(anvil: Anvil): {deploymentPath: string} {
  const name = `e2e-${anvil.port}`;
  const key0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Anvil 기본 키 0
  wsl(
    `export PATH=$HOME/.foundry/bin:$PATH; cd ${WSL_REPO}/contracts && DEPLOY_CHAIN=anvil DEPLOY_OUTPUT_NAME=${name} ` +
      `forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:${anvil.port} --private-key ${key0} --broadcast 2>&1 | tail -20`,
  );
  return {deploymentPath: resolve(REPO, `deployments/${name}.json`)};
}

export interface Labels {
  hot: Address[];
  watched: Address[];
  whitelabel: Address[];
  exits: Address[];
}

export function writeAddresses(deploymentPath: string, labels: Labels): string {
  const dir = mkdtempSync(join(tmpdir(), "stb-e2e-"));
  const e = (xs: Address[], p: string) => (xs.length ? xs.map((a, i) => `  - address: "${a}"\n    label: "${p}${i + 1}"`).join("\n") : "  []");
  const yaml = [
    "chain_id: 31337",
    `deployment: ${JSON.stringify(deploymentPath.replace(/\\/g, "/"))}`,
    `hot:\n${e(labels.hot, "hot")}`,
    `watched:\n${e(labels.watched, "watched")}`,
    `whitelabel:\n${e(labels.whitelabel, "exchange")}`,
    `exits:\n${e(labels.exits, "router")}`,
    "protected: []",
  ].join("\n");
  const p = join(dir, "addresses.e2e.yaml");
  writeFileSync(p, yaml.replace(/:\n  \[\]/g, ": []"));
  return p;
}

export class Capture implements Channel {
  readonly name = "capture";
  alerts: {kind: string; severity: string; title: string; caseKey?: Hex; approvalLinks?: {address: Address; url: string}[]; lines: string[]}[] = [];
  async send(a: any) {
    this.alerts.push(a);
  }
  of(kind: string) {
    return this.alerts.filter((a) => a.kind === kind);
  }
}

export const OPERATOR_TOKEN = "e2e-operator-token";
const BOT_KEY: Hex = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"; // Anvil 기본 키 6

export interface Env {
  anvil: Anvil;
  client: PublicClient;
  config: ConfigStore;
  wt: Watchtower;
  store: MemoryStore;
  capture: Capture;
  ops: OpsContext;
  token: Address;
  setMode(m: ResponderMode): void;
}

export async function startWatchtower(anvil: Anvil, addressesPath: string): Promise<Env> {
  const paths = {rules: resolve(REPO, "config/rules.yaml"), addresses: addressesPath};
  const config = new ConfigStore(paths);
  const store = new MemoryStore();
  const capture = new Capture();
  let mode: ResponderMode = "auto";
  const wt = createWatchtower({
    config,
    httpUrl: anvil.http,
    wsUrl: anvil.ws,
    store,
    window: new MemoryWindowStore(),
    signer: privateKeySigner(BOT_KEY),
    mode: () => mode,
    approvalSecret: "e2e-approval-signing-key-0123456789abcdef",
    operators: `alice:${OperatorAuth.hash(OPERATOR_TOKEN)}`,
    approvalPort: 0,
    channels: [capture],
    pollMs: 100,
  });
  await wt.start();
  const client = createPublicClient({transport: http(anvil.http), pollingInterval: 100}) as PublicClient;
  const cfg = loadRuntimeConfig(paths);
  return {
    anvil,
    client,
    config,
    wt,
    store,
    capture,
    ops: {client, rpcUrl: anvil.http, book: cfg.book, deployment: cfg.book.deployment},
    token: cfg.book.token,
    setMode: (m) => (mode = m),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(what: string, f: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

export function wallet(anvil: Anvil, account: Account) {
  return createWalletClient({account, transport: http(anvil.http)});
}

export async function rpc(client: PublicClient, method: string, params: unknown[] = []) {
  return client.request({method: method as any, params: params as any});
}

export async function fund(client: PublicClient, a: Address) {
  await rpc(client, "anvil_setBalance", [a, toHex(10n ** 20n)]);
}

/** minter(Anvil 5)가 발행. R8 오탐을 피하려고 발행 요청을 먼저 기록한다. */
export async function mint(env: Env, to: Address, tokens: number) {
  await env.store.addMintRequest(to, units(tokens), "e2e", 0);
  const w = wallet(env.anvil, anvilAccount(5));
  const hash = await w.writeContract({address: env.token, abi: stableTokenAbi, functionName: "mint", args: [to, units(tokens)], chain: null});
  await env.client.waitForTransactionReceipt({hash});
}

export async function transfer(env: Env, from: Account, to: Address, tokens: number, opts: {wait?: boolean; nonce?: number} = {}) {
  const w = wallet(env.anvil, from);
  const hash = await w.writeContract({
    address: env.token,
    abi: stableTokenAbi,
    functionName: "transfer",
    args: [to, units(tokens)],
    chain: null,
    gas: 100_000n,
    nonce: opts.nonce,
  });
  if (opts.wait !== false) await env.client.waitForTransactionReceipt({hash});
  return hash;
}

export async function isFrozen(env: Env, a: Address): Promise<boolean> {
  return env.client.readContract({address: env.token, abi: stableTokenAbi, functionName: "isFrozen", args: [a]});
}

export async function frozenEvent(env: Env, a: Address) {
  const logs = await env.client.getLogs({address: env.token, fromBlock: 0n});
  return parseEventLogs({abi: stableTokenAbi, eventName: "Frozen", logs}).find((l) => lower(l.args.account) === lower(a));
}

export function readJson(p: string) {
  return JSON.parse(readFileSync(p, "utf8"));
}
