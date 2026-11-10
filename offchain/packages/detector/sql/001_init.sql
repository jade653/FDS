-- 탐지·사건 저장소 (design.md 7.1 Enricher addresses, Case Store cases/actions).
-- 모든 주소는 소문자 0x 문자열, 금액은 10진 문자열(numeric), 시각은 unix 초.

CREATE TABLE IF NOT EXISTS cursor (
  id INTEGER PRIMARY KEY,
  block BIGINT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS block_hashes (
  block BIGINT PRIMARY KEY,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS addresses (
  address TEXT PRIMARY KEY,
  first_seen_ts BIGINT NOT NULL,
  first_seen_block BIGINT NOT NULL,
  tx_count INTEGER NOT NULL,
  last_pos TEXT NOT NULL,
  nonce INTEGER,
  frozen BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS cases (
  case_key TEXT PRIMARY KEY,
  case_string TEXT NOT NULL,
  status TEXT NOT NULL,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_addresses (
  case_key TEXT NOT NULL REFERENCES cases(case_key),
  address TEXT NOT NULL,
  decision TEXT NOT NULL,
  score INTEGER NOT NULL,
  PRIMARY KEY (case_key, address)
);

CREATE TABLE IF NOT EXISTS detections (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  rule TEXT NOT NULL,
  points INTEGER NOT NULL,
  ts BIGINT NOT NULL,
  block BIGINT,
  tx_hash TEXT,
  detail TEXT NOT NULL,
  case_key TEXT
);
CREATE INDEX IF NOT EXISTS detections_address ON detections(address);
CREATE INDEX IF NOT EXISTS detections_block ON detections(block);

CREATE TABLE IF NOT EXISTS actions (
  id SERIAL PRIMARY KEY,
  case_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  tx_hash TEXT,
  ts BIGINT NOT NULL,
  n_addresses INTEGER NOT NULL DEFAULT 1,
  data TEXT
);
CREATE INDEX IF NOT EXISTS actions_case ON actions(case_key);
CREATE INDEX IF NOT EXISTS actions_kind_ts ON actions(kind, ts);

CREATE TABLE IF NOT EXISTS approval_tokens (
  jti TEXT PRIMARY KEY,
  case_key TEXT NOT NULL,
  address TEXT NOT NULL,
  used_by TEXT NOT NULL,
  used_ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS mint_requests (
  id SERIAL PRIMARY KEY,
  to_address TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  ref TEXT NOT NULL,
  created_ts BIGINT NOT NULL,
  consumed_by TEXT
);
