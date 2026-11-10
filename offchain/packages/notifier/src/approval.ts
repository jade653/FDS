import {createHash, createHmac, randomBytes, timingSafeEqual} from "node:crypto";
import type {Address, ApprovalIssuer, Hex} from "@stb/common";
import {lower} from "@stb/common";

/**
 * 원클릭 동결 승인 링크의 서명 토큰 (design.md 7.1 Notifier).
 * 토큰 = base64url(payload) + "." + base64url(HMAC-SHA256(secret, base64url(payload)))
 * payload = {v, c: 사건 번호, a: 대상 주소, exp: 만료(초), jti: 1회용 id}
 * 1회용은 Case Store의 approval_tokens가 강제한다 (ApprovalServer).
 */
export interface ApprovalPayload {
  v: 1;
  c: Hex;
  a: Address;
  exp: number;
  jti: string;
}

export type VerifyError = "malformed" | "bad_signature" | "expired" | "wrong_case";

export class ApprovalTokens implements ApprovalIssuer {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly opts: {baseUrl: () => string; ttlSec: () => number; now?: () => number},
  ) {
    if (Buffer.byteLength(secret) < 32) throw new Error("APPROVAL_SIGNING_KEY must be at least 32 bytes");
    this.key = Buffer.from(secret);
  }

  private now() {
    return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000);
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }

  token(caseKey: Hex, address: Address): string {
    const p: ApprovalPayload = {v: 1, c: caseKey, a: lower(address), exp: this.now() + this.opts.ttlSec(), jti: randomBytes(16).toString("hex")};
    const body = Buffer.from(JSON.stringify(p)).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  issue(caseKey: Hex, address: Address): string {
    const u = new URL("/approve", this.opts.baseUrl());
    u.searchParams.set("case", caseKey);
    u.searchParams.set("token", this.token(caseKey, address));
    return u.toString();
  }

  /** 서명·만료·사건 일치를 본다. 1회용 여부는 호출자가 저장소로 확인한다. */
  verify(token: string, expectedCase: string): {ok: true; payload: ApprovalPayload} | {ok: false; error: VerifyError} {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return {ok: false, error: "malformed"};
    const [body, sig] = parts;
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return {ok: false, error: "bad_signature"};
    let p: ApprovalPayload;
    try {
      p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return {ok: false, error: "malformed"};
    }
    if (p.v !== 1 || typeof p.jti !== "string" || typeof p.exp !== "number") return {ok: false, error: "malformed"};
    if (p.exp < this.now()) return {ok: false, error: "expired"};
    if (lower(p.c) !== lower(expectedCase)) return {ok: false, error: "wrong_case"};
    return {ok: true, payload: p};
  }
}

/**
 * 운영자 인증. APPROVAL_OPERATORS="alice:<sha256(token) hex>,bob:<...>"
 * 운영자 토큰 원문은 저장하지 않고 해시만 둔다.
 */
export class OperatorAuth {
  private readonly ops: {name: string; hash: Buffer}[];

  constructor(spec: string) {
    this.ops = spec
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [name, hex] = s.split(":");
        if (!name || !/^[0-9a-f]{64}$/i.test(hex ?? "")) throw new Error(`invalid operator entry: ${name}`);
        return {name, hash: Buffer.from(hex, "hex")};
      });
  }

  static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /** 맞는 운영자 이름, 없으면 null */
  identify(token: string | undefined): string | null {
    if (!token) return null;
    const h = createHash("sha256").update(token).digest();
    let found: string | null = null;
    for (const o of this.ops) if (timingSafeEqual(o.hash, h)) found = o.name;
    return found;
  }
}
