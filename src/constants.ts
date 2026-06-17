// Single source of truth for the product/brand name. NEVER type the literal
// name anywhere else — read it from here so a rename is a one-line change.
// (PLAN.md → "Rename-cheap setup".)
export const PRODUCT_NAME = "loopbase";

// Canonical invocation name shown in help, errors, and hints. `lb` is a shorter
// alias (both are bin entries); change here to re-canonicalize.
export const BIN_NAME = "loopbase";

// Version of the DERIVED index data. Bump on a schema change OR an adapter
// parsing change (titles, turns, branch, etc.) — on a mismatch the derived
// tables (sessions, agent_threads, message_tokens, session_cost) are dropped +
// rebuilt from source files, while the user-authored worklog is preserved.
// (v3: codex semantic titles + AGENTS.md skip. v4: token + cost tables.
// v5: cost accuracy — dedup duplicate usage rows + count subagent/workflow spend.)
export const SCHEMA_VERSION = 5;

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
