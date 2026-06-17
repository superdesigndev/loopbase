// `lb list` — table of contents: sessions for the current project, each with
// its worklog entries nested. (PLAN.md → Command surface, Example I/O.)

import { reindex } from "../indexer.ts";
import { listSessions, countSubagents, worklogFor, recentWorklog } from "../queries.ts";
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

  // --logs → a flat, cross-session worklog feed (LOG.md-style), newest first.
  if (inv.flags.logs === true) {
    const now = Date.now();
    const logs = recentWorklog({ project, all, sinceMs, agent, limit }).map((w) => ({
      id: w.id,
      session: shortId(w.session_native_id),
      agent: w.agent,
      when: relativeTime(w.created_at, now),
      title: w.text,
      ...(w.body ? { body: w.body } : {}),
      ...(w.tags ? { tags: w.tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
      msgs: w.msg_count,
    }));
    emit({ project: all ? "(all)" : project, logs }, inv.mode, renderLogsText);
    return;
  }

  const rows = listSessions({ project, all, sinceMs, agent, limit });
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

  emit({ project: all ? "(all)" : project, sessions }, inv.mode, renderText);
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

function renderLogsText(data: { project: string | null; logs: OutLog[] }): string {
  const lines: string[] = [`${data.project ?? "(all)"} — recent work`];
  if (data.logs.length === 0) lines.push("  (no worklog entries yet)");
  for (const l of data.logs) {
    const tags = l.tags?.length ? "  " + l.tags.map((t) => `#${t}`).join(" ") : "";
    lines.push(`${l.when.padStart(8)}  ${l.id}  ${l.session} ${l.agent ?? "-"}  ${l.title}${tags}`);
    if (l.body) lines.push(`            ${l.body}`);
  }
  lines.push("");
  lines.push(`dive: \`${BIN_NAME} show <session> --log <id>\``);
  return lines.join("\n");
}

function renderText(data: { project: string | null; sessions: OutSession[] }): string {
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
  return lines.join("\n");
}
