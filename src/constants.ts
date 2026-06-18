// Single source of truth for the product/brand name. NEVER type the literal
// name anywhere else — read it from here so a rename is a one-line change.
// (PLAN.md → "Rename-cheap setup".)
export const PRODUCT_NAME = "loopbase";

// Canonical invocation name shown in help, errors, and hints. `lb` is a shorter
// alias (both are bin entries); change here to re-canonicalize.
export const BIN_NAME = "loopbase";

// Version of the DERIVED index data. Bump on a schema change OR any extraction
// change that feeds a derived table — adapter parsing (titles, turns, branch),
// cost token logic, OR the insights `argSig`/fact extraction (cached in
// tool_call, so a logic change leaves stale signatures until a rebuild). On a
// mismatch the derived tables (sessions, agent_threads, message_tokens,
// session_cost, tool_call) are dropped + rebuilt from source files, while the
// user-authored worklog is preserved.
// (v3: codex semantic titles + AGENTS.md skip. v4: token + cost tables.
// v5: cost accuracy — dedup duplicate usage rows + count subagent/workflow spend.
// v6: tool_call fact table for insights.)
export const SCHEMA_VERSION = 6;

import { homedir } from "node:os";
import { join } from "node:path";

// On-disk dir for the index + worklog. Decoupled from the brand: kept stable
// across a rename. A startup migration (see migrateStorageDir) can move an old
// dir to a new one if the constant ever changes.
const STORAGE_DIR_NAME = `.${PRODUCT_NAME}`;

export function storageDir(): string {
  // LOOPBASE_HOME override is handy for tests and isolation.
  const override = process.env.LB_HOME ?? process.env.LOOPBASE_HOME;
  if (override) return override;
  return join(homedir(), STORAGE_DIR_NAME);
}

export function indexDbPath(): string {
  return join(storageDir(), "index.db");
}

// Stub: if a future brand rename changes STORAGE_DIR_NAME, move the old dir to
// the new one on first run. No-op today (no prior name to migrate from).
export function migrateStorageDir(): void {
  // Intentionally empty until a rename actually happens. Documented in PLAN.md.
}
