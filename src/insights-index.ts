// Index-time fact writer: extract a session's tool calls into `tool_call` rows.
// Mirrors cost-index.ts — facts are stored once at index time so insight reads
// never re-parse JSONL. Idempotent: a session's rows are replaced wholesale on
// each rewrite (a grown session re-extracts cleanly). (docs/INSIGHTS.md.)
//
// v1 scope: MAIN-session tool calls only. Subagent calls aren't addressable by
// `show --turn` (their turn lives in a child transcript), so they're left for a
// follow-up that references them via `show --agent`. Documented, not silent.

import type { Database } from "bun:sqlite";
import type { Event } from "./adapters/types.ts";
import { extractToolCalls } from "./insights-extract.ts";

export interface InsightsWriter {
  // `events` is the already-parsed main transcript (the indexer has it in hand,
  // so we don't re-read the file).
  writeForSession(nativeId: string, events: Event[]): void;
}

export function makeInsightsWriter(db: Database): InsightsWriter {
  const del = db.prepare("DELETE FROM tool_call WHERE session_native_id = ?");
  const ins = db.prepare(`
    INSERT INTO tool_call
      (session_native_id, seq, turn, name, arg_sig, est_tokens, has_error, error_class)
    VALUES ($sid, $seq, $turn, $name, $sig, $tok, $err, $ec)
  `);
  return {
    writeForSession(nativeId: string, events: Event[]): void {
      const facts = extractToolCalls(events);
      del.run(nativeId);
      for (const f of facts) {
        ins.run({
          $sid: nativeId,
          $seq: f.seq,
          $turn: f.turn,
          $name: f.name,
          $sig: f.argSig,
          $tok: f.estTokens,
          $err: f.hasError ? 1 : 0,
          $ec: f.errorClass,
        });
      }
    },
  };
}
