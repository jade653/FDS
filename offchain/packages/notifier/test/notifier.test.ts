import {describe, expect, it} from "vitest";
import type {Address, FreezeRequest, Hex} from "@stb/common";
import {MemoryStore} from "@stb/detector";
import {ApprovalTokens, OperatorAuth} from "../src/approval";
import {formatAlert, Notifier, SlackChannel, TelegramChannel, type Channel} from "../src/notifier";
import {ApprovalServer} from "../src/server";

const SECRET = "x".repeat(40);
const CASE = ("0x" + "aa".repeat(32)) as Hex;
const OTHER = ("0x" + "bb".repeat(32)) as Hex;
const ADDR = "0x00000000000000000000000000000000000000a1" as Address;

function setup(now = {t: 1_700_000_000}) {
  const tokens = new ApprovalTokens(SECRET, {baseUrl: () => "http://127.0.0.1:0", ttlSec: () => 3600, now: () => now.t});
  const store = new MemoryStore();
  const freezes: FreezeRequest[] = [];
  const auth = new OperatorAuth(`alice:${OperatorAuth.hash("alice-secret")},bob:${OperatorAuth.hash("bob-secret")}`);
  const server = new ApprovalServer({tokens, auth, store, freezer: {requestFreeze: async (r) => void freezes.push(r)}, port: 0});
  return {tokens, store, freezes, server, now};
}

// design.md 12장: 만료된 토큰, 이미 쓴 토큰, 서명이 깨진 토큰, 다른 사건의 토큰은 모두 거부
describe("승인 링크", () => {
  it("정상 토큰은 승인되고 동결 요청(source = human, 승인자 기록)이 나간다", async () => {
    const t = setup();
    const r = await t.server.approve(CASE, t.tokens.token(CASE, ADDR), "alice-secret");
    expect(r.status).toBe(200);
    expect(t.freezes).toEqual([{caseKey: CASE, addresses: [ADDR], source: "human", approvedBy: "alice"}]);
    const acts = await t.store.actions(CASE);
    expect(acts[0]).toMatchObject({kind: "freeze_approved", actor: "alice"});
  });

  it("만료된 토큰은 거부 (410)", async () => {
    const t = setup();
    const tok = t.tokens.token(CASE, ADDR);
    t.now.t += 3601;
    expect((await t.server.approve(CASE, tok, "alice-secret")).status).toBe(410);
    expect(t.freezes).toHaveLength(0);
  });

  it("이미 쓴 토큰은 거부 (409), 다른 운영자라도", async () => {
    const t = setup();
    const tok = t.tokens.token(CASE, ADDR);
    expect((await t.server.approve(CASE, tok, "alice-secret")).status).toBe(200);
    expect((await t.server.approve(CASE, tok, "bob-secret")).status).toBe(409);
    expect(t.freezes).toHaveLength(1);
  });

  it("서명이 깨진 토큰은 거부 (403)", async () => {
    const t = setup();
    const tok = t.tokens.token(CASE, ADDR);
    const [body, sig] = tok.split(".");
    const tamperedBody = Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(body, "base64url").toString()), a: "0x00000000000000000000000000000000000000ff"})).toString("base64url");
    expect((await t.server.approve(CASE, `${tamperedBody}.${sig}`, "alice-secret")).body).toContain("bad_signature");
    expect((await t.server.approve(CASE, `${body}.${sig.slice(0, -2)}xx`, "alice-secret")).status).toBe(403);
    expect((await t.server.approve(CASE, "garbage", "alice-secret")).body).toContain("malformed");
    const otherKey = new ApprovalTokens("y".repeat(40), {baseUrl: () => "http://x", ttlSec: () => 3600});
    expect((await t.server.approve(CASE, otherKey.token(CASE, ADDR), "alice-secret")).body).toContain("bad_signature");
    expect(t.freezes).toHaveLength(0);
  });

  it("다른 사건의 토큰은 거부 (403)", async () => {
    const t = setup();
    expect((await t.server.approve(OTHER, t.tokens.token(CASE, ADDR), "alice-secret")).body).toContain("wrong_case");
    expect(t.freezes).toHaveLength(0);
  });

  it("인증되지 않은 운영자는 거부 (401)하고 토큰을 소모하지 않는다", async () => {
    const t = setup();
    const tok = t.tokens.token(CASE, ADDR);
    expect((await t.server.approve(CASE, tok, undefined)).status).toBe(401);
    expect((await t.server.approve(CASE, tok, "wrong")).status).toBe(401);
    expect((await t.server.approve(CASE, tok, "bob-secret")).status).toBe(200);
  });

  it("짧은 서명 키는 받지 않는다", () => {
    expect(() => new ApprovalTokens("short", {baseUrl: () => "http://x", ttlSec: () => 1})).toThrow();
  });
});

describe("승인 HTTP 서버", () => {
  it("GET은 확인 화면만, POST(Bearer)로 승인, 127.0.0.1에만 바인딩", async () => {
    const t = setup({t: Math.floor(Date.now() / 1000)});
    const base = await t.server.listen();
    expect(base.startsWith("http://127.0.0.1:")).toBe(true);
    try {
      const tok = t.tokens.token(CASE, ADDR);
      const page = await fetch(`${base}/approve?case=${CASE}&token=${encodeURIComponent(tok)}`);
      expect(await page.text()).toContain(ADDR);
      expect(t.freezes).toHaveLength(0);

      const res = await fetch(`${base}/approve`, {
        method: "POST",
        headers: {authorization: "Bearer bob-secret", "content-type": "application/x-www-form-urlencoded"},
        body: new URLSearchParams({case: CASE, token: tok}).toString(),
      });
      expect(res.status).toBe(200);
      expect(t.freezes[0].approvedBy).toBe("bob");

      const again = await fetch(`${base}/approve`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({case: CASE, token: tok, operator_token: "alice-secret"}),
      });
      expect(again.status).toBe(409);
    } finally {
      await t.server.close();
    }
  });
});

describe("Notifier", () => {
  it("모든 채널로 보내고, 한 채널이 실패해도 나머지는 보낸다", async () => {
    const got: string[] = [];
    const ok: Channel = {name: "ok", send: async (_a, text) => void got.push(text)};
    const bad: Channel = {name: "bad", send: async () => Promise.reject(new Error("down"))};
    const n = new Notifier({channels: [bad, ok]});
    await n.alert({severity: "critical", kind: "R7", title: "t", lines: ["l1"], caseKey: CASE, approvalLinks: [{address: ADDR, url: "http://u"}]});
    expect(got[0]).toContain("[CRITICAL] t");
    expect(got[0]).toContain("http://u");
    expect(n.history).toHaveLength(1);
  });

  it("Slack·Telegram 형식", async () => {
    const calls: {url: string; body: any}[] = [];
    const f = (async (url: string, init: any) => {
      calls.push({url, body: JSON.parse(init.body)});
      return {ok: true, status: 200} as Response;
    }) as unknown as typeof fetch;
    const a = {severity: "info" as const, kind: "k", title: "hello", lines: []};
    await new SlackChannel("https://hooks.example/x", f).send(a, formatAlert(a));
    await new TelegramChannel("TOKEN", "42", f).send(a, formatAlert(a));
    expect(calls[0].body.text).toContain("hello");
    expect(calls[1].url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(calls[1].body.chat_id).toBe("42");
  });
});
