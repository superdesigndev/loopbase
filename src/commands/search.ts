// `lb search <query>` — content-addressed entry point: find sessions/turns by
// what was said, across agents, then dive with `lb show --turn <n>`. On-demand
// scan (no FTS index): a raw-substring pre-filter avoids parsing files that
// can't match; only hits are parsed + mapped to turn handles. (PLAN.md → search.)

import { readFileSync } from "node:fs";
import { reindex } from "../indexer.ts";
import { listSessions, threadsForParent, resolveSession, type SessionRow } from "../queries.ts";
import { adapterFor } from "../adapters/registry.ts";
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
  const filesOnly = inv.flags.files === true;
  const limit = typeof inv.flags.limit === "number" ? inv.flags.limit : 20;

  let sinceMs: number | null = null;
  if (typeof inv.flags.since === "string") {
    const d = parseDuration(inv.flags.since);
    if (d == null) throw errUsage(`--since expects a duration like 24h, 7d (got ${JSON.stringify(inv.flags.since)})`, `${BIN_NAME} search "<q>" --since 7d`);
    sinceMs = Date.now() - d;
  }

  // In-scope sessions (newest first, unbounded — we cap matches, not sessions).
  let sessions: SessionRow[];
  if (typeof inv.flags.session === "string") {
    const r = resolveSession(inv.flags.session);
    if (!r.row) throw errNotFound("session", inv.flags.session, `run \`${BIN_NAME} list\` to see ids`);
    sessions = [r.row];
  } else {
    const project = all ? null : resolveProject(typeof inv.flags.path === "string" ? inv.flags.path : process.cwd());
    const agent = typeof inv.flags.agent === "string" ? inv.flags.agent : undefined;
    sessions = listSessions({ project, all, sinceMs, agent, limit: 100_000 });
  }
  const scopeLabel = all ? "(all)" : typeof inv.flags.session === "string" ? shortId(inv.flags.session) : (sessions[0]?.project ?? null);
  const now = Date.now();
  const hit = (raw: string) => (re ? re.test(raw) : raw.toLowerCase().includes(query.toLowerCase()));

  // --files: grep -l style — matching sessions + raw paths, for custom piping.
  if (filesOnly) {
    const files: any[] = [];
    for (const s of sessions) {
      const candidates = [
        { session: s.native_id, agent: s.agent, path: s.path, kind: "session" as const, agent_id: null as string | null },
        ...threadsForParent(s.native_id).map((t) => ({ session: s.native_id, agent: s.agent, path: t.path, kind: "subagent" as const, agent_id: t.agent_id })),
      ];
      for (const c of candidates) {
        const raw = safeRead(c.path);
        if (raw && hit(raw)) {
          files.push({ session: shortId(c.session), agent: c.agent, ...(c.agent_id ? { subagent: shortId(c.agent_id) } : {}), path: c.path });
          if (files.length >= limit) break;
        }
      }
      if (files.length >= limit) break;
    }
    emit({ query, project: scopeLabel, files }, inv.mode);
    return;
  }

  const matches: any[] = [];
  let more = false;
  for (const s of sessions) {
    const adapter = adapterFor(s.agent as any);
    if (!adapter) continue;

    // Main session (turn handles).
    const rawMain = safeRead(s.path);
    if (rawMain && hit(rawMain)) {
      const events = adapter.parseContent(rawMain);
      const starts = userTurnStarts(events);
      scanEvents(events, includeTools, re, query, MATCHES_PER_FILE, (ev, i, snip) => {
        matches.push({ session: shortId(s.native_id), agent: s.agent, turn: turnOf(starts, i), role: ev.role, when: relativeTime(ev.ts ?? s.last_ts, now), snippet: snip, path: s.path });
      });
    }
    // Subagents (agent handle — dive via `show <session> --agent <id>`).
    for (const t of threadsForParent(s.native_id)) {
      const raw = safeRead(t.path);
      if (!raw || !hit(raw)) continue;
      const claude = adapterFor("claude")!;
      const events = claude.parseContent(raw);
      scanEvents(events, includeTools, re, query, MATCHES_PER_FILE, (ev, _i, snip) => {
        matches.push({ session: shortId(s.native_id), agent: s.agent, subagent: shortId(t.agent_id), role: ev.role, when: relativeTime(ev.ts ?? s.last_ts, now), snippet: snip, path: t.path });
      });
    }
    if (matches.length >= limit) {
      more = true;
      break;
    }
  }

  emit(
    {
      query,
      project: scopeLabel,
      matches: matches.slice(0, limit),
      ...(more || matches.length > limit
        ? { more: { shown: Math.min(limit, matches.length), note: "more matches — narrow with --since / --agent / --session or a more specific query" } }
        : {}),
    },
    inv.mode,
  );
}

// Search an event list, calling `onHit` for matching messages (capped per file).
function scanEvents(
  events: Event[],
  includeTools: boolean,
  re: RegExp | null,
  query: string,
  cap: number,
  onHit: (ev: Event, index: number, snippet: string) => void,
): void {
  let n = 0;
  for (let i = 0; i < events.length && n < cap; i++) {
    const e = events[i]!;
    const searchable = textOf(e, includeTools);
    if (!searchable) continue;
    const m = findMatch(searchable, re, query);
    if (!m) continue;
    onHit(e, i, snippet(searchable, m.index, m.length));
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

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
