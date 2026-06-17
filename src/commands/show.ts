// `lb show <session_id>` — understand a session, then drill in.
//   (default)       → the MAP: worklog groups (or a flat turn outline) + heatmap.
//                     Bodies are NOT included — this is how you read long sessions.
//   --turn <n>      → open one user turn's messages (from the map's `turn` handle)
//   --log <id>      → open one worklog span's messages
//   --agent <id>    → descend into a subagent transcript
//   --role all      → the full transcript (paged); --role assistant = assistant only
//   --tool <id>     → full untruncated result of ONE tool call
//   --expand-tools / --max-chars / --limit / --offset / --deliver

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { reindex } from "../indexer.ts";
import { resolveSession, resolveThread, worklogById, threadByToolUseId, worklogFor } from "../queries.ts";
import type { WorklogRow } from "../queries.ts";
import { adapterFor } from "../adapters/registry.ts";
import { cleanPrompt } from "../adapters/claude.ts";
import type { Event, ToolCall, Adapter } from "../adapters/types.ts";
import { emit, errNotFound, errUsage, errEmpty } from "../output.ts";
import { usageString } from "../spec.ts";
import { BIN_NAME } from "../constants.ts";
import { shortId } from "./list.ts";
import type { Invocation } from "../parse.ts";

const MAP_TEXT = 100; // outline text clip — short by design; use --turn for full text

function shortTool(id: string): string {
  return id.length > 8 ? id.slice(-6) : id;
}
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function runShow(inv: Invocation): void {
  reindex();
  const idArg = inv.args.session_id!;
  const res = resolveSession(idArg);
  const usage = usageString(inv.command);
  if (res.ambiguous) {
    throw errUsage(
      `ambiguous session id ${JSON.stringify(idArg)}`,
      usage,
      `use a longer prefix or full id — matches: ${res.ambiguous.map((s) => shortId(s.native_id)).join(", ")}`,
    );
  }
  if (!res.row) {
    throw errNotFound(
      "session",
      idArg,
      `the id is a bare positional from \`${BIN_NAME} list\` (e.g. \`${BIN_NAME} show 9a6282d1\`); run \`${BIN_NAME} list\` to see ids`,
      usage,
    );
  }
  const session = res.row;
  const adapter = adapterFor(session.agent as any);
  if (!adapter) throw errNotFound("agent", session.agent, "unsupported agent");

  const maxChars = typeof inv.flags["max-chars"] === "number" ? inv.flags["max-chars"] : 2000;
  const role = typeof inv.flags.role === "string" ? inv.flags.role : "all";
  const expandTools = inv.flags["expand-tools"] === true;

  // --- Descend into a subagent transcript --------------------------------
  if (typeof inv.flags.agent === "string") {
    const thread = resolveThread(session.native_id, inv.flags.agent);
    if (!thread)
      throw errNotFound(
        "subagent",
        inv.flags.agent,
        `subagent (agent) ids appear on \`kind:task\` tool entries in the default \`${BIN_NAME} show\` output`,
        `${BIN_NAME} show ${shortId(session.native_id)} --agent <agent_id>`,
      );
    const claude = adapterFor("claude")!;
    const events = claude.readEvents(thread.path);
    emitMessages(shortId(session.native_id), `agent:${shortId(thread.agent_id)}`, buildNarrative(events, role, maxChars, expandTools), inv, {
      agent_type: thread.agent_type,
      description: thread.description,
    });
    return;
  }

  // --- Load events (full session or a worklog span) ----------------------
  let events: Event[];
  let scope = "full";
  if (typeof inv.flags.log === "string") {
    const w = worklogById(session.native_id, inv.flags.log);
    if (!w)
      throw errNotFound(
        "log",
        inv.flags.log,
        `worklog ids (lg_…) are nested under each session in \`${BIN_NAME} list\``,
        `${BIN_NAME} show ${shortId(session.native_id)} --log <log_id>`,
      );
    const slice = readSlice(session.path, w.from_offset ?? 0, w.to_offset ?? undefined);
    events = adapter.parseContent(slice);
    scope = `log:${w.id}`;
  } else {
    events = adapter.readEvents(session.path);
  }

  // --- Expand one user turn (from the --role user table of contents) -----
  if (typeof inv.flags.turn === "number") {
    const starts = userTurnStarts(events);
    const n = inv.flags.turn;
    if (n < 0 || n >= starts.length) {
      throw errNotFound(
        "turn",
        String(n),
        `this session has ${starts.length} user turns (0–${starts.length - 1}); see them in the map: \`${BIN_NAME} show ${shortId(session.native_id)}\``,
        `${BIN_NAME} show ${shortId(session.native_id)} --turn <n>`,
      );
    }
    events = events.slice(starts[n]!, starts[n + 1] ?? events.length);
    scope = `turn:${n}`;
  }

  // --- Level 4: one full tool result -------------------------------------
  if (typeof inv.flags.tool === "string") {
    const want = inv.flags.tool;
    const resultMap = toolResultMap(events);
    for (const e of events) {
      for (const t of e.tools ?? []) {
        if (t.id === want || shortTool(t.id) === want || t.id.endsWith(want)) {
          emit(
            {
              session: shortId(session.native_id),
              tool: { id: shortTool(t.id), name: t.name, input: t.input, result: resultMap.get(t.id) ?? null },
            },
            inv.mode,
          );
          return;
        }
      }
    }
    throw errNotFound(
      "tool",
      want,
      `tool ids appear on each tool entry in the default \`${BIN_NAME} show\` output`,
      `${BIN_NAME} show ${shortId(session.native_id)} --tool <tool_id>`,
    );
  }

  // Default view = the MAP (understand). Any of --log/--turn/--role/--expand-tools
  // opts into reading actual messages.
  const messagesView =
    inv.flags.log !== undefined ||
    inv.flags.turn !== undefined ||
    inv.flags.role !== undefined ||
    inv.flags["expand-tools"] === true;

  if (!messagesView) {
    const wl = worklogFor(session.native_id);
    const turnOffsets = wl.length ? turnByteOffsets(session.path, adapter) : [];
    deliver(buildMap(shortId(session.native_id), events, wl, inv, turnOffsets), inv);
    return;
  }

  const messages = buildNarrative(events, role, maxChars, expandTools);
  if (messages.length === 0) throw errEmpty("no messages match");
  emitMessages(shortId(session.native_id), scope, messages, inv);
}

// Bound + paginate a message list so super-long sessions never flood the
// caller. Default page size comes from --limit; --offset pages through.
// Emits a truncation hint that teaches how to get more (Principle 5).
function emitMessages(
  sessionId: string,
  scope: string,
  messages: any[],
  inv: Invocation,
  extra: Record<string, unknown> = {},
): void {
  const { page, more } = paginate(messages, inv);
  deliver({ session: sessionId, scope, ...extra, messages: page, ...(more ? { more } : {}) }, inv);
}

// Bound a list to one page. Returns the page and, only when there's more (or
// we're past the start), a compact structured `more` (no prose — agents page
// off this, they don't parse a hint string).
function paginate<T>(items: T[], inv: Invocation): { page: T[]; more?: { shown: number; total: number; next_offset?: number } } {
  const limit = typeof inv.flags.limit === "number" ? inv.flags.limit : 40;
  const offset = typeof inv.flags.offset === "number" ? inv.flags.offset : 0;
  const page = items.slice(offset, offset + limit);
  const end = offset + page.length;
  if (offset === 0 && end >= items.length) return { page };
  const more: { shown: number; total: number; next_offset?: number } = { shown: page.length, total: items.length };
  if (end < items.length) more.next_offset = end;
  return { page, more };
}

// Build a `then` object, omitting zero fields (and itself when both are zero).
function thenObj(replies: number, tools: number): { replies?: number; tool_calls?: number } | undefined {
  const o: { replies?: number; tool_calls?: number } = {};
  if (replies) o.replies = replies;
  if (tools) o.tool_calls = tools;
  return o.replies || o.tool_calls ? o : undefined;
}

// Build the narrative message list for a messages view (--role / --turn / --log).
export function buildNarrative(events: Event[], role: string, maxChars: number, expandTools: boolean) {
  const resultMap = toolResultMap(events);
  const out: any[] = [];
  for (const e of events) {
    if (e.role !== "user" && e.role !== "assistant") continue;
    if (role !== "all" && e.role !== role) continue;
    const msg: any = { role: e.role };
    if (e.text) msg.text = truncate(e.text, maxChars);
    if (e.tools?.length) msg.tools = e.tools.map((t) => renderTool(t, resultMap, maxChars, expandTools));
    if (msg.text || msg.tools) out.push(msg);
  }
  return out;
}

function renderTool(t: ToolCall, resultMap: Map<string, string>, maxChars: number, expand: boolean) {
  const id = shortTool(t.id);
  const base: any = t.isTask ? { id, kind: "task" } : { id };
  if (t.isTask) {
    const link = threadByToolUseId(t.id);
    if (link) base.agent = shortId(link.agent_id);
  }
  if (expand) {
    base.name = t.name;
    if (t.input !== undefined) base.input = t.input;
    const r = resultMap.get(t.id);
    if (r != null) base.result = truncate(r, maxChars);
  } else {
    base.summary = t.inputSummary ?? t.name;
  }
  return base;
}

// Event indices that begin a user turn, in order. Index N == the `turn: N` in
// the map. Uses the same cleanPrompt filter as the map so ordinals line up
// (a command-wrapper/interrupt-only line is not a turn in either place).
export function userTurnStarts(events: Event[]): number[] {
  const idx: number[] = [];
  events.forEach((e, i) => {
    if (e.role === "user" && cleanPrompt(e.text)) idx.push(i);
  });
  return idx;
}

// --- the MAP (default `show`) -----------------------------------------------

interface RawTurn { turn: number; mi: number; text: string; replies: number; tools: number }
interface MapTurn { turn: number; mi: number; text: string; then: { replies: number; tool_calls: number }; repeats?: number }

// Walk events into user turns. `mi` = index among user+assistant messages
// (matches worklog.msg_count, so spans bucket cleanly). Empty/wrapper-only user
// lines are counted as messages but are not turns.
export function collectTurns(events: Event[]): RawTurn[] {
  const turns: RawTurn[] = [];
  let cur: RawTurn | null = null;
  let msgIdx = 0;
  let turnNo = 0;
  for (const e of events) {
    const isMsg = e.role === "user" || e.role === "assistant";
    if (e.role === "user") {
      const text = cleanPrompt(e.text);
      if (text) {
        cur = { turn: turnNo++, mi: msgIdx, text, replies: 0, tools: 0 };
        turns.push(cur);
      } else cur = null;
    } else if (e.role === "assistant" && cur) {
      cur.replies++;
      cur.tools += e.tools?.length ?? 0;
    }
    if (isMsg) msgIdx++;
  }
  return turns;
}

// Collapse consecutive identical-text turns (Claude re-records prompts at
// summarization/continue boundaries). Keep the LAST ordinal (it carries the
// real activity), sum the counts, note `repeats`.
export function collapseTurns(raw: RawTurn[]): MapTurn[] {
  const out: MapTurn[] = [];
  for (const t of raw) {
    const prev = out[out.length - 1];
    if (prev && prev.text === t.text) {
      prev.turn = t.turn;
      prev.mi = t.mi;
      prev.then.replies += t.replies;
      prev.then.tool_calls += t.tools;
      prev.repeats = (prev.repeats ?? 1) + 1;
    } else {
      out.push({ turn: t.turn, mi: t.mi, text: t.text, then: { replies: t.replies, tool_calls: t.tools } });
    }
  }
  return out;
}

// Byte offset of each user-turn's line, in turn order — the lineage between a
// `turn` ordinal and a file position. Parses line-by-line (reusing the adapter)
// so it stays consistent with collectTurns/userTurnStarts (same cleanPrompt
// predicate). Powers worklog-span grouping and `log --turns`.
export function turnByteOffsets(path: string, adapter: Adapter): number[] {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return [];
  }
  const offsets: number[] = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      if (i > start) {
        const line = buf.toString("utf8", start, i);
        try {
          for (const e of adapter.parseContent(line)) {
            if (e.role === "user" && cleanPrompt(e.text)) {
              offsets.push(start);
              break;
            }
          }
        } catch {
          // unparseable line — not a turn
        }
      }
      start = i + 1;
    }
  }
  return offsets;
}

// The default `show` output: worklog-grouped map (curated) or flat turn outline,
// + the unlogged tail. Bounded by --limit/--offset on the paged portion.
// `turnOffsets[ordinal]` = the byte offset of that turn; worklog spans group by
// offset CONTAINMENT (robust to retro-tagged, non-contiguous, or overlapping
// spans — a turn joins the most specific span that contains it).
export function buildMap(
  sessionId: string,
  events: Event[],
  wl: WorklogRow[],
  inv: Invocation,
  turnOffsets: number[] = [],
) {
  const turns = collapseTurns(collectTurns(events));
  const view = (t: MapTurn) => {
    const th = thenObj(t.then.replies, t.then.tool_calls);
    return {
      turn: t.turn,
      ...(t.repeats ? { repeats: t.repeats } : {}),
      text: truncate(t.text, MAP_TEXT),
      ...(th ? { then: th } : {}),
    };
  };

  // No worklog → flat turn outline (paged).
  if (wl.length === 0) {
    const { page, more } = paginate(turns, inv);
    return { session: sessionId, turns: page.map(view), ...(more ? { more } : {}) };
  }

  const bounds = wl.map((w) => ({
    id: w.id,
    text: w.text,
    body: w.body,
    tags: w.tags,
    from: w.from_offset ?? 0,
    to: w.to_offset ?? Number.MAX_SAFE_INTEGER,
  }));
  // Each turn → the smallest worklog span that contains its byte offset (null = unlogged).
  const groupOf = new Map<MapTurn, string | null>();
  for (const t of turns) {
    const off = turnOffsets[t.turn] ?? -1;
    let best: string | null = null;
    let bestSize = Number.MAX_SAFE_INTEGER;
    for (const b of bounds) {
      if (off >= b.from && off < b.to && b.to - b.from < bestSize) {
        best = b.id;
        bestSize = b.to - b.from;
      }
    }
    groupOf.set(t, best);
  }

  const worklog = bounds.map((b) => {
    const ts = turns.filter((t) => groupOf.get(t) === b.id);
    const total = ts.reduce((a, t) => ({ r: a.r + t.then.replies, t: a.t + t.then.tool_calls }), { r: 0, t: 0 });
    const tt = thenObj(total.r, total.t);
    return {
      id: b.id,
      text: truncate(b.text, 80),
      ...(b.body ? { body: b.body } : {}),
      ...(b.tags ? { tags: b.tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
      ...(tt ? { then_total: tt } : {}),
      ...(ts.length ? { turns: ts.map(view) } : {}), // empty group → just {id,text,…}
    };
  });
  const { page, more } = paginate(turns.filter((t) => groupOf.get(t) === null), inv);
  return { session: sessionId, worklog, unlogged: page.map(view), ...(more ? { more } : {}) };
}

function toolResultMap(events: Event[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) if (e.role === "tool_result" && e.toolResultId) m.set(e.toolResultId, e.text);
  return m;
}

// Read a byte slice [from, to) of a file (offsets are line-aligned in practice).
function readSlice(path: string, from: number, to?: number): string {
  const buf = readFileSync(path);
  const end = to ?? buf.length;
  return buf.subarray(from, end).toString("utf8");
}

// --deliver routing: stdout (default) or file:PATH.
function deliver(data: unknown, inv: Invocation): void {
  const sink = typeof inv.flags.deliver === "string" ? inv.flags.deliver : "stdout";
  if (sink === "stdout") {
    emit(data, inv.mode);
    return;
  }
  if (sink.startsWith("file:")) {
    const path = sink.slice("file:".length);
    const bytes = JSON.stringify(data, null, 2);
    writeFileAtomic(path, bytes);
    emit({ ok: true, delivered_to: `file:${path}`, bytes: Buffer.byteLength(bytes) }, inv.mode);
    return;
  }
  throw errUsage(`--deliver scheme must be one of: stdout, file:<path> (got ${JSON.stringify(sink)})`);
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
