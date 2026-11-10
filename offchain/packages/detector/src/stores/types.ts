import type {Address, Decision, Hex, RuleId} from "@stb/common";

/** 룰 발동 한 건. id가 같으면 같은 발동이다 (멱등). */
export interface HitRecord {
  id: string;
  address: Address;
  rule: RuleId;
  points: number;
  ts: number;
  blockNumber: bigint | null;
  txHash: Hex | null;
  detail: string;
}

export interface SeriesItem {
  member: string;
  ts: number;
  value: bigint;
  block: bigint | null;
  /** 부가 정보 (예: 수신 주소) */
  ref?: string;
}

export interface ScoreResult {
  score: number;
  rules: RuleId[];
  hits: HitRecord[];
}

/**
 * 슬라이딩 윈도우 집계 (design.md 7.1 Rule Engine: Redis sorted set).
 * 점수는 윈도우 안에서 발동한 룰별 점수의 합이다. 같은 룰이 여러 번 발동해도 한 번만 센다.
 */
export interface WindowStore {
  addHit(h: HitRecord): Promise<void>;
  score(address: Address, now: number, windowSec: number): Promise<ScoreResult>;
  addSeries(key: string, item: SeriesItem): Promise<void>;
  series(key: string, fromTs: number): Promise<SeriesItem[]>;
  /** 재조직: 이 블록 이상에서 생긴 항목을 지운다. */
  removeFromBlock(block: bigint): Promise<void>;
  prune(beforeTs: number): Promise<void>;
}

export interface AddressInfo {
  address: Address;
  firstSeenTs: number;
  firstSeenBlock: bigint;
  txCount: number;
  /** 마지막으로 센 이벤트 위치. 같은 이벤트를 두 번 세지 않으려고 둔다. */
  lastPos: string;
  /** 첫 조회 시 RPC로 읽은 체인 nonce */
  nonce: number | null;
  frozen: boolean;
}

export interface AddressStore {
  getAddress(a: Address): Promise<AddressInfo | undefined>;
  putAddress(info: AddressInfo): Promise<void>;
}

export interface Cursor {
  block: bigint;
  hash: Hex;
}

export interface CursorStore {
  getCursor(): Promise<Cursor | undefined>;
  setCursor(c: Cursor): Promise<void>;
  getBlockHash(block: bigint): Promise<Hex | undefined>;
  setBlockHash(block: bigint, hash: Hex): Promise<void>;
  pruneBlockHashes(belowBlock: bigint): Promise<void>;
  /** 작은 상태 값 (예: 배포 완료 표시) */
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
}

export type CaseStatus = "open" | "closed" | "false_positive";

export interface CaseRecord {
  caseKey: Hex;
  caseString: string;
  status: CaseStatus;
  needsReview: boolean;
  createdTs: number;
  updatedTs: number;
  addresses: {address: Address; decision: Decision | "related"; score: number}[];
}

export interface ActionRecord {
  caseKey: Hex;
  kind: string;
  actor: string;
  txHash?: Hex | null;
  ts: number;
  data?: Record<string, unknown>;
}

/** 사건 기록 (design.md 7.1 Case Store, 9장 회수 런북). */
export interface CaseStore {
  recordHit(h: HitRecord, caseKey: Hex | null): Promise<void>;
  hitsFor(address: Address): Promise<HitRecord[]>;
  /** 열린 사건 중 주소들 중 하나라도 포함한 사건 */
  findOpenCase(addresses: Address[], sinceTs: number): Promise<CaseRecord | undefined>;
  createCase(caseKey: Hex, caseString: string, ts: number): Promise<CaseRecord>;
  getCase(caseKey: Hex): Promise<CaseRecord | undefined>;
  listCases(): Promise<CaseRecord[]>;
  /**
   * 주소의 결정을 기록한다. 더 높은 결정으로 올라갈 때만 true (알림·동결 요청을 한 번만 보내기 위해).
   * 순서: record < related < human_review < auto_freeze
   */
  setDecision(caseKey: Hex, address: Address, decision: Decision | "related", score: number, ts: number): Promise<boolean>;
  addAction(a: ActionRecord): Promise<void>;
  actions(caseKey: Hex): Promise<ActionRecord[]>;
  countActionsSince(kind: string, sinceTs: number): Promise<number>;
  setStatus(caseKey: Hex, status: CaseStatus, ts: number): Promise<void>;
  /** 재조직으로 근거가 사라진 사건을 재검토 대상으로 표시한다. 표시한 사건 키를 돌려준다. */
  markReorged(fromBlock: bigint): Promise<Hex[]>;
  /** 승인 링크 1회용 처리. 처음 쓰면 true. */
  useApprovalToken(jti: string, caseKey: Hex, address: Address, usedBy: string, ts: number): Promise<boolean>;
  addMintRequest(to: Address, amount: bigint, ref: string, ts: number): Promise<void>;
  /** 같은 수신자·금액의 미사용 발행 요청을 하나 소비한다. 있으면(또는 이 이벤트가 이미 소비했으면) true. */
  consumeMintRequest(to: Address, amount: bigint, eventRef: string): Promise<boolean>;
}

export type Store = CaseStore & AddressStore & CursorStore;

export const DECISION_RANK: Record<Decision | "related", number> = {
  record: 0,
  related: 1,
  human_review: 2,
  auto_freeze: 3,
};
