import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";
import type {Address, FreezeSink, Hex, Logger} from "@stb/common";
import {silentLogger} from "@stb/common";
import type {ApprovalTokens} from "./approval";
import {OperatorAuth} from "./approval";

export interface ApprovalStore {
  useApprovalToken(jti: string, caseKey: Hex, address: Address, usedBy: string, ts: number): Promise<boolean>;
  addAction(a: {caseKey: Hex; kind: string; actor: string; ts: number; data?: Record<string, unknown>}): Promise<void>;
}

export interface ApprovalServerDeps {
  tokens: ApprovalTokens;
  auth: OperatorAuth;
  store: ApprovalStore;
  freezer: FreezeSink;
  log?: Logger;
  /** 기본 127.0.0.1. 공개망에 직접 노출하지 않는다 (design.md 7.1). */
  host?: string;
  port?: number;
}

export interface ApprovalResult {
  status: number;
  body: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * 원클릭 동결 승인 엔드포인트. Responder 앞의 작은 HTTP 서비스.
 *
 * GET  /approve?case=..&token=..  확인 화면 (아무것도 바꾸지 않는다)
 * POST /approve                    case, token + 운영자 인증(Authorization: Bearer 또는 operator_token 필드)
 *
 * 만료·이미 사용·서명 오류·다른 사건의 토큰은 모두 거부한다. 승인하면 누가 언제 승인했는지
 * Case Store에 남기고 Responder에 동결(source = human)을 요청한다. 동결 외의 동작은 없다.
 */
export class ApprovalServer {
  private server: Server | undefined;
  private readonly log: Logger;

  constructor(private readonly d: ApprovalServerDeps) {
    this.log = d.log ?? silentLogger;
  }

  /** HTTP 없이 승인 처리 (테스트·CLI) */
  async approve(caseKey: string, token: string, operatorToken: string | undefined): Promise<ApprovalResult> {
    const operator = this.d.auth.identify(operatorToken);
    if (!operator) return {status: 401, body: "operator authentication required"};
    const v = this.d.tokens.verify(token, caseKey);
    if (!v.ok) return {status: v.error === "expired" ? 410 : 403, body: `invalid approval token: ${v.error}`};
    const {c, a, jti} = v.payload;
    const now = Math.floor(Date.now() / 1000);
    if (!(await this.d.store.useApprovalToken(jti, c, a, operator, now))) return {status: 409, body: "approval token already used"};
    await this.d.store.addAction({caseKey: c, kind: "freeze_approved", actor: operator, ts: now, data: {address: a, jti}});
    this.log.info("freeze approved", {caseKey: c, address: a, operator});
    await this.d.freezer.requestFreeze({caseKey: c, addresses: [a], source: "human", approvedBy: operator});
    return {status: 200, body: `freeze requested for ${a} (case ${c}) by ${operator}`};
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        this.log.error("approval server error", {err: String(err)});
        if (!res.headersSent) res.writeHead(500).end("internal error");
      });
    });
    await new Promise<void>((r) => this.server!.listen(this.d.port ?? 8787, this.d.host ?? "127.0.0.1", r));
    const addr = this.server.address() as AddressInfo;
    return `http://${addr.address}:${addr.port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname !== "/approve") return void res.writeHead(404).end("not found");
    if (req.method === "GET") {
      const c = url.searchParams.get("case") ?? "";
      const t = url.searchParams.get("token") ?? "";
      const v = this.d.tokens.verify(t, c);
      const what = v.ok ? `주소 ${esc(v.payload.a)} 동결 (사건 ${esc(c)})` : `유효하지 않은 링크: ${v.ok ? "" : v.error}`;
      res.writeHead(200, {"content-type": "text/html; charset=utf-8"});
      res.end(
        `<!doctype html><meta charset="utf-8"><title>동결 승인</title><h1>동결 승인</h1><p>${what}</p>` +
          (v.ok
            ? `<form method="post"><input type="hidden" name="case" value="${esc(c)}"><input type="hidden" name="token" value="${esc(t)}">` +
              `<label>운영자 토큰 <input type="password" name="operator_token" autocomplete="off"></label> <button>동결 승인</button></form>`
            : ""),
      );
      return;
    }
    if (req.method !== "POST") return void res.writeHead(405).end("method not allowed");
    const body = await readBody(req);
    const ct = String(req.headers["content-type"] ?? "");
    const p = ct.includes("application/json") ? JSON.parse(body || "{}") : Object.fromEntries(new URLSearchParams(body));
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    const r = await this.approve(String(p.case ?? ""), String(p.token ?? ""), bearer ?? p.operator_token);
    res.writeHead(r.status, {"content-type": "text/plain; charset=utf-8"}).end(r.body);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      s += c;
      if (s.length > 16_384) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

export {OperatorAuth};
