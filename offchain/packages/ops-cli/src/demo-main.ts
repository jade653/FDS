#!/usr/bin/env node
// 실제 체인 시연 CLI (design.md 12장 1b·2·4). 감시탑은 별도 터미널에서 돌린다.
//
//   node node_modules/tsx/dist/cli.mjs packages/ops-cli/src/demo-main.ts <command> [--chain sepolia] [--round 0]
//
//   init                      시연 지갑(DEMO_MNEMONIC)·승인 키를 .env에 만들고(비어 있을 때만) 주소 분류 파일을 쓴다
//   status                    회차 지갑의 ETH·STB 잔고와 동결 여부
//   mint-plan --out f.json    발행 Safe가 실행할 발행 배치 (Safe 앱 Transaction Builder에서 불러와 서명)
//   fund                      funder → 회차 지갑 가스 배분 (funder에 Sepolia ETH가 있어야 한다)
//   run --scenario 1b|2|4     시나리오 실행. 감시탑이 auto 모드로 돌고 있어야 동결된다
//
// 비밀값(니모닉, 승인 키, 운영자 토큰)은 화면에 출력하지 않는다. 운영자 토큰 원문은 저장소 밖 파일에만 쓴다.
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, relative, resolve} from "node:path";
import {parseArgs} from "node:util";
import {randomBytes, createHash} from "node:crypto";
import {createPublicClient, createWalletClient, http, type Account, type PublicClient} from "viem";
import {english, generateMnemonic} from "viem/accounts";
import {loadRuntimeConfig, type Address} from "@stb/common";
import {
  demoActors,
  demoAddressesYaml,
  demoFund,
  demoMintPlan,
  demoStatus,
  scenario1b,
  scenario2,
  scenario4,
  setEnvIfEmpty,
  type DemoChain,
} from "./demo";
import {PreconditionError} from "./ops";

const ROOT = resolve(import.meta.dirname, "../../../..");
const ENV_PATH = resolve(ROOT, ".env");

const {values: v, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    chain: {type: "string", default: process.env.CHAIN ?? "sepolia"},
    round: {type: "string", default: "0"},
    scenario: {type: "string"},
    out: {type: "string"},
  },
});

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

function readEnvFile(): string[] {
  return existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
}

function loadDotEnv() {
  for (const line of readEnvFile()) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function init() {
  const lines = readEnvFile();
  if (!lines.length) throw new Error(`${ENV_PATH} not found: .env.example을 복사해 만든다`);
  const changed: string[] = [];
  if (!lines.some((l) => /^\s*#\s*--- 시연/.test(l)) && !lines.some((l) => /^\s*DEMO_MNEMONIC\s*=/.test(l))) {
    lines.push("", "# --- 시연 (packages/ops-cli/src/demo-main.ts). 테스트넷 전용 키 ---");
  }
  if (setEnvIfEmpty(lines, "DEMO_MNEMONIC", generateMnemonic(english))) changed.push("DEMO_MNEMONIC");
  if (setEnvIfEmpty(lines, "APPROVAL_SIGNING_KEY", randomBytes(32).toString("hex"))) changed.push("APPROVAL_SIGNING_KEY");
  const tokenFile = process.env.DEMO_OPERATOR_TOKEN_FILE ?? resolve(homedir(), ".stb-keys", "operator-token.txt");
  const opsLine = lines.find((l) => /^\s*APPROVAL_OPERATORS\s*=/.test(l));
  if (!opsLine || opsLine.split("=").slice(1).join("=").trim() === "") {
    const token = randomBytes(24).toString("base64url");
    mkdirSync(dirname(tokenFile), {recursive: true});
    writeFileSync(tokenFile, token + "\n", {mode: 0o600});
    setEnvIfEmpty(lines, "APPROVAL_OPERATORS", `operator:${createHash("sha256").update(token).digest("hex")}`);
    changed.push(`APPROVAL_OPERATORS (운영자 토큰 원문: ${tokenFile})`);
  }
  writeFileSync(ENV_PATH, lines.join("\n"));
  console.log(changed.length ? `.env updated: ${changed.join(", ")}` : ".env: 시연 항목이 이미 있어 바꾸지 않았다");

  // 값을 다시 읽는다 (방금 쓴 값 포함).
  for (const k of ["DEMO_MNEMONIC", "APPROVAL_SIGNING_KEY", "APPROVAL_OPERATORS"]) delete process.env[k];
  loadDotEnv();
  const mnemonic = need("DEMO_MNEMONIC");
  const addrPath = resolve(ROOT, `config/addresses.${v.chain}.yaml`);
  const old = existsSync(addrPath) ? readFileSync(addrPath, "utf8") : "";
  const deployment = /^deployment:\s*(.+)$/m.exec(old)?.[1]?.replace(/^["']|["']$/g, "") ?? `../deployments/${v.chain}.json`;
  const chainId = Number(/^chain_id:\s*(\d+)/m.exec(old)?.[1] ?? 0);
  if (!chainId) throw new Error(`${addrPath}: chain_id not found`);
  const bot = /^bot:\s*"?(0x[0-9a-fA-F]{40})"?/m.exec(old)?.[1] as Address | undefined;
  writeFileSync(addrPath, demoAddressesYaml({chainId, deployment, mnemonic, bot}));
  console.log(`wrote ${relative(ROOT, addrPath)} (hot·watched·whitelabel for ${3} rounds)`);
  const a = demoActors(mnemonic, 0);
  console.log(`\nfunder (가스 배분용, 여기에 Sepolia ETH를 보낸다): ${a.funder.address}`);
}

// ---------------------------------------------------------------------------
// 실행 환경
// ---------------------------------------------------------------------------

function need(k: string): string {
  const x = process.env[k];
  if (!x) throw new Error(`missing env ${k}: demo init을 먼저 실행`);
  return x;
}

function chain(): {c: DemoChain; ctx: Parameters<typeof demoMintPlan>[0]; explorer: (tx: string) => string} {
  const cfg = loadRuntimeConfig({rules: resolve(ROOT, "config/rules.yaml"), addresses: resolve(ROOT, `config/addresses.${v.chain}.yaml`)});
  const prefix = v.chain === "sepolia" ? "SEPOLIA" : v.chain === "anvil" ? "ANVIL" : "CUSTOM_CHAIN";
  const rpcUrl = process.env[`${prefix}_RPC_URL`] || (v.chain === "anvil" ? "http://127.0.0.1:8545" : need(`${prefix}_RPC_URL`));
  const client = createPublicClient({transport: http(rpcUrl)}) as PublicClient;
  const slow = v.chain !== "anvil";
  const c: DemoChain = {
    client,
    wallet: (account: Account) => createWalletClient({account, transport: http(rpcUrl)}),
    token: cfg.book.token,
    timeoutMs: slow ? 300_000 : 30_000,
    pollMs: slow ? 3_000 : 200,
    log: (l) => console.log(l),
  };
  const explorer = (tx: string) => (v.chain === "sepolia" ? `https://sepolia.etherscan.io/tx/${tx}` : tx);
  return {c, ctx: {client, rpcUrl, book: cfg.book, deployment: cfg.book.deployment}, explorer};
}

async function checkChain(c: DemoChain, want: number) {
  const got = await c.client.getChainId();
  if (got !== want) throw new Error(`RPC chain id ${got} != config chain_id ${want}`);
}

async function main() {
  loadDotEnv();
  const [cmd] = positionals;
  if (cmd === "init") return init();

  const round = Number(v.round);
  const actors = demoActors(need("DEMO_MNEMONIC"), round);
  const {c, ctx, explorer} = chain();
  await checkChain(c, ctx.book.chainId);

  switch (cmd) {
    case "status": {
      console.log(`round ${round}, token ${c.token}`);
      for (const r of await demoStatus(c, actors)) {
        console.log(`  ${r.role.padEnd(10)} ${r.address}  ${r.eth.padStart(12)} ETH  ${r.stb.padStart(10)} STB  ${r.frozen ? "FROZEN" : ""}`);
      }
      return;
    }
    case "mint-plan": {
      const b = await demoMintPlan(ctx, actors);
      const out = v.out ?? resolve(ROOT, `demo-mint-${v.chain}-r${round}.json`);
      writeFileSync(out, JSON.stringify(b, null, 2));
      console.log(`wrote ${out}`);
      console.log(`발행 Safe ${b.meta.createdFromSafeAddress}에서 Transaction Builder로 불러와 서명·실행한다 (1/2 정족수).`);
      return;
    }
    case "fund": {
      const bal = await c.client.getBalance({address: actors.funder.address});
      if (bal === 0n) throw new PreconditionError(`funder ${actors.funder.address} has no ETH: Sepolia ETH를 보낸 뒤 다시 실행`);
      await demoFund(c, actors);
      return;
    }
    case "run": {
      const s = v.scenario;
      if (s === "1b") {
        console.log(`시나리오 1b (round ${round}): 핫월렛 탈취 → 자동 동결`);
        const r = await scenario1b(c, actors);
        console.log(`  결과: 공격자 동결 +${r.attacker.blocksAfterOutflow}블록, 핫월렛 동결 +${r.hot.blocksAfterOutflow}블록, ${r.secondsToBothFrozen}초`);
        console.log(`  유출 tx ${explorer(r.outflowTx)}\n  동결 tx ${explorer(r.attacker.freezeTx)}`);
        console.log(`  공격자 잔고 ${r.attackerBalance} STB (동결되어 이동 불가)`);
      } else if (s === "2") {
        console.log(`시나리오 2 (round ${round}): 분산 송금 세탁 → 공격자 자동 동결, 수신 주소는 원클릭 승인`);
        const r = await scenario2(c, actors);
        console.log(`  결과: 첫 분산 송금 후 +${r.attacker.blocksAfterFirstSplit}블록에 동결. 분산 송금 ${r.splits.sent}건 중 성공 ${r.splits.succeeded}, 실패 ${r.splits.reverted}`);
        console.log(`  공격자에 남은 금액 ${r.stillWithAttacker} STB (동결), 빠져나간 금액 ${r.launderedOut} STB`);
        console.log(`  동결 tx ${explorer(r.attacker.freezeTx)}`);
        console.log(`  수신 주소 동결은 감시탑 콘솔의 related_addresses 알림 링크로 승인한다`);
      } else if (s === "4") {
        console.log(`시나리오 4 (round ${round}): 파트너 → 거래소 대량 송금 (오탐 방지)`);
        const r = await scenario4(c, actors);
        console.log(`  결과: ${r.waitedBlocks}블록 대기, 파트너 동결=${r.partnerFrozen}, 거래소 동결=${r.exchangeFrozen} (둘 다 false가 정상)`);
        console.log(`  송금 tx ${explorer(r.tx)}\n  감시탑 콘솔에 사람 확인 알림(R1)이 떠야 한다`);
        if (r.partnerFrozen || r.exchangeFrozen) process.exitCode = 2;
      } else {
        throw new Error("--scenario 1b|2|4");
      }
      return;
    }
    default:
      console.error("usage: see header of packages/ops-cli/src/demo-main.ts");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
});
