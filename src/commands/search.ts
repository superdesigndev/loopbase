// `lb search <query>` — content-addressed entry point: find sessions/turns by
// what was said, across agents, then dive with `lb show --turn <n>`. On-demand
// scan (no FTS index): a raw-substring pre-filter avoids parsing files that
// can't match; only hits are parsed + mapped to turn handles. (PLAN.md → search.)
//
// Recall + ranking (no FTS, so done in-memory over the matched files):
//   - the current session is excluded by default (it's almost always just the
//     agent re-asking its own question) — `--include-current` opts back in;
//   - a multi-word query first tries an exact contiguous match; if that finds
//     nothing it falls back to TOKEN matching (every word present, in any order,
//     across separators) so `loop engineer template` finds `loop-engineer-template`;
//   - matches are ranked by a cheap BM25-ish score (term frequency × role weight,
//     boosted by how many turns in the session matched) instead of raw recency,
//     so the session that DID the work outranks one that merely mentioned it.

import { readFileSync } from "node:fs";
import { reindex } from "../indexer.ts";
import { listSessions, threadsForParent, resolveSession, type SessionRow } from "../queries.ts";
import { adapterFor, ADAPTERS } from "../adapters/registry.ts";
import { resolveProject } from "../project.ts";
import { parseDuration, relativeTime } from "../time.ts";
import { userTurnStarts } from "./show.ts";
import { shortId } from "./list.ts";
import { emit, errUsage, errNotFound } from "../output.ts";
import { BIN_NAME } from "../constants.ts";
import type { Event } from "../adapters/types.ts";
import type { Invocation } from "../parse.ts";

const SNIPPET_PAD = 40;
const MATCHES_PER_FILE = 5;

// A single matched message, carried with the fields needed to rank it before we
// trim to `--limit`. Underscored fields are internal and stripped before emit.
interface RawMatch {
  out: Record<string, unknown>; // the display shape (session/turn/role/when/snippet/path)
  _sid: string; // session native_id — the grouping key for the per-session boost
  _role: string;
  _text: string; // the matched message text (for term-frequency scoring)
  _ts: number; // for the recency tiebreak
}

export function runSearch(inv: Invocation): void {
  reindex();
  const query = (inv.args.query ?? "").trim();
  if (!query) throw errUsage("search query is empty", `${BIN_NAME} search "<text>"`);

  const useRegex = inv.flags.regex === true;
  let re: RegExp | null = null;
  if (useRegex) {
    try {
      re = new RegExp(query, "i");
    } catch (e) {
      throw errUsage(`invalid regex: ${(e as Error).message}`, `${BIN_NAME} search "<pattern>" --regex`);
    }
  }

  const all = inv.flags.all === true;
  const includeTools = inv.flags["include-tools"] === true;
  const includeCurrent = inv.flags["include-current"] === true;
  const filesOnly = inv.flags.files === true;
  const limit = typeof inv.flags.limit === "number" ? inv.flags.limit : 20;
  // Collect well beyond `limit` so ranking has a real pool to sort before we
  // trim — otherwise a relevant-but-older session is dropped by recency before
  // it can be scored. Bounded so a broad term can't scan the whole corpus.
  const scanBudget = Math.max(limit * 10, 300);

  let sinceMs: number | null = null;
  if (typeof inv.flags.since === "string") {
    const d = parseDuration(inv.flags.since);
    if (d == null) throw errUsage(`--since expects a duration like 24h, 7d (got ${JSON.stringify(inv.flags.since)})`, `${BIN_NAME} search "<q>" --since 7d`);
    sinceMs = Date.now() - d;
  }

  // In-scope sessions (newest first, unbounded — we cap matches, not sessions).
  const explicitSession = typeof inv.flags.session === "string";
  let sessions: SessionRow[];
  if (explicitSession) {
    const r = resolveSession(inv.flags.session as string);
    if (!r.row) throw errNotFound("session", inv.flags.session as string, `run \`${BIN_NAME} list\` to see ids`);
    sessions = [r.row];
  } else {
    const project = all ? null : resolveProject(typeof inv.flags.path === "string" ? inv.flags.path : process.cwd());
    const agent = typeof inv.flags.agent === "string" ? inv.flags.agent : undefined;
    sessions = listSessions({ project, all, sinceMs, agent, limit: 100_000 });
  }

  // Drop the caller's own session unless asked to keep it — when an agent runs
  // `search`, its live transcript echoes the very query it just typed, which
  // would otherwise dominate the results. Never applies to an explicit --session.
  let excludedCurrent = false;
  if (!includeCurrent && !explicitSession) {
    const curId = currentSessionNativeId();
    if (curId) {
      const before = sessions.length;
      sessions = sessions.filter((s) => s.native_id !== curId);
      excludedCurrent = before !== sessions.length;
    }
  }

  const scopeLabel = all ? "(all)" : explicitSession ? shortId(inv.flags.session as string) : (sessions[0]?.project ?? null);
  const now = Date.now();
  const qTokens = useRegex ? [] : tokenize(query);
  // Multi-word queries always match on TOKENS (every word present, any order,
  // separators ignored) — a superset of exact match, so `loop engineer template`
  // also catches `loop-engineer-template`. Ranking then floats the exact-phrase
  // and high-signal hits to the top, so broadening doesn't bury the real answer.
  // A single word or a --regex stays exact (token mode would add nothing).
  const tokenMode = !useRegex && qTokens.length >= 2;
  const matcher = tokenMode ? tokenMatcher(qTokens) : exactMatcher(re, query);

  // --files: grep -l style — matching sessions + raw paths, for custom piping.
  if (filesOnly) {
    const files = collectFiles(sessions, matcher.gate, limit);
    emit({ query, mode: tokenMode ? "tokenized" : "exact", project: scopeLabel, ...(excludedCurrent ? { excluded_current: true } : {}), files }, inv.mode);
    return;
  }

  const raws = collect(sessions, includeTools, matcher, now, scanBudget);
  rank(raws, qTokens, query);
  // "exact" when every hit contained the contiguous phrase (token broadening
  // added nothing); "tokenized" when broadening actually pulled in extra hits.
  const broadened = tokenMode && raws.some((r) => !(r as any)._exact);
  const more = raws.length > limit;
  const matches = raws.slice(0, limit).map((r) => r.out);

  emit(
    {
      query,
      mode: broadened ? "tokenized" : "exact",
      ...(broadened ? { tokens: qTokens } : {}),
      project: scopeLabel,
      ...(excludedCurrent ? { excluded_current: true } : {}),
      matches,
      ...(more
        ? { more: { shown: matches.length, note: "more matches — narrow with --since / --agent / --session or a more specific query" } }
        : {}),
    },
    inv.mode,
  );
}

// A per-message matcher: a file-level gate (skip files that can't match without
// parsing them) and a message-level locator (where in the text the hit is).
interface Matcher {
  gate: (raw: string) => boolean;
  locate: (text: string) => { index: number; length: number } | null;
}

function exactMatcher(re: RegExp | null, query: string): Matcher {
  return {
    gate: (raw) => (re ? re.test(raw) : raw.toLowerCase().includes(query.toLowerCase())),
    locate: (text) => findMatch(text, re, query),
  };
}

function tokenMatcher(tokens: string[]): Matcher {
  return {
    gate: (raw) => {
      const l = raw.toLowerCase();
      return tokens.every((t) => l.includes(t));
    },
    locate: (text) => locateTokens(text, tokens),
  };
}

// Walk the in-scope sessions (+ their subagents), collecting matches until the
// scan budget is hit. Ranking happens after, so we don't stop at `limit` here.
function collect(sessions: SessionRow[], includeTools: boolean, matcher: Matcher, now: number, budget: number): RawMatch[] {
  const out: RawMatch[] = [];
  for (const s of sessions) {
    const adapter = adapterFor(s.agent as any);
    if (!adapter) continue;

    const rawMain = safeRead(s.path);
    if (rawMain && matcher.gate(rawMain)) {
      const events = adapter.parseContent(rawMain);
      const starts = userTurnStarts(events);
      scanEvents(events, includeTools, matcher, MATCHES_PER_FILE, (ev, i, text, snip) => {
        out.push({
          out: { session: shortId(s.native_id), agent: s.agent, turn: turnOf(starts, i), role: ev.role, when: relativeTime(ev.ts ?? s.last_ts, now), snippet: snip, path: s.path },
          _sid: s.native_id,
          _role: ev.role,
          _text: text,
          _ts: ev.ts ?? s.last_ts ?? 0,
        });
      });
    }
    for (const t of threadsForParent(s.native_id)) {
      const raw = safeRead(t.path);
      if (!raw || !matcher.gate(raw)) continue;
      const claude = adapterFor("claude")!;
      const events = claude.parseContent(raw);
      scanEvents(events, includeTools, matcher, MATCHES_PER_FILE, (ev, _i, text, snip) => {
        out.push({
          out: { session: shortId(s.native_id), agent: s.agent, subagent: shortId(t.agent_id), role: ev.role, when: relativeTime(ev.ts ?? s.last_ts, now), snippet: snip, path: t.path },
          _sid: s.native_id,
          _role: ev.role,
          _text: text,
          _ts: ev.ts ?? s.last_ts ?? 0,
        });
      });
    }
    if (out.length >= budget) break;
  }
  return out;
}

function collectFiles(sessions: SessionRow[], gate: (raw: string) => boolean, limit: number): any[] {
  const files: any[] = [];
  for (const s of sessions) {
    const candidates = [
      { session: s.native_id, agent: s.agent, path: s.path, agent_id: null as string | null },
      ...threadsForParent(s.native_id).map((t) => ({ session: s.native_id, agent: s.agent, path: t.path, agent_id: t.agent_id })),
    ];
    for (const c of candidates) {
      const raw = safeRead(c.path);
      if (raw && gate(raw)) {
        files.push({ session: shortId(c.session), agent: c.agent, ...(c.agent_id ? { subagent: shortId(c.agent_id) } : {}), path: c.path });
        if (files.length >= limit) return files;
      }
    }
  }
  return files;
}

// Rank in place: a cheap BM25-ish score so the turn that's actually ABOUT the
// query (the phrase as an adjacent unit, user intent, repeated terms, in a
// session with many matching turns) floats above a one-off scattered mention.
// Recency only breaks ties.
function rank(raws: RawMatch[], tokens: string[], query: string): void {
  // "Phrase present" = the query words adjacent, separated only by spaces/-/_/./ —
  // so `loop-engineer-template` counts as the phrase `loop engineer template`,
  // while the three words scattered across a sentence do not. This is THE signal
  // that separates the session that named the thing from one that merely used its
  // words. For a single-word query it degrades to a plain substring check.
  const phraseRe = tokens.length >= 2 ? adjacencyRegex(tokens) : null;
  const phraseLiteral = query.toLowerCase();
  const perSession = new Map<string, number>();
  for (const r of raws) perSession.set(r._sid, (perSession.get(r._sid) ?? 0) + 1);
  for (const r of raws) {
    const phrase = phraseRe ? phraseRe.test(r._text) : r._text.toLowerCase().includes(phraseLiteral);
    (r as any)._exact = phrase;
    (r as any)._score = scoreMatch(r._role, r._text, tokens, perSession.get(r._sid) ?? 1, phrase);
  }
  raws.sort((a, b) => (b as any)._score - (a as any)._score || b._ts - a._ts);
}

// BM25-style relevance. The key term is length-normalized term frequency: tf
// saturates (k1) and is penalized by how long the message is relative to a
// typical turn (b · len/avgLen). Without this, a long recap that merely mentions
// the words outscores the short user turn that's actually ABOUT them — the exact
// failure this fixes. Then: role weight (intent > tool dump), a session boost
// (many matching turns = the session that did the work), and a phrase bonus.
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_AVG_LEN = 120; // words in a "typical" turn — the length-norm anchor
function scoreMatch(role: string, text: string, tokens: string[], sessionMatches: number, phrase: boolean): number {
  const roleW = role === "user" ? 3 : role === "assistant" ? 1.5 : 0.5;
  let tf = 0;
  if (tokens.length) {
    const l = text.toLowerCase();
    for (const t of tokens) tf += countOcc(l, t);
  }
  if (tf === 0) tf = 1; // regex / single-token: term frequency is unknown, treat as one
  const len = Math.max(1, text.split(/\s+/).length);
  const normTf = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * len) / BM25_AVG_LEN));
  return roleW * normTf + 0.5 * Math.log(1 + sessionMatches) + (phrase ? 6 : 0);
}

// Match the query tokens occurring adjacently, separated only by whitespace or
// identifier punctuation (-_./) — so a hyphenated/snake_cased identifier reads
// as the phrase. Tokens are alphanumeric (from tokenize), so no escaping needed.
function adjacencyRegex(tokens: string[]): RegExp {
  return new RegExp(tokens.join("[\\s\\-_./]+"), "i");
}

// Split a query into lowercase word tokens — separators (-_./ space) and
// camelCase boundaries all break, so `loop-engineer-template` and
// `loopEngineer` both tokenize the same way the query does. Deduped.
function tokenize(q: string): string[] {
  const spaced = q.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function countOcc(haystackLower: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystackLower.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystackLower.indexOf(needle, i + needle.length);
  }
  return n;
}

// A message matches token-mode if it contains EVERY query token; anchor the
// snippet at the earliest token occurrence so it lands on a relevant spot.
function locateTokens(text: string, tokens: string[]): { index: number; length: number } | null {
  const l = text.toLowerCase();
  let earliest = -1;
  let earliestLen = 1;
  for (const t of tokens) {
    const i = l.indexOf(t);
    if (i === -1) return null;
    if (earliest === -1 || i < earliest) {
      earliest = i;
      earliestLen = t.length;
    }
  }
  return earliest === -1 ? null : { index: earliest, length: earliestLen };
}

// Search an event list, calling `onHit` for matching messages (capped per file).
function scanEvents(
  events: Event[],
  includeTools: boolean,
  matcher: Matcher,
  cap: number,
  onHit: (ev: Event, index: number, text: string, snippet: string) => void,
): void {
  let n = 0;
  for (let i = 0; i < events.length && n < cap; i++) {
    const e = events[i]!;
    const searchable = textOf(e, includeTools);
    if (!searchable) continue;
    const m = matcher.locate(searchable);
    if (!m) continue;
    onHit(e, i, searchable, snippet(searchable, m.index, m.length));
    n++;
  }
}

function textOf(e: Event, includeTools: boolean): string {
  if (e.role === "user" || e.role === "assistant") {
    let s = e.text;
    if (includeTools && e.tools?.length) {
      s += " " + e.tools.map((t) => `${t.name} ${typeof t.input === "string" ? t.input : JSON.stringify(t.input ?? "")}`).join(" ");
    }
    return s;
  }
  if (includeTools && e.role === "tool_result") return e.text;
  return "";
}

function findMatch(text: string, re: RegExp | null, query: string): { index: number; length: number } | null {
  if (re) {
    const m = re.exec(text);
    re.lastIndex = 0;
    return m ? { index: m.index, length: m[0].length || 1 } : null;
  }
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  return i >= 0 ? { index: i, length: query.length } : null;
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_PAD);
  const end = Math.min(text.length, index + length + SNIPPET_PAD);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}

// The turn whose span contains event index `i` (last turn-start at or before i).
function turnOf(starts: number[], i: number): number | null {
  let t = -1;
  for (let k = 0; k < starts.length; k++) {
    if (starts[k]! <= i) t = k;
    else break;
  }
  return t >= 0 ? t : null;
}

// The caller's own session id, if an adapter can name it from the environment
// (Tier A in log.ts). Used to exclude it from results by default.
function currentSessionNativeId(): string | null {
  for (const adapter of ADAPTERS) {
    const id = adapter.resolveCurrentSession();
    if (id) {
      const r = resolveSession(id);
      if (r.row) return r.row.native_id;
    }
  }
  return null;
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
