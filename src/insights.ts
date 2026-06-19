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
  includeEdits?: boolean; // bring file-mutation tools back into the automation lens
}

// File-mutation tools are the SUBSTANCE of coding, not scriptable repetition —
// excluded from the automation lens (tool-freq / tool-ngram) by default. Grep /
// Glob stay: repeated searching signals a missing index/doc, its own candidate.
const EDITOR_TOOLS = "'Read','Edit','Write','NotebookEdit'";
// Pure no-op shell — never an automation candidate (and `echo` banners pollute).
const NOOP_BASH_PREFIXES = ["Bash:echo", "Bash:true", "Bash:sleep", "Bash::", "Bash:printf", "Bash:cd "];

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
  project: string | null; // dominant repo for this bucket (basename), so --all is legible
  details?: { key: string; count: number }[]; // top sub-clusters (slug/table/shape)
  examples: { session: string; turn: number | null }[];
  sample?: string; // optional display extra (sample error, member tools, …)
}

const MAX_DETAILS = 3; // sub-clusters nested in the default view

function projectBase(p: string | null): string | null {
  if (!p) return null;
  const x = p.replace(/\/+$/, "").split("/");
  return x[x.length - 1] || p;
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

// Scope conditions (project / since / agent) for given session/tool_call alias
// names — reused for the main query and the dominant-project subquery.
function scopeConds(f: InsightFilter, sAlias: string): string[] {
  const parts: string[] = [];
  if (!f.all) parts.push(`${sAlias}.project = $project`);
  if (f.sinceMs != null) parts.push(`${sAlias}.last_ts >= $cutoff`);
  if (f.agent) parts.push(`${sAlias}.agent = $agent`);
  return parts;
}

function scopeParams(f: InsightFilter): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (!f.all) params.$project = f.project ?? " none";
  if (f.sinceMs != null) params.$cutoff = f.sinceMs;
  if (f.agent) params.$agent = f.agent;
  return params;
}

// The automation-lens conditions on `tc`: drop file-mutation tools (unless
// includeEdits) and pure no-op shell. `candidate=false` (errors lens) keeps
// editors but still drops no-ops.
function candidateConds(f: InsightFilter, candidate: boolean): string[] {
  const parts: string[] = [];
  if (candidate && !f.includeEdits) parts.push(`tc.name NOT IN (${EDITOR_TOOLS})`);
  for (const pre of NOOP_BASH_PREFIXES) parts.push(`tc.arg_sig NOT LIKE '${pre}%'`);
  return parts;
}

// Build the WHERE for the main analyzer query: scope + candidate lens.
function whereFor(f: InsightFilter, candidate: boolean): { where: string; params: Record<string, string | number> } {
  const parts = [...scopeConds(f, "s"), ...candidateConds(f, candidate)];
  return { where: parts.length ? " WHERE " + parts.join(" AND ") : "", params: scopeParams(f) };
}

// Dominant-project subquery for a (name, arg_sig) bucket, scoped the same way.
function topProjectSub(f: InsightFilter): string {
  const sub = scopeConds(f, "s2");
  return (
    "(SELECT s2.project FROM tool_call t2 JOIN sessions s2 ON s2.native_id = t2.session_native_id" +
    " WHERE t2.name = tc.name AND t2.arg_sig = tc.arg_sig" +
    (sub.length ? " AND " + sub.join(" AND ") : "") +
    " GROUP BY s2.project ORDER BY COUNT(*) DESC LIMIT 1)"
  );
}

// Up to MAX_EXAMPLES distinct-session examples for a (name, arg_sig) bucket,
// preferring higher-token calls (the worst offenders) as the illustration.
function examplesForSig(f: InsightFilter, name: string, argSig: string, onlyErrors = false): Signal["examples"] {
  const db = openDb();
  const conds = scopeConds(f, "s");
  const sql =
    "SELECT tc.session_native_id AS session, tc.turn AS turn, MAX(tc.est_tokens) AS w" +
    " FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" +
    " WHERE tc.name = $n AND tc.arg_sig = $sig" +
    (onlyErrors ? " AND tc.has_error = 1" : "") +
    (conds.length ? " AND " + conds.join(" AND ") : "") +
    " GROUP BY tc.session_native_id ORDER BY w DESC LIMIT $cap";
  return db
    .query(sql)
    .all({ ...scopeParams(f), $n: name, $sig: argSig, $cap: MAX_EXAMPLES } as Record<string, string | number>)
    .map((r) => ({ session: (r as any).session as string, turn: (r as any).turn as number | null }));
}

// Top sub-clusters within a (name, arg_sig) bucket — a cheap GROUP BY over the
// stored `detail` column (no transcript re-read). This is the drill, default-on.
// `limit = 0` skips it (e.g. when the caller doesn't want nesting).
export function detailsFor(f: InsightFilter, name: string, argSig: string, limit: number): { key: string; count: number }[] {
  if (limit <= 0) return [];
  const db = openDb();
  const conds = scopeConds(f, "s");
  const sql =
    "SELECT COALESCE(tc.detail, '') AS key, COUNT(*) AS count" +
    " FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" +
    " WHERE tc.name = $n AND tc.arg_sig = $sig" +
    (conds.length ? " AND " + conds.join(" AND ") : "") +
    " GROUP BY tc.detail ORDER BY count DESC LIMIT $cap";
  const rows = db
    .query(sql)
    .all({ ...scopeParams(f), $n: name, $sig: argSig, $cap: limit } as Record<string, string | number>) as { key: string; count: number }[];
  // A single sub-cluster that just restates the bucket adds nothing — drop it.
  if (rows.length === 1 && (rows[0]!.key === "" || rows[0]!.key === argSig)) return [];
  return rows;
}

// tool-freq: "what did we do over and over." GROUP BY (name, arg_sig), through
// the automation lens (file-mutation tools excluded unless includeEdits).
export function toolFreq(f: InsightFilter): Signal[] {
  const db = openDb();
  const w = whereFor(f, true);
  const sql =
    "SELECT tc.name, tc.arg_sig," +
    " COUNT(*) AS count, SUM(tc.est_tokens) AS tokens," +
    " COUNT(DISTINCT tc.session_native_id) AS sessions," +
    " " + topProjectSub(f) + " AS project" +
    " FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" +
    w.where +
    " GROUP BY tc.name, tc.arg_sig HAVING count >= $floor" +
    " ORDER BY tokens DESC, count DESC LIMIT $top";
  const rows = db.query(sql).all({ ...w.params, $floor: MIN_COUNT, $top: f.top } as Record<string, string | number>) as {
    name: string;
    arg_sig: string;
    count: number;
    tokens: number;
    sessions: number;
    project: string | null;
  }[];
  return rows.map((r) => ({
    analyzer: "tool-freq",
    key: r.arg_sig,
    score: r.tokens, // total est tokens = count × avg-per-call
    count: r.count,
    tokens: r.tokens,
    sessions: r.sessions,
    project: projectBase(r.project),
    details: detailsFor(f, r.name, r.arg_sig, MAX_DETAILS),
    examples: examplesForSig(f, r.name, r.arg_sig),
  }));
}

// tool-errors: "what keeps failing." Same facts, filtered to has_error. Keeps
// editor tools (a recurring "File has not been read yet" Edit IS a useful
// reliability signal); only no-op shell is dropped.
export function toolErrors(f: InsightFilter): Signal[] {
  const db = openDb();
  const w = whereFor(f, false);
  const sql =
    "SELECT tc.name, tc.arg_sig," +
    " COUNT(*) AS count, SUM(tc.est_tokens) AS tokens," +
    " COUNT(DISTINCT tc.session_native_id) AS sessions," +
    " " + topProjectSub(f) + " AS project," +
    " (SELECT error_class FROM tool_call e WHERE e.name = tc.name AND e.arg_sig = tc.arg_sig AND e.has_error = 1 AND e.error_class IS NOT NULL" +
    "   GROUP BY e.error_class ORDER BY COUNT(*) DESC LIMIT 1) AS sample" +
    " FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" +
    w.where +
    (w.where ? " AND" : " WHERE") +
    " tc.has_error = 1" +
    " GROUP BY tc.name, tc.arg_sig HAVING count >= $floor" +
    " ORDER BY count DESC, tokens DESC LIMIT $top";
  const rows = db.query(sql).all({ ...w.params, $floor: MIN_COUNT, $top: f.top } as Record<string, string | number>) as {
    name: string;
    arg_sig: string;
    count: number;
    tokens: number;
    sessions: number;
    project: string | null;
    sample: string | null;
  }[];
  return rows.map((r) => ({
    analyzer: "tool-errors",
    key: r.arg_sig,
    score: r.count, // failures rank by how often they recur
    count: r.count,
    tokens: r.tokens,
    sessions: r.sessions,
    project: projectBase(r.project),
    details: detailsFor(f, r.name, r.arg_sig, MAX_DETAILS),
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
  const w = whereFor(f, true); // automation lens: editors/no-ops excluded
  const rows = db
    .query(
      "SELECT tc.session_native_id, tc.seq, tc.turn, tc.name, tc.arg_sig, tc.est_tokens, tc.has_error, tc.error_class, s.project" +
        " FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" +
        w.where +
        " ORDER BY tc.session_native_id, tc.seq",
    )
    .all(w.params) as (FactRow & { project: string | null })[];

  // Bucket facts by session, preserving order.
  const bySession = new Map<string, (FactRow & { project: string | null })[]>();
  for (const r of rows) {
    let arr = bySession.get(r.session_native_id);
    if (!arr) bySession.set(r.session_native_id, (arr = []));
    arr.push(r);
  }

  interface Acc {
    count: number;
    tokens: number;
    sessions: Set<string>;
    projects: Map<string, number>; // project → occurrences, for the dominant repo
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
      if (!acc) grams.set(key, (acc = { count: 0, tokens: 0, sessions: new Set(), projects: new Map(), examples: [] }));
      acc.count++;
      acc.tokens += tok;
      acc.sessions.add(sid);
      const proj = win[0]!.project;
      if (proj) acc.projects.set(proj, (acc.projects.get(proj) ?? 0) + 1);
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
    const topProj = [...acc.projects.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push({
      analyzer: "tool-ngram",
      key,
      score: acc.tokens,
      count: acc.count,
      tokens: acc.tokens,
      sessions: acc.sessions.size,
      project: projectBase(topProj),
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
