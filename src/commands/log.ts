// `lb log <text>` — append a worklog entry to the current session, auto-resolved
// and auto-spanned. (PLAN.md → Worklog keystone, session-resolution tiers.)

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { reindex } from "../indexer.ts";
import { openDb } from "../db.ts";
import { resolveSession, type SessionRow } from "../queries.ts";
import { ADAPTERS, adapterFor } from "../adapters/registry.ts";
import { turnByteOffsets } from "./show.ts";
import { resolveProject } from "../project.ts";
import { BIN_NAME } from "../constants.ts";
import { emit, errNotFound, errUsage, errEmpty } from "../output.ts";
import { usageString } from "../spec.ts";
import type { Invocation } from "../parse.ts";

export function runLog(inv: Invocation): void {
  reindex();
  const text = (inv.args.text ?? "").trim();
  if (!text) throw errUsage("worklog text is empty", `${usageString(inv.command)}   e.g. ${BIN_NAME} log "fixed the auth bug"`);

  const session = resolveCurrentSession(
    typeof inv.flags.session === "string" ? inv.flags.session : undefined,
  );
  const tags = typeof inv.flags.tags === "string" ? inv.flags.tags : null;
  const body = typeof inv.flags.body === "string" ? inv.flags.body : null;

  // Retro-tag mode: anchor the entry to a specific PAST turn range instead of
  // auto-spanning since the last log. Intended as `show` first → read turn
  // numbers → tag them. Does NOT advance the forward cursor (it's the past).
  if (typeof inv.flags.turns === "string") {
    runRetroLog(inv, session, text, tags, body);
    return;
  }

  // Span = (last_logged_offset, current tail]. Tail = current file size.
  // The cursor survives an index rebuild: if the sessions row was re-derived
  // (last_logged_offset reset to 0) but worklog rows exist, resume from the
  // furthest already-logged offset.
  const db0 = openDb();
  const maxLogged =
    (db0.query("SELECT MAX(to_offset) AS m FROM worklog WHERE session_native_id = ?").get(session.native_id) as {
      m: number | null;
    }).m ?? 0;
  const from = Math.max(session.last_logged_offset ?? 0, maxLogged);
  const tail = fileSize(session.path);
  const capturedMsgs = countMessagesInSlice(session, from, tail);
  const branch = session.branch;

  if (inv.flags["dry-run"] === true) {
    emit(
      { ok: true, dry_run: true, would_log: { session: short(session.native_id), branch, captured_msgs: capturedMsgs } },
      inv.mode,
    );
    return;
  }

  const id = "lg_" + randomBytes(3).toString("hex");
  const hash = contentHash(session.native_id, text);
  const db = openDb();

  const existing = db
    .query("SELECT id FROM worklog WHERE session_native_id = ? AND content_hash = ?")
    .get(session.native_id, hash) as { id: string } | null;
  if (existing) {
    emit({ ok: true, id: existing.id, deduped: true }, inv.mode);
    return;
  }

  // Reject a no-op log: a worklog entry covers the messages since your last log,
  // so logging again with nothing new in between would record an empty span.
  // (One entry per batch of work — see SKILL.)
  if (capturedMsgs === 0) {
    const last = db
      .query("SELECT id FROM worklog WHERE session_native_id = ? ORDER BY to_offset DESC LIMIT 1")
      .get(session.native_id) as { id: string } | null;
    throw errEmpty(
      "no new messages since your last log — nothing to record",
      last
        ? `your last log (${last.id}) already covers up to here; do a batch of work, then log once`
        : "do a batch of work first, then log it",
    );
  }

  db.query(
    `INSERT INTO worklog (id, session_native_id, project, text, body, tags, from_offset, to_offset, msg_count, created_at, content_hash)
     VALUES ($id, $sid, $project, $text, $body, $tags, $from, $to, $count, $created, $hash)`,
  ).run({
    $id: id,
    $sid: session.native_id,
    $project: session.project,
    $text: text,
    $body: body,
    $tags: tags,
    $from: from,
    $to: tail,
    $count: capturedMsgs,
    $created: Date.now(),
    $hash: hash,
  });
  // Advance the cursor so the next log spans only new messages.
  db.query("UPDATE sessions SET last_logged_offset = ? WHERE native_id = ?").run(tail, session.native_id);

  emit({ ok: true, id, captured_msgs: capturedMsgs }, inv.mode);
}

// Retro-tag a past turn range. Maps `--turns A-B` → byte offsets via the same
// turn lineage the map uses, stores the worklog entry over that span, and leaves
// the forward cursor untouched (so normal `log` still spans from where it was).
function runRetroLog(inv: Invocation, session: SessionRow, text: string, tags: string | null, body: string | null): void {
  const adapter = adapterFor(session.agent as any);
  if (!adapter) throw errNotFound("agent", session.agent, "unsupported agent");

  const raw = typeof inv.flags.turns === "string" ? inv.flags.turns : "";
  const m = raw.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) {
    throw errUsage(
      `--turns expects a turn or range like 12 or 12-18 (got ${JSON.stringify(raw)})`,
      `${BIN_NAME} log "<title>" --turns 12-18`,
    );
  }
  const fromTurn = Number(m[1]);
  const toTurn = m[2] !== undefined ? Number(m[2]) : fromTurn;
  const offsets = turnByteOffsets(session.path, adapter);
  if (fromTurn > toTurn || fromTurn < 0 || toTurn >= offsets.length) {
    throw errUsage(
      offsets.length
        ? `turn range ${fromTurn}-${toTurn} is out of bounds — this session has ${offsets.length} turns (0–${offsets.length - 1})`
        : "this session has no addressable turns",
      `inspect turns with \`${BIN_NAME} show ${short(session.native_id)}\`, then \`${BIN_NAME} log "<title>" --turns <a-b>\``,
    );
  }

  const fromOff = offsets[fromTurn]!;
  const toOff = toTurn + 1 < offsets.length ? offsets[toTurn + 1]! : fileSize(session.path);
  const msgs = countMessagesInSlice(session, fromOff, toOff);

  if (inv.flags["dry-run"] === true) {
    emit({ ok: true, dry_run: true, would_log: { session: short(session.native_id), turns: `${fromTurn}-${toTurn}`, captured_msgs: msgs } }, inv.mode);
    return;
  }

  const db = openDb();
  const hash = contentHash(session.native_id, text);
  const existing = db
    .query("SELECT id FROM worklog WHERE session_native_id = ? AND content_hash = ?")
    .get(session.native_id, hash) as { id: string } | null;
  if (existing) {
    emit({ ok: true, id: existing.id, deduped: true }, inv.mode);
    return;
  }
  const id = "lg_" + randomBytes(3).toString("hex");
  db.query(
    `INSERT INTO worklog (id, session_native_id, project, text, body, tags, from_offset, to_offset, msg_count, created_at, content_hash)
     VALUES ($id, $sid, $project, $text, $body, $tags, $from, $to, $count, $created, $hash)`,
  ).run({
    $id: id,
    $sid: session.native_id,
    $project: session.project,
    $text: text,
    $body: body,
    $tags: tags,
    $from: fromOff,
    $to: toOff,
    $count: msgs,
    $created: Date.now(),
    $hash: hash,
  });
  // Intentionally NOT advancing last_logged_offset — a retro-tag describes the
  // past; the forward cursor keeps spanning from where it was.
  emit({ ok: true, id, captured_msgs: msgs, turns: `${fromTurn}-${toTurn}` }, inv.mode);
}

// Resolve the session this `log` belongs to. Tiers (PLAN.md):
//   A) explicit --session, or an env var the agent exports (Claude/Hermes)
//   B) mtime fallback — newest session in the current project
function resolveCurrentSession(override: string | undefined): SessionRow {
  if (override) {
    const r = resolveSession(override);
    if (r.row) return r.row;
    throw errNotFound("session", override, "this --session id isn't indexed; run `lb list --all` to see ids", `${BIN_NAME} log "<text>" --session <id>`);
  }
  // Tier A: ask each adapter for the calling agent's own session id.
  for (const adapter of ADAPTERS) {
    const id = adapter.resolveCurrentSession();
    if (id) {
      const r = resolveSession(id);
      if (r.row) return r.row;
    }
  }
  // Tier B: newest session in the current project.
  const project = resolveProject(process.cwd());
  const db = openDb();
  const row = db
    .query("SELECT * FROM sessions WHERE project = ? ORDER BY last_ts DESC LIMIT 1")
    .get(project) as SessionRow | null;
  if (row) return row;
  throw errNotFound(
    "session",
    "current",
    "no session in this project yet — run an agent here first, or pass --session <id> (see `lb list --all`)",
    `${BIN_NAME} log "<text>"`,
  );
}

function countMessagesInSlice(session: SessionRow, from: number, to: number): number {
  const adapter = adapterFor(session.agent as any);
  if (!adapter) return 0;
  try {
    const buf = readFileSync(session.path);
    const slice = buf.subarray(from, to).toString("utf8");
    return adapter.parseContent(slice).filter((e) => e.role === "user" || e.role === "assistant").length;
  } catch {
    return 0;
  }
}

function fileSize(path: string): number {
  try {
    return Bun.file(path).size;
  } catch {
    return 0;
  }
}

function contentHash(sessionId: string, text: string): string {
  return Bun.hash(sessionId + " " + text).toString(16);
}

function short(id: string): string {
  return id.slice(0, 8);
}
