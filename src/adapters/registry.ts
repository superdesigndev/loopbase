import type { Adapter, AgentKind } from "./types.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { piAdapter } from "./pi.ts";

// v0 = the JSONL family. hermes (SQLite) + openclaw land in v1.
export const ADAPTERS: Adapter[] = [claudeAdapter, codexAdapter, piAdapter];

export function adapterFor(kind: AgentKind): Adapter | undefined {
  return ADAPTERS.find((a) => a.kind === kind);
}
