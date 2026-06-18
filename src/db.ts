// SQLite index. Stores session metadata + worklog only — messages stay in the
// source files and are read lazily. (PLAN.md → Decision #2, Phase 1 schema.)

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { indexDbPath, SCHEMA_VERSION } from "./constants.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  native_id          TEXT PRIMARY KEY,
  agent              TEXT NOT NULL,
  project            TEXT,              -- git repo root or dir
  cwd                TEXT,
  branch             TEXT,
  path               TEXT NOT NULL,     -- source transcript file
  started_at         INTEGER,           -- epoch ms
  last_ts            INTEGER,           -- epoch ms of last message
  msg_count          INTEGER DEFAULT 0,
  title              TEXT,              -- native title if any, else first user message
  last_offset        INTEGER DEFAULT 0, -- bytes parsed (JSONL cursor)
  last_mtime         REAL DEFAULT 0,
  last_logged_offset INTEGER DEFAULT 0  -- worklog span cursor
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_last_ts ON sessions(last_ts);

CREATE TABLE IF NOT EXISTS agent_threads (
  agent_id           TEXT PRIMARY KEY,  -- subagent id
  parent_native_id   TEXT NOT NULL,
  agent_type         TEXT,
  description        TEXT,
  tool_use_id        TEXT,
  path               TEXT NOT NULL,
  msg_count          INTEGER DEFAULT 0,
  last_offset        INTEGER DEFAULT 0,
  last_mtime         REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_threads_parent ON agent_threads(parent_native_id);

CREATE TABLE IF NOT EXISTS worklog (
  id               TEXT PRIMARY KEY,    -- lg_xxxxxx
  session_native_id TEXT NOT NULL,
  project          TEXT,
  text             TEXT NOT NULL,       -- title (one line)
  body             TEXT,                -- optional 1-2 line detail (LOG.md "What:")
  tags             TEXT,                -- comma-joined
  from_offset      INTEGER,
  to_offset        INTEGER,
  msg_count        INTEGER,             -- messages covered by this span
  created_at       INTEGER NOT NULL,
  content_hash     TEXT NOT NULL,
  UNIQUE(session_native_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_worklog_session ON worklog(session_native_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Per-assistant-message token usage + memoized cost. Granular grain (= a
-- "turn"); only assistant messages carry a usage block. Source of truth for
-- cost-per-log-batch (offset-range sum). Derived; rebuilt from source.
-- (docs/cost-plan.md → Data model, Table 1.)
CREATE TABLE IF NOT EXISTS message_tokens (
  session_native_id     TEXT NOT NULL,
  seq                   INTEGER NOT NULL,   -- assistant-message index within session
  offset                INTEGER NOT NULL,   -- byte offset of the JSONL line
  ts                    INTEGER,
  agent                 TEXT NOT NULL,
  model                 TEXT,               -- normalized; null = unknown
  input_tokens          INTEGER DEFAULT 0,  -- INCLUSIVE of cache (ax convention)
  output_tokens         INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens     INTEGER DEFAULT 0,
  reasoning_tokens      INTEGER DEFAULT 0,
  token_source          TEXT NOT NULL,      -- 'usage_metadata'
  total_usd             REAL,               -- MEMOIZED at index; null if unpriced
  pricing_source        TEXT,               -- catalog stamp; 'estimated:…' if read-time-filled
  PRIMARY KEY (session_native_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_mtok_session ON message_tokens(session_native_id);
CREATE INDEX IF NOT EXISTS idx_mtok_offset  ON message_tokens(session_native_id, offset);

-- Per-(session, model) rollup. The sessions list reads ONLY this table; it is
-- never produced by scanning message_tokens at read time. Derived.
-- (docs/cost-plan.md → Data model, Table 2.)
CREATE TABLE IF NOT EXISTS session_cost (
  session_native_id     TEXT NOT NULL,
  model                 TEXT,               -- null = unknown; a session may have >1 row
  agent                 TEXT NOT NULL,
  input_tokens          INTEGER DEFAULT 0,
  output_tokens         INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens     INTEGER DEFAULT 0,
  reasoning_tokens      INTEGER DEFAULT 0,
  estimated_tokens      INTEGER DEFAULT 0,  -- byte-estimate count when token_source='byte_estimate'
  token_source          TEXT NOT NULL,      -- 'usage_metadata' | 'byte_estimate'
  total_usd             REAL,               -- MEMOIZED; sum of message rows (or byte-estimate price)
  pricing_source        TEXT,
  catalog_version       TEXT,               -- which price catalog produced total_usd (reprice guard)
  burn_buckets          TEXT,               -- JSON number[]; sessions-list sparkline
  PRIMARY KEY (session_native_id, model)
);
CREATE INDEX IF NOT EXISTS idx_scost_session ON session_cost(session_native_id);

-- One row per tool call in a session's main transcript. The stored FACT layer
-- for insights; aggregates (frequency, sequences, errors) are computed at READ
-- time over this table, never materialized. Derived; rebuilt from source.
-- turn = the user-turn ordinal containing the call, so an insight example
-- feeds straight into 'show --turn'. (docs/INSIGHTS.md -> architecture.)
CREATE TABLE IF NOT EXISTS tool_call (
  session_native_id TEXT NOT NULL,
  seq               INTEGER NOT NULL,   -- tool-call index within the session
  turn              INTEGER,            -- user-turn ordinal; null if pre-first-turn
  name              TEXT NOT NULL,      -- tool name (Bash, Read, mcp__x__y, …)
  arg_sig           TEXT NOT NULL,      -- normalized signature (the bucket key)
  est_tokens        INTEGER DEFAULT 0,  -- I/O-size token estimate (cost weight)
  has_error         INTEGER DEFAULT 0,
  error_class       TEXT,
  PRIMARY KEY (session_native_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_toolcall_session ON tool_call(session_native_id);
CREATE INDEX IF NOT EXISTS idx_toolcall_sig ON tool_call(name, arg_sig);
`;

let _db: Database | null = null;

export function openDb(): Database {
  if (_db) return _db;
  const path = indexDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 3000;");
  // Migrate BEFORE applying SCHEMA: a stale derived table can lack columns that
  // SCHEMA's CREATE INDEX references, which would throw. So drop stale derived
  // tables first, then (re)create everything. worklog + meta are preserved.
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null;
  const current = row ? Number(row.value) : null;
  const stale = current !== SCHEMA_VERSION;
  if (stale) {
    db.exec(
      "DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS agent_threads;" +
        " DROP TABLE IF EXISTS message_tokens; DROP TABLE IF EXISTS session_cost;" +
        " DROP TABLE IF EXISTS tool_call;",
    );
  }
  db.exec(SCHEMA);
  // Additive worklog columns: worklog is preserved across migrations (CREATE IF
  // NOT EXISTS won't touch an existing table), so add new columns in place.
  try {
    db.exec("ALTER TABLE worklog ADD COLUMN body TEXT");
  } catch {
    // already present
  }
  if (stale) {
    db.query("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }
  _db = db;
  return db;
}

// Drop + recreate the DERIVED tables only (what `index --rebuild` calls). NEVER
// drops `worklog` — that's user-authored data, not derivable from source, so a
// rebuild must always preserve it. (Regression guard: tests/migration covers
// that --rebuild keeps worklog.)
export function resetDb(): void {
  const db = openDb();
  backupWorklog(db); // defense-in-depth: snapshot before any destructive op
  db.exec(
    "DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS agent_threads;" +
      " DROP TABLE IF EXISTS message_tokens; DROP TABLE IF EXISTS session_cost;",
  );
  db.exec(SCHEMA);
}

// Safety net: dump the worklog to a timestamped JSONL under the storage dir
// before destructive index ops, so even a future bug can't cause silent loss.
// Best-effort — never throws into the caller.
export function backupWorklog(db: Database): void {
  try {
    const rows = db.query("SELECT * FROM worklog").all() as Record<string, unknown>[];
    if (rows.length === 0) return;
    const dir = join(dirname(indexDbPath()), "backups");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `worklog-${stamp}.jsonl`);
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } catch {
    // worklog table may not exist yet, or fs unavailable — ignore
  }
}

// For tests: close + forget the singleton.
export function closeDb(): void {
  _db?.close();
  _db = null;
}
