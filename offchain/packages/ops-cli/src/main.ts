#!/usr/bin/env node
// 운영 도구 (design.md 9장 회수 런북, docs/runbooks). Safe Transaction Builder JSON을 만든다.
// 서명과 제출은 사람이 Safe 앱에서 한다. --execute-local은 로컬 Anvil(31337)에서만 동작한다.
//
//   pnpm ops <command> [--chain sepolia] [--rpc URL] [--out file.json] [--execute-local]
//
//   case-id <사건 문자열>
//   case --case C [--account A ...]
//   wipe --case C --account A [--account B ...]
//   reissue --case C --to V --amount 1234.5
//   reconcile --case C
//   ledger --case C --kind reserve_released|reissued|note [--amount N] [--note text] --actor NAME
//   unfreeze --account A [...] --why "오탐: ..."
//   bot-revoke --bot B
//   bot-rotate --old O --new N
//   verify-roles [--bot B]
//   mint-request --to A --amount N --note REF   (R8 승인된 발행 요청 기록. DATABASE_URL 필요)
import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {parseArgs} from "node:util";
import {createPublicClient, formatUnits, http, parseUnits, type PublicClient} from "viem";
import {loadRuntimeConfig, TOKEN_DECIMALS, type Address} from "@stb/common";
import {
  caseIdOf,
  caseStatus,
  executeLocal,
  planBotRevoke,
  planBotRotate,
  planReissue,
  planUnfreeze,
  planWipe,
  reconcileCase,
  recordLedger,
  verifyRoles,
  type OpsContext,
  type SafeBatch,
} from "./ops";

const ROOT = resolve(import.meta.dirname, "../../../..");

const {values: v, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    chain: {type: "string", default: process.env.CHAIN ?? "anvil"},
    rpc: {type: "string"},
    case: {type: "string"},
    account: {type: "string", multiple: true},
    to: {type: "string"},
    amount: {type: "string"},
    why: {type: "string"},
    bot: {type: "string"},
    old: {type: "string"},
    new: {type: "string"},
    kind: {type: "string"},
    note: {type: "string"},
    actor: {type: "string"},
    out: {type: "string"},
    "execute-local": {type: "boolean", default: false},
  },
});

const fmt = (x: bigint) => `${formatUnits(x, TOKEN_DECIMALS)} STB`;
const need = <T>(x: T | undefined, name: string): T => {
  if (x === undefined || x === null || (Array.isArray(x) && x.length === 0)) throw new Error(`--${name} is required`);
  return x;
};

function context(): OpsContext {
  const cfg = loadRuntimeConfig({rules: resolve(ROOT, "config/rules.yaml"), addresses: resolve(ROOT, `config/addresses.${v.chain}.yaml`)});
  const prefix = v.chain === "sepolia" ? "SEPOLIA" : v.chain === "anvil" ? "ANVIL" : "CUSTOM_CHAIN";
  const rpcUrl = v.rpc ?? process.env[`${prefix}_RPC_URL`] ?? "http://127.0.0.1:8545";
  const client = createPublicClient({transport: http(rpcUrl)}) as PublicClient;
  return {client, rpcUrl, book: cfg.book, deployment: cfg.book.deployment};
}

async function emit(ctx: OpsContext, b: SafeBatch, label = "safe tx") {
  const json = JSON.stringify(b, null, 2);
  if (v.out) {
    writeFileSync(v.out, json);
    console.log(`${label}: wrote ${v.out} (Safe ${b.meta.createdFromSafeAddress}, ${b.transactions.length} tx)`);
  } else {
    console.log(json);
  }
  if (v["execute-local"]) {
    const hashes = await executeLocal(ctx, b);
    console.log(`executed on local anvil: ${hashes.join(", ")}`);
  }
}

async function main() {
  const [cmd, arg] = positionals;
  switch (cmd) {
    case "case-id":
      console.log(caseIdOf(need(arg, "case string")));
      return;
    case "case": {
      const ctx = context();
      const st = await caseStatus(ctx, caseIdOf(need(v.case, "case")), (v.account ?? []) as Address[]);
      console.log(`case ${st.caseId}\n  wiped     ${fmt(st.wiped)}\n  reissued  ${fmt(st.reissued)}\n  remaining ${fmt(st.remaining)} (재발행 가능액)`);
      for (const a of st.accounts) {
        console.log(`  ${a.address} frozen=${a.frozen} balance=${fmt(a.balance)}${a.wipeAvailableAt ? ` wipe available at ${new Date(a.wipeAvailableAt * 1000).toISOString()}` : ""}`);
      }
      return;
    }
    case "wipe": {
      const ctx = context();
      const {batch, total} = await planWipe(ctx, need(v.account, "account") as Address[], caseIdOf(need(v.case, "case")));
      console.error(`wipe total ${fmt(total)}`);
      await emit(ctx, batch, "recovery safe");
      return;
    }
    case "reissue": {
      const ctx = context();
      const amount = parseUnits(need(v.amount, "amount"), TOKEN_DECIMALS);
      const p = await planReissue(ctx, need(v.to, "to") as Address, amount, caseIdOf(need(v.case, "case")));
      console.error(`remaining reissuable before: ${fmt(p.remaining)}`);
      if (p.treasury) {
        console.error("minter allowance is insufficient: treasury Safe must run configureMinter first");
        await emit(ctx, p.treasury, "treasury safe");
      }
      await emit(ctx, p.minter, "minter");
      return;
    }
    case "reconcile": {
      const ctx = context();
      const r = await reconcileCase(ctx, caseIdOf(need(v.case, "case")));
      console.log(`case ${r.caseId}\n  wiped ${fmt(r.wiped)} (${r.wipedEvents.length} events)\n  reissued ${fmt(r.reissued)} (${r.reissuedEvents.length} events)`);
      console.log(`  events match on-chain totals: ${r.consistent}\n  reissued == wiped (closable): ${r.balanced}`);
      process.exitCode = r.consistent ? 0 : 2;
      return;
    }
    case "ledger": {
      const kind = need(v.kind, "kind") as "reserve_released" | "reissued" | "note";
      const path = resolve(ROOT, `ledger/${v.chain}.jsonl`);
      recordLedger(path, {
        caseId: caseIdOf(need(v.case, "case")),
        kind,
        amount: v.amount ? parseUnits(v.amount, TOKEN_DECIMALS) : undefined,
        note: v.note,
        actor: need(v.actor, "actor"),
      });
      console.log(`appended to ${path}`);
      return;
    }
    case "unfreeze": {
      const ctx = context();
      await emit(ctx, planUnfreeze(ctx, need(v.account, "account") as Address[], need(v.why, "why")), "ops safe");
      return;
    }
    case "bot-revoke": {
      const ctx = context();
      await emit(ctx, planBotRevoke(ctx, need(v.bot, "bot") as Address), "ops safe");
      return;
    }
    case "bot-rotate": {
      const ctx = context();
      await emit(ctx, planBotRotate(ctx, need(v.old, "old") as Address, need(v.new, "new") as Address), "ops safe");
      return;
    }
    case "verify-roles": {
      const ctx = context();
      const r = await verifyRoles(ctx, {bot: v.bot as Address | undefined});
      for (const [n, hs] of Object.entries(r.token)) console.log(`token ${n.padEnd(14)} ${hs.map((h) => ctx.book.label(h)).join(", ")}`);
      for (const [n, hs] of Object.entries(r.timelock)) console.log(`timelock ${n.padEnd(11)} ${hs.join(", ")}`);
      console.log(`ProxyAdmin owner ${ctx.book.label(r.proxyAdminOwner)}`);
      if (r.problems.length) {
        console.log("\nPROBLEMS:");
        for (const p of r.problems) console.log(`  - ${p}`);
        process.exitCode = 2;
      } else console.log("\nOK: 6장 권한 표와 일치");
      return;
    }
    case "mint-request": {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is required (watchtower의 Case Store에 기록한다)");
      const {Pool} = await import("pg");
      const {PgStore} = await import("@stb/detector");
      const pool = new Pool({connectionString: url});
      const store = new PgStore(pool);
      await store.migrate();
      await store.addMintRequest(need(v.to, "to") as Address, parseUnits(need(v.amount, "amount"), TOKEN_DECIMALS), need(v.note, "note"), Math.floor(Date.now() / 1000));
      await pool.end();
      console.log(`mint request recorded: ${v.to} ${v.amount} STB (${v.note})`);
      return;
    }
    default:
      console.error("usage: see header of packages/ops-cli/src/main.ts");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
});
