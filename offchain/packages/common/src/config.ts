import {readFileSync, watch, type FSWatcher} from "node:fs";
import {dirname, resolve} from "node:path";
import {EventEmitter} from "node:events";
import {parse as parseYaml} from "yaml";
import {z} from "zod";
import {getAddress, isAddress, parseUnits} from "viem";
import type {Address, Category} from "./types";
import {lower} from "./types";

export const TOKEN_DECIMALS = 6;
/** 토큰 단위(소수점 적용 전) → 최소 단위. 설정 파일의 수량은 모두 토큰 단위다 (design.md 10장). */
export const units = (n: number): bigint => parseUnits(String(n), TOKEN_DECIMALS);

// ---------------------------------------------------------------------------
// rules.yaml
// ---------------------------------------------------------------------------

const scoreRule = z.object({enabled: z.boolean(), score: z.number().int().nonnegative()});
const flagRule = z.object({enabled: z.boolean()});
const pos = () => z.number().positive();

export const rulesSchema = z.object({
  window_minutes: pos(),
  thresholds: z
    .object({auto_freeze: pos(), human_review: pos()})
    .refine((t) => t.human_review < t.auto_freeze, "human_review must be below auto_freeze"),
  rules: z.object({
    R1: scoreRule.extend({window_minutes: pos(), balance_pct: z.number().positive().max(100), abs_amount: pos()}),
    R1b: scoreRule,
    R2: scoreRule.extend({
      min_amount: pos(),
      new_address_max_age_hours: pos(),
      new_address_max_nonce: z.number().int().nonnegative(),
    }),
    R3: scoreRule.extend({window_minutes: pos(), min_new_recipients: z.number().int().positive()}),
    R4: scoreRule.extend({window_minutes: pos(), min_watched_sources: z.number().int().min(2)}),
    R5: scoreRule.extend({window_minutes: pos(), large_inflow_amount: pos()}),
    R6: scoreRule,
    R7: flagRule,
    R8: flagRule,
    R9: scoreRule.extend({lists: z.array(z.string())}),
    R10: scoreRule,
  }),
  ingestor: z.object({
    lag_alert_blocks: z.number().int().positive(),
    poll_interval_ms: z.number().int().positive(),
    reorg_depth: z.number().int().positive(),
    pending: z.boolean(),
    /** pending 거래 조회 초당 상한. 넘치는 해시는 버린다 (공개 RPC 요청 한도 보호) */
    pending_fetch_per_sec: z.number().positive().default(5),
  }),
  responder: z.object({
    kill_switch: z.boolean(),
    max_auto_freezes_per_hour: z.number().int().positive(),
    submit_route: z.enum(["private_first", "public_only", "both"]),
    priority_fee_multiplier: pos(),
    min_priority_fee_gwei: z.number().nonnegative(),
    max_priority_fee_gwei: pos(),
    resend_after_blocks: z.number().int().positive(),
    resend_max: z.number().int().nonnegative(),
    batch_max: z.number().int().positive().max(50),
    gas_alert_freezes: z.number().int().positive(),
    freeze_gas_estimate: z.number().int().positive(),
  }),
  approval: z.object({link_ttl_minutes: pos(), base_url: z.string().url()}),
  monitor: z.object({bot_freezes_per_hour_alert: z.number().int().positive()}),
  notifier: z.object({
    channels: z.array(
      z.discriminatedUnion("type", [
        z.object({type: z.literal("console")}),
        z.object({type: z.literal("slack"), webhook_url_env: z.string()}),
        z.object({type: z.literal("webhook"), url_env: z.string()}),
        z.object({type: z.literal("telegram"), bot_token_env: z.string(), chat_id_env: z.string()}),
      ]),
    ),
  }),
});

export type RulesConfig = z.infer<typeof rulesSchema>;

// ---------------------------------------------------------------------------
// addresses.<chain>.yaml + deployments/<chain>.json
// ---------------------------------------------------------------------------

const addr = z.string().refine((s) => isAddress(s, {strict: false}), "invalid address");
const entry = z.object({address: addr, label: z.string().default("")});

export const addressesSchema = z.object({
  chain_id: z.number().int().positive(),
  deployment: z.string(),
  /** 봇 키를 교체했으면 현재 봇 주소. 없으면 deployment.bot (docs/runbooks/bot-key-rotation.md) */
  bot: addr.optional(),
  watched: z.array(entry).default([]),
  hot: z.array(entry).default([]),
  protected: z.array(entry).default([]),
  whitelabel: z.array(entry).default([]),
  exits: z.array(entry).default([]),
});

export const deploymentSchema = z.object({
  chainId: z.number().int(),
  startBlock: z.number().int().nonnegative(),
  token: addr,
  implementation: addr,
  proxyAdmin: addr,
  timelock: addr,
  deployer: addr,
  governanceSafe: addr,
  opsSafe: addr,
  recoverySafe: addr,
  treasurySafe: addr,
  minter: addr,
  bot: addr,
  protected: z.array(addr),
  minFreezeAge: z.number().int().nonnegative(),
  timelockDelay: z.number().int().nonnegative(),
});

export type AddressesConfig = z.infer<typeof addressesSchema>;
export type DeploymentInfo = z.infer<typeof deploymentSchema>;

/** 주소 분류 조회. 모든 키는 소문자. */
export class AddressBook {
  readonly token: Address;
  readonly timelock: Address;
  readonly proxyAdmin: Address;
  readonly opsSafe: Address;
  readonly deployer: Address;
  readonly bot: Address;
  readonly chainId: number;
  private readonly protectedSet = new Set<Address>();
  private readonly hotSet = new Set<Address>();
  private readonly watchedSet = new Set<Address>();
  private readonly whitelabelSet = new Set<Address>();
  private readonly exitSet = new Set<Address>();
  private readonly labels = new Map<Address, string>();

  constructor(
    readonly addresses: AddressesConfig,
    readonly deployment: DeploymentInfo,
  ) {
    if (addresses.chain_id !== deployment.chainId) {
      throw new Error(`chain_id ${addresses.chain_id} does not match deployment ${deployment.chainId}`);
    }
    this.chainId = deployment.chainId;
    this.token = lower(deployment.token);
    this.timelock = lower(deployment.timelock);
    this.proxyAdmin = lower(deployment.proxyAdmin);
    this.opsSafe = lower(deployment.opsSafe);
    this.deployer = lower(deployment.deployer);
    this.bot = lower(addresses.bot ?? deployment.bot);

    const label = (a: string, l: string) => {
      if (l && !this.labels.has(lower(a))) this.labels.set(lower(a), l);
    };
    for (const a of deployment.protected) this.protectedSet.add(lower(a));
    for (const [k, l] of [
      ["timelock", deployment.timelock],
      ["token", deployment.token],
      ["governance-safe", deployment.governanceSafe],
      ["ops-safe", deployment.opsSafe],
      ["recovery-safe", deployment.recoverySafe],
      ["treasury-safe", deployment.treasurySafe],
      ["minter", deployment.minter],
      ["bot", addresses.bot ?? deployment.bot],
    ] as const) {
      label(l, k);
    }
    for (const e of addresses.protected) (this.protectedSet.add(lower(e.address)), label(e.address, e.label));
    for (const e of addresses.hot) {
      this.hotSet.add(lower(e.address));
      this.watchedSet.add(lower(e.address));
      label(e.address, e.label);
    }
    for (const e of addresses.watched) (this.watchedSet.add(lower(e.address)), label(e.address, e.label));
    for (const e of addresses.whitelabel) (this.whitelabelSet.add(lower(e.address)), label(e.address, e.label));
    for (const e of addresses.exits) (this.exitSet.add(lower(e.address)), label(e.address, e.label));

    if (this.protectedSet.has(this.bot)) throw new Error("bot address must not be protected");
  }

  category(a: Address): Category {
    const k = lower(a);
    if (this.protectedSet.has(k)) return "protected";
    if (this.whitelabelSet.has(k)) return "whitelabel";
    if (this.hotSet.has(k)) return "hot";
    return "normal";
  }

  isWatched(a: Address): boolean {
    return this.watchedSet.has(lower(a));
  }
  isHot(a: Address): boolean {
    return this.hotSet.has(lower(a));
  }
  isExit(a: Address): boolean {
    return this.exitSet.has(lower(a));
  }
  isWhitelabel(a: Address): boolean {
    return this.whitelabelSet.has(lower(a));
  }
  isProtected(a: Address): boolean {
    return this.protectedSet.has(lower(a));
  }
  watched(): Address[] {
    return [...this.watchedSet];
  }
  label(a: Address): string {
    const l = this.labels.get(lower(a));
    return l ? `${getAddress(a)} (${l})` : getAddress(a);
  }
}

// ---------------------------------------------------------------------------
// 로딩과 핫리로드
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  rules: RulesConfig;
  book: AddressBook;
  /** R9 외부 위험 목록 (소문자) */
  riskList: Set<Address>;
  loadedAt: number;
}

export interface ConfigPaths {
  rules: string;
  addresses: string;
}

export function loadRulesFile(path: string): RulesConfig {
  return rulesSchema.parse(parseYaml(readFileSync(path, "utf8")));
}

export function loadRuntimeConfig(paths: ConfigPaths): RuntimeConfig {
  const rules = loadRulesFile(paths.rules);
  const addresses = addressesSchema.parse(parseYaml(readFileSync(paths.addresses, "utf8")));
  const deploymentPath = resolve(dirname(paths.addresses), addresses.deployment);
  const deployment = deploymentSchema.parse(JSON.parse(readFileSync(deploymentPath, "utf8")));
  const book = new AddressBook(addresses, deployment);

  const riskList = new Set<Address>();
  for (const rel of rules.rules.R9.lists) {
    const text = readFileSync(resolve(dirname(paths.rules), rel), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (!isAddress(line, {strict: false})) throw new Error(`invalid address in ${rel}: ${line}`);
      riskList.add(lower(line));
    }
  }
  return {rules, book, riskList, loadedAt: Date.now()};
}

/**
 * 설정 파일을 감시하다가 바뀌면 다시 읽는다 (design.md 7.4 설정 핫리로드).
 * 읽기·검증에 실패하면 이전 설정을 유지하고 `error` 이벤트를 낸다 (알림은 구독자가 보낸다).
 */
export class ConfigStore extends EventEmitter {
  private cfg: RuntimeConfig;
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  readonly paths: ConfigPaths | undefined;

  /** 파일 경로를 주면 파일에서 읽고, RuntimeConfig를 주면 그대로 쓴다(테스트). */
  constructor(source: ConfigPaths | RuntimeConfig) {
    super();
    if ("book" in source) {
      this.cfg = source;
    } else {
      this.paths = source;
      this.cfg = loadRuntimeConfig(source);
    }
  }

  current(): RuntimeConfig {
    return this.cfg;
  }

  /** 테스트용: 설정을 바꾼 것처럼 교체한다. */
  set(cfg: RuntimeConfig): void {
    this.cfg = cfg;
    this.emit("change", cfg);
  }

  /** 다시 읽는다. 성공하면 true. 실패하면 이전 설정을 유지하고 `error`를 낸다. */
  reload(): boolean {
    if (!this.paths) return false;
    try {
      const next = loadRuntimeConfig(this.paths);
      this.cfg = next;
      this.emit("change", next);
      return true;
    } catch (err) {
      this.emit("error", err);
      return false;
    }
  }

  watch(debounceMs = 200): void {
    if (!this.paths) return;
    const files = new Set<string>([this.paths.rules, this.paths.addresses]);
    for (const rel of this.cfg.rules.rules.R9.lists) files.add(resolve(dirname(this.paths.rules), rel));
    for (const f of files) {
      this.watchers.push(
        watch(f, () => {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.reload(), debounceMs);
        }),
      );
    }
  }

  close(): void {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
