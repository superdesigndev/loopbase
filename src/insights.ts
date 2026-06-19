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

// Harness / orchestration / interaction tools — how the agent loop runs, never
// scriptable work. Excluded from EVERY lens. (Grep/Glob are NOT here: repeated
// searching signals a missing index/doc, its own kind of candidate.)
const HARNESS_TOOLS =
  "'Task','Agent','Workflow','Skill','SlashCommand','ExitPlanMode','EnterPlanMode'," +
  "'AskUserQuestion','ToolSearch','TaskCreate','TaskUpdate','TaskList','KillShell','BashOutput'";
// File-mutation tools are the SUBSTANCE of coding, not scriptable repetition —
// excluded from the automation lens (tool-freq / tool-ngram) unless --include-edits.
const EDITOR_TOOLS = "'Read','Edit','Write','NotebookEdit'";
// Web tools are exploratory I/O (every search/fetch differs), not deterministic
// scriptable work — excluded from the automation lens.
const WEB_TOOLS = "'WebSearch','WebFetch'";
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
  usd: number | null; // real attributed spend (memoized cost); null = unpriced
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

// Conditions on `tc`. Harness/orchestration tools are dropped from EVERY lens.
// The automation lens (`candidate=true`) additionally drops web tools and
// file-mutation tools (unless includeEdits). No-op shell is always dropped.
function candidateConds(f: InsightFilter, candidate: boolean): string[] {
  const parts: string[] = [`tc.name NOT IN (${HARNESS_TOOLS})`];
  if (candidate) {
    parts.push(`tc.name NOT IN (${WEB_TOOLS})`);
    if (!f.includeEdits) parts.push(`tc.name NOT IN (${EDITOR_TOOLS})`);
  }
  for (const pre of NOOP_BASH_PREFIXES) parts.push(`tc.arg_sig NOT LIKE '${pre}%'`);
  return parts;
}

// Build the WHERE for the main analyzer query: scope + candidate lens.
function whereFor(f: InsightFilter, candidate: boolean): { where: string; params: Record<string, string | number> } {
  const parts = [...scopeConds(f, "s"), ...candidateConds(f, candidate)];
  return { where: parts.length ? " WHERE " + parts.join(" AND ") : "", params: scopeParams(f) };
}

// Dominant repo for a (name, arg_sig) bucket — a small per-bucket query (run
// only for the ≤top returned rows), kept out of the main aggregate for clarity.
function topProjectFor(f: InsightFilter, name: string, argSig: string): string | null {
  const db = openDb();
  const conds = scopeConds(f, "s");
  const sql =
    "SELECT s.project AS p FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" +
    " WHERE tc.name = $n AND tc.arg_sig = $sig" +
    (conds.length ? " AND " + conds.join(" AND ") : "") +
    " GROUP BY s.project ORDER BY COUNT(*) DESC LIMIT 1";
  const row = db.query(sql).get({ ...scopeParams(f), $n: name, $sig: argSig } as Record<string, string | number>) as { p: string | null } | null;
  return projectBase(row?.p ?? null);
}

// Per-tool-call attributed USD as a SQL fragment: the issuing assistant
// message's memoized cost, SPLIT across the tool calls in that message (so a
// message with 3 parallel calls doesn't triple-count). Joined on the message's
// stable id (dedup_key), NOT byte offset — the harness logs streaming partials
// of one message at several offsets (usage on one, the tool_use on another), so
// only the id is a reliable link. Null when unpriced / no id.
const ATTR_USD =
  "m.total_usd * 1.0 / COUNT(*) OVER (PARTITION BY tc.session_native_id, tc.dedup_key)";
const COST_JOIN =
  " LEFT JOIN message_tokens m ON m.session_native_id = tc.session_native_id AND m.dedup_key = tc.dedup_key AND tc.dedup_key IS NOT NULL";

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
  // CTE attributes real USD per call (split across a message's tool calls), then
  // we roll up per bucket. Rank by real spend; unpriced buckets sort last.
  const sql =
    "WITH attr AS (" +
    "  SELECT tc.name AS name, tc.arg_sig AS arg_sig, tc.est_tokens AS est, tc.session_native_id AS sid," +
    "    " + ATTR_USD + " AS usd" +
    "  FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" + COST_JOIN +
    w.where +
    ")" +
    " SELECT name, arg_sig, COUNT(*) AS count, SUM(est) AS tokens, SUM(usd) AS usd," +
    " COUNT(DISTINCT sid) AS sessions FROM attr" +
    " GROUP BY name, arg_sig HAVING count >= $floor" +
    " ORDER BY (usd IS NULL), usd DESC, tokens DESC LIMIT $top";
  const rows = db.query(sql).all({ ...w.params, $floor: MIN_COUNT, $top: f.top } as Record<string, string | number>) as {
    name: string;
    arg_sig: string;
    count: number;
    tokens: number;
    usd: number | null;
    sessions: number;
  }[];
  return rows.map((r) => ({
    analyzer: "tool-freq",
    key: r.arg_sig,
    score: r.usd ?? 0,
    count: r.count,
    tokens: r.tokens,
    usd: r.usd,
    sessions: r.sessions,
    project: topProjectFor(f, r.name, r.arg_sig),
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
  const errWhere = w.where + (w.where ? " AND" : " WHERE") + " tc.has_error = 1";
  const sql =
    "WITH attr AS (" +
    "  SELECT tc.name AS name, tc.arg_sig AS arg_sig, tc.est_tokens AS est, tc.session_native_id AS sid," +
    "    " + ATTR_USD + " AS usd" +
    "  FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" + COST_JOIN +
    errWhere +
    ")" +
    " SELECT name, arg_sig, COUNT(*) AS count, SUM(est) AS tokens, SUM(usd) AS usd," +
    " COUNT(DISTINCT sid) AS sessions FROM attr" +
    " GROUP BY name, arg_sig HAVING count >= $floor" +
    " ORDER BY count DESC, (usd IS NULL), usd DESC LIMIT $top";
  const rows = db.query(sql).all({ ...w.params, $floor: MIN_COUNT, $top: f.top } as Record<string, string | number>) as {
    name: string;
    arg_sig: string;
    count: number;
    tokens: number;
    usd: number | null;
    sessions: number;
  }[];
  return rows.map((r) => {
    // Most common real error_class for this bucket (display sample).
    const sample = (db
      .query(
        "SELECT error_class AS s FROM tool_call WHERE name = ? AND arg_sig = ? AND has_error = 1 AND error_class IS NOT NULL GROUP BY error_class ORDER BY COUNT(*) DESC LIMIT 1",
      )
      .get(r.name, r.arg_sig) as { s: string } | null)?.s;
    return {
      analyzer: "tool-errors",
      key: r.arg_sig,
      score: r.count, // failures rank by how often they recur
      count: r.count,
      tokens: r.tokens,
      usd: r.usd,
      sessions: r.sessions,
      project: topProjectFor(f, r.name, r.arg_sig),
      details: detailsFor(f, r.name, r.arg_sig, MAX_DETAILS),
      examples: examplesForSig(f, r.name, r.arg_sig, true),
      ...(sample ? { sample } : {}),
    };
  });
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
      "SELECT tc.session_native_id, tc.seq, tc.turn, tc.name, tc.arg_sig, tc.est_tokens, tc.has_error, tc.error_class, s.project," +
        " " + ATTR_USD + " AS attr_usd" +
        " FROM tool_call tc JOIN sessions s ON s.native_id = tc.session_native_id" + COST_JOIN +
        w.where +
        " ORDER BY tc.session_native_id, tc.seq",
    )
    .all(w.params) as (FactRow & { project: string | null; attr_usd: number | null })[];

  // Bucket facts by session, preserving order.
  const bySession = new Map<string, (FactRow & { project: string | null; attr_usd: number | null })[]>();
  for (const r of rows) {
    let arr = bySession.get(r.session_native_id);
    if (!arr) bySession.set(r.session_native_id, (arr = []));
    arr.push(r);
  }

  interface Acc {
    count: number;
    tokens: number;
    usd: number | null; // summed attributed spend across the window's calls
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
      const usd = win.reduce<number | null>((a, c) => (c.attr_usd == null ? a : (a ?? 0) + c.attr_usd), null);
      let acc = grams.get(key);
      if (!acc) grams.set(key, (acc = { count: 0, tokens: 0, usd: null, sessions: new Set(), projects: new Map(), examples: [] }));
      acc.count++;
      acc.tokens += tok;
      if (usd != null) acc.usd = (acc.usd ?? 0) + usd;
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
      score: acc.usd ?? 0,
      count: acc.count,
      tokens: acc.tokens,
      usd: acc.usd,
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
