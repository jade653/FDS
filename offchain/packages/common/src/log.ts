/** 구조화 로그. 한 줄 JSON. */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const order: Record<LogLevel, number> = {debug: 10, info: 20, warn: 30, error: 40};

function replacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

export function createLogger(name: string, level: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info"): Logger {
  const emit = (l: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (order[l] < order[level]) return;
    const line = JSON.stringify({t: new Date().toISOString(), l, n: name, msg, ...data}, replacer);
    (l === "error" || l === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  };
}

export const silentLogger: Logger = {debug() {}, info() {}, warn() {}, error() {}};
