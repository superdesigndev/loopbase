// Insight analyzers — the SINGLE shared module that both `lb insights` and the
// web view read through, so they can never drift. Each analyzer is a plain
// function over the stored `tool_call` facts; the literal ANALYZERS map IS the
// registry (add a detector = add a function + a key). Aggregates are computed at
// READ time; nothing is materialized. (docs/INSIGHTS.md → analyzers.)

import { openDb } from "./db.ts";

// Quality defaults — baked in, not optional (docs/INSIGHTS.md → quality):
//   • a count floor so one-offs never surface,
//   • examples capped + deduped so a big bucket can't dump 200 refs,
//   • score = total estimated tokens (= count × avg-per-call), so "frequent but
//     already cheap" (Read/ls) sinks and "repeated AND expensive" rises.
const MIN_COUNT = 3;
const MAX_EXAMPLES = 3;
const NGRAM_N = 3;
const NGRAM_MIN_SESSIONS = 2; // cross-session recurrence = the real automation signal

export interface InsightFilter {
  project?: string | null;
  all?: boolean;
  sinceMs?: number | null;
  agent?: string;
  top: number;
}

// A ranked candidate. `examples` carry the full session id + turn so the caller
// can shorten it and feed `show --turn`. Candidates only — the deterministic /
// safe-to-script judgment stays human.
export interface Signal {
  analyzer: string;
  key: string;
  score: number;
  count: number;
  tokens: number;
  sessions: number;
  examples: { session: string; turn: number | null }[];
  sample?: string; // optional display extra (sample error, member tools, …)
}

interface FactRow {
  session_native_id: string;
  seq: number;
  turn: number | null;
  name: string;
  arg_sig: string;
  est_tokens: number;
  has_error: number;
  error_class: string | null;
}

// Build the shared scope WHERE (project / since / agent) over a `tool_call tc`
// joined to `sessions s`. Returns the clause + params.
function scope(f: InsightFilter): { where: string; params: Record<string, string | number> } {
  const parts: string[] = [];
  const params: Record<string, string | number> = {};
  if (!f.all) {
    parts.push("s.project = $project");
    params.$project = f.project ?? " none";
  }
  if (f.sinceMs != null) {
    parts.push("s.last_ts >= $cutoff");
    params.$cutoff = f.sinceMs;
  }
  if (f.agent) {
    parts.push("s.agent = $agent");
    params.$agent = f.agent;
  }
  return { where: parts.length ? " WHERE " + parts.join(" AND ") : "", params };
}

// Up to MAX_EXAMPLES distinct-session examples for a (name, arg_sig) bucket,
// preferring higher-token calls (the worst offenders) as the illustration.
function examplesForSig(f: InsightFilter, name: string, argSig: string, onlyErrors = false): Signal["examples"] {
  const db = openDb();
  const s = scope(f);
  const sql =
    "SELECT tc.session_native_id AS session, tc.turn AS turn, MAX(tc.est_tokens) AS w" +
    " FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" +
    s.where +
    (s.where ? " AND" : " WHERE") +
    " tc.name = $n AND tc.arg_sig = $sig" +
    (onlyErrors ? " AND tc.has_error = 1" : "") +
    " GROUP BY tc.session_native_id ORDER BY w DESC LIMIT $cap";
  return db
    .query(sql)
    .all({ ...s.params, $n: name, $sig: argSig, $cap: MAX_EXAMPLES } as Record<string, string | number>)
    .map((r) => ({ session: (r as any).session as string, turn: (r as any).turn as number | null }));
}

// tool-freq: "what did we do over and over." GROUP BY (name, arg_sig).
export function toolFreq(f: InsightFilter): Signal[] {
  const db = openDb();
  const s = scope(f);
  const sql =
    "SELECT tc.name, tc.arg_sig," +
    " COUNT(*) AS count, SUM(tc.est_tokens) AS tokens," +
    " COUNT(DISTINCT tc.session_native_id) AS sessions" +
    " FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" +
    s.where +
    " GROUP BY tc.name, tc.arg_sig HAVING count >= $floor" +
    " ORDER BY tokens DESC, count DESC LIMIT $top";
  const rows = db.query(sql).all({ ...s.params, $floor: MIN_COUNT, $top: f.top } as Record<string, string | number>) as {
    name: string;
    arg_sig: string;
    count: number;
    tokens: number;
    sessions: number;
  }[];
  return rows.map((r) => ({
    analyzer: "tool-freq",
    key: r.arg_sig,
    score: r.tokens, // total est tokens = count × avg-per-call
    count: r.count,
    tokens: r.tokens,
    sessions: r.sessions,
    examples: examplesForSig(f, r.name, r.arg_sig),
  }));
}

// tool-errors: "what keeps failing." Same facts, filtered to has_error.
export function toolErrors(f: InsightFilter): Signal[] {
  const db = openDb();
  const s = scope(f);
  const sql =
    "SELECT tc.name, tc.arg_sig," +
    " COUNT(*) AS count, SUM(tc.est_tokens) AS tokens," +
    " COUNT(DISTINCT tc.session_native_id) AS sessions," +
    " (SELECT error_class FROM tool_call e WHERE e.name = tc.name AND e.arg_sig = tc.arg_sig AND e.has_error = 1 AND e.error_class IS NOT NULL" +
    "   GROUP BY e.error_class ORDER BY COUNT(*) DESC LIMIT 1) AS sample" +
    " FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" +
    s.where +
    (s.where ? " AND" : " WHERE") +
    " tc.has_error = 1" +
    " GROUP BY tc.name, tc.arg_sig HAVING count >= $floor" +
    " ORDER BY count DESC, tokens DESC LIMIT $top";
  const rows = db.query(sql).all({ ...s.params, $floor: MIN_COUNT, $top: f.top } as Record<string, string | number>) as {
    name: string;
    arg_sig: string;
    count: number;
    tokens: number;
    sessions: number;
    sample: string | null;
  }[];
  return rows.map((r) => ({
    analyzer: "tool-errors",
    key: r.arg_sig,
    score: r.count, // failures rank by how often they recur
    count: r.count,
    tokens: r.tokens,
    sessions: r.sessions,
    examples: examplesForSig(f, r.name, r.arg_sig, true),
    ...(r.sample ? { sample: r.sample } : {}),
  }));
}

// tool-ngram: recurring multi-call MOTIFS (create → draft → poll → get). Not a
// clean GROUP BY — it needs ordered per-session sequences + windowing, so it's a
// thin programmatic pass over the same `tool_call` table (indexed read, no JSONL
// parse). Cross-session recurrence is required; all-identical windows (Read →
// Read → Read) are dropped as flow noise.
export function toolNgram(f: InsightFilter): Signal[] {
  const db = openDb();
  const s = scope(f);
  const rows = db
    .query(
      "SELECT tc.session_native_id, tc.seq, tc.turn, tc.name, tc.arg_sig, tc.est_tokens, tc.has_error, tc.error_class" +
        " FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" +
        s.where +
        " ORDER BY tc.session_native_id, tc.seq",
    )
    .all(s.params) as FactRow[];

  // Bucket facts by session, preserving order.
  const bySession = new Map<string, FactRow[]>();
  for (const r of rows) {
    let arr = bySession.get(r.session_native_id);
    if (!arr) bySession.set(r.session_native_id, (arr = []));
    arr.push(r);
  }

  interface Acc {
    count: number;
    tokens: number;
    sessions: Set<string>;
    examples: { session: string; turn: number | null; w: number }[];
  }
  const grams = new Map<string, Acc>();
  for (const [sid, calls] of bySession) {
    for (let i = 0; i + NGRAM_N <= calls.length; i++) {
      const win = calls.slice(i, i + NGRAM_N);
      const sigs = win.map((c) => c.arg_sig);
      if (sigs.every((x) => x === sigs[0])) continue; // all-identical → flow noise
      const key = sigs.join(" → ");
      const tok = win.reduce((a, c) => a + c.est_tokens, 0);
      let acc = grams.get(key);
      if (!acc) grams.set(key, (acc = { count: 0, tokens: 0, sessions: new Set(), examples: [] }));
      acc.count++;
      acc.tokens += tok;
      acc.sessions.add(sid);
      acc.examples.push({ session: sid, turn: win[0]!.turn, w: tok });
    }
  }

  const out: Signal[] = [];
  for (const [key, acc] of grams) {
    if (acc.count < MIN_COUNT || acc.sessions.size < NGRAM_MIN_SESSIONS) continue;
    // Dedup examples by session, prefer the heaviest window.
    const seen = new Set<string>();
    const examples = acc.examples
      .sort((a, b) => b.w - a.w)
      .filter((e) => (seen.has(e.session) ? false : (seen.add(e.session), true)))
      .slice(0, MAX_EXAMPLES)
      .map((e) => ({ session: e.session, turn: e.turn }));
    out.push({
      analyzer: "tool-ngram",
      key,
      score: acc.tokens,
      count: acc.count,
      tokens: acc.tokens,
      sessions: acc.sessions.size,
      examples,
    });
  }
  out.sort((a, b) => b.score - a.score || b.count - a.count);
  return out.slice(0, f.top);
}

// The registry. Add a detector = add a function + a key.
export const ANALYZERS: Record<string, (f: InsightFilter) => Signal[]> = {
  "tool-freq": toolFreq,
  "tool-errors": toolErrors,
  "tool-ngram": toolNgram,
};

export const ANALYZER_NAMES = Object.keys(ANALYZERS);
