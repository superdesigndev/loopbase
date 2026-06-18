// `lb list` — table of contents: sessions for the current project, each with
// its worklog entries nested. (PLAN.md → Command surface, Example I/O.)

import { reindex } from "../indexer.ts";
import { listSessions, countSessions, countSubagents, worklogFor, recentWorklog, countWorklog } from "../queries.ts";
import { resolveProject } from "../project.ts";
import { parseDuration, relativeTime } from "../time.ts";
import { emit, errUsage } from "../output.ts";
import { BIN_NAME } from "../constants.ts";
import type { Invocation } from "../parse.ts";

export function shortId(id: string): string {
  // pi/codex ids look like 019ed3f3-…; claude are uuids. 8 hex chars is plenty.
  return id.slice(0, 8);
}

interface OutSession {
  id: string;
  agent: string;
  branch: string | null;
  title: string | null; // native title if the provider has one, else first user message
  updated: string;
  msgs: number;
  subagents: number;
  worklog: { id: string; text: string; body?: string; tags?: string[]; msgs: number | null }[];
}

// Render a worklog row for output, omitting empty body/tags.
export function worklogView(w: { id: string; text: string; body: string | null; tags: string | null; msg_count: number | null }) {
  return {
    id: w.id,
    text: w.text,
    ...(w.body ? { body: w.body } : {}),
    ...(w.tags ? { tags: w.tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
    msgs: w.msg_count,
  };
}

export function runList(inv: Invocation): void {
  reindex(); // daemonless: refresh on call

  const all = inv.flags.all === true;
  const path = typeof inv.flags.path === "string" ? inv.flags.path : process.cwd();
  const project = all ? null : resolveProject(path);

  let sinceMs: number | null = null;
  if (typeof inv.flags.since === "string") {
    const d = parseDuration(inv.flags.since);
    if (d == null)
      throw errUsage(
        `--since expects a duration like 24h, 7d, 30m (got ${JSON.stringify(inv.flags.since)})`,
        `${BIN_NAME} list --since 24h`,
      );
    sinceMs = Date.now() - d;
  }

  const limit = typeof inv.flags.limit === "number" ? inv.flags.limit : 20;
  const agent = typeof inv.flags.agent === "string" ? inv.flags.agent : undefined;
  const filter = { project, all, sinceMs, agent, limit };
  const projectLabel = all ? "(all)" : project;

  // --logs → a flat, cross-session worklog feed (LOG.md-style), newest first.
  if (inv.flags.logs === true) {
    const now = Date.now();
    const logs = recentWorklog(filter).map((w) => ({
      id: w.id,
      session: shortId(w.session_native_id),
      agent: w.agent,
      when: relativeTime(w.created_at, now),
      title: w.text,
      ...(w.body ? { body: w.body } : {}),
      ...(w.tags ? { tags: w.tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
      msgs: w.msg_count,
    }));
    const more = moreSignal(logs.length, countWorklog(filter));
    emit({ project: projectLabel, logs, ...(more ? { more } : {}) }, inv.mode, renderLogsText);
    return;
  }

  const rows = listSessions(filter);
  const now = Date.now();

  const sessions: OutSession[] = rows.map((r) => ({
    id: shortId(r.native_id),
    agent: r.agent,
    branch: r.branch,
    title: r.title,
    updated: relativeTime(r.last_ts, now),
    msgs: r.msg_count,
    subagents: countSubagents(r.native_id),
    worklog: worklogFor(r.native_id).map(worklogView),
  }));

  const more = moreSignal(sessions.length, countSessions(filter));
  emit({ project: projectLabel, sessions, ...(more ? { more } : {}) }, inv.mode, renderText);
}

// When the result hit `--limit` and more rows exist, tell the caller how to get
// them (Principle 5: truncation should teach how to narrow). Absent = not truncated.
interface MoreSignal {
  shown: number;
  total: number;
  hint: string;
}
function moreSignal(shown: number, total: number): MoreSignal | undefined {
  if (shown >= total) return undefined;
  return { shown, total, hint: `${total - shown} more — raise --limit or narrow with --since` };
}

interface OutLog {
  id: string;
  session: string;
  agent: string | null;
  when: string;
  title: string;
  body?: string;
  tags?: string[];
  msgs: number | null;
}

function renderLogsText(data: { project: string | null; logs: OutLog[]; more?: MoreSignal }): string {
  const lines: string[] = [`${data.project ?? "(all)"} — recent work`];
  if (data.logs.length === 0) lines.push("  (no worklog entries yet)");
  for (const l of data.logs) {
    const tags = l.tags?.length ? "  " + l.tags.map((t) => `#${t}`).join(" ") : "";
    lines.push(`${l.when.padStart(8)}  ${l.id}  ${l.session} ${l.agent ?? "-"}  ${l.title}${tags}`);
    if (l.body) lines.push(`            ${l.body}`);
  }
  if (data.more) lines.push(`… ${data.more.hint}`);
  lines.push("");
  lines.push(`dive: \`${BIN_NAME} show <session> --log <id>\``);
  return lines.join("\n");
}

function renderText(data: { project: string | null; sessions: OutSession[]; more?: MoreSignal }): string {
  const lines: string[] = [];
  lines.push(`${data.project ?? "(no project)"}`);
  if (data.sessions.length === 0) lines.push("  (no sessions)");
  for (const s of data.sessions) {
    const sub = s.subagents ? ` · ${s.subagents} subagents` : "";
    lines.push(`● ${s.id}  ${s.agent} · ${s.branch ?? "-"} · ${s.msgs} msgs · ${s.updated}${sub}`);
    lines.push(`  ${JSON.stringify(s.title ?? "")}`);
    s.worklog.forEach((w, i) => {
      const branch = i === s.worklog.length - 1 ? "└─" : "├─";
      lines.push(`  ${branch} ${w.id}  ${w.text}  (${w.msgs ?? "?"} msgs)`);
    });
  }
  if (data.more) lines.push(`… ${data.more.hint}`);
  return lines.join("\n");
}
