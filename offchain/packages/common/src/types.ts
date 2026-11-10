import type {Address, Hex} from "viem";

export type {Address, Hex};

export type RuleId = "R1" | "R1b" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10";
export const SCORING_RULES: RuleId[] = ["R1", "R1b", "R2", "R3", "R4", "R5", "R6", "R9", "R10"];

/** design.md 8.1 표의 주소 분류. 우선순위: protected > whitelabel > hot > normal */
export type Category = "protected" | "hot" | "whitelabel" | "normal";

export type Decision = "auto_freeze" | "human_review" | "record";

export type Severity = "critical" | "warning" | "info";

export interface Alert {
  severity: Severity;
  kind: string;
  title: string;
  lines: string[];
  caseKey?: Hex;
  approvalLinks?: {address: Address; url: string}[];
}

export interface AlertSink {
  alert(a: Alert): Promise<void>;
}

/** Decision → Responder 요청 (design.md 8.2 1단계). */
export interface FreezeRequest {
  caseKey: Hex;
  addresses: Address[];
  /** `auto`는 봇 자동 동결, `human`은 원클릭 승인 */
  source: "auto" | "human";
  approvedBy?: string;
  evidence?: string;
}

export interface FreezeSink {
  requestFreeze(req: FreezeRequest): Promise<void>;
}

export const lower = (a: string): Address => a.toLowerCase() as Address;

/** 원클릭 동결 승인 링크 발급 (design.md 7.1 Notifier). 구현은 notifier 패키지. */
export interface ApprovalIssuer {
  issue(caseKey: Hex, address: Address): string;
}
