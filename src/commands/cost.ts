// `lb cost` — token + USD cost per session (memoized at index time). Reads the
// session_cost rollup; per-message rows are only touched for a single-session
// breakdown. (docs/cost-plan.md → Phase 5.)

import { reindex } from "../indexer.ts";
import { openDb } from "../db.ts";
import {
  costForProject,
  costSummaryByModel,
  sessionCostBreakdown,
  resolveSession,
  type SessionCostRow,
  type ModelCostRow,
} from "../queries.ts";
import { resolveProject } from "../project.ts";
import { parseDuration, relativeTime } from "../time.ts";
import { emit, errUsage, errNotFound } from "../output.ts";
import { BIN_NAME } from "../constants.ts";
import { loadCatalog, refreshCatalog } from "../pricing.ts";
import { repriceAll } from "../cost-index.ts";
import { shortId } from "./list.ts";
import type { Invocation } from "../parse.ts";

// USD with a stable 2-4 sig-fig feel; null → "unpriced" (never $0).
function usd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "unpriced";
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

export async function runCost(inv: Invocation): Promise<void> {
  // --refresh: pull upstream prices, then reprice stored history before reading.
  if (inv.flags.refresh === true) {
    const { version } = await refreshCatalog();
    const { catalog } = loadCatalog();
    const n = repriceAll(openDb(), catalog, version);
    emit({ ok: true, refreshed: true, version, repricedMessages: n }, inv.mode, (d) => `refreshed prices → ${d.version}; repriced ${d.repricedMessages} message rows`);
    return;
  }

  reindex(); // daemonless: fresh on call

  const all = inv.flags.all === true;
  const path = typeof inv.flags.path === "string" ? inv.flags.path : process.cwd();
  const project = all ? null : resolveProject(path);
  const limit = typeof inv.flags.limit === "number" ? inv.flags.limit : 20;
  const agent = typeof inv.flags.agent === "string" ? inv.flags.agent : undefined;

  let sinceMs: number | null = null;
  if (typeof inv.flags.since === "string") {
    const d = parseDuration(inv.flags.since);
    if (d == null) throw errUsage(`--since expects a duration like 24h, 7d, 30m (got ${JSON.stringify(inv.flags.since)})`, `${BIN_NAME} cost --since 7d`);
    sinceMs = Date.now() - d;
  }

  // Single-session breakdown.
  const sid = inv.args.session_id;
  if (sid) {
    const { row, ambiguous } = resolveSession(sid);
    if (!row) {
      if (ambiguous?.length) throw errNotFound("session", sid, `ambiguous prefix matches ${ambiguous.length} sessions`, `${BIN_NAME} cost ${ambiguous[0]!.native_id}`);
      throw errNotFound("session", sid, "no session with that id/prefix", `${BIN_NAME} list`);
    }
    const breakdown = sessionCostBreakdown(row.native_id);
    const total = breakdown.reduce<number | null>((s, r) => (r.total_usd === null ? s : (s ?? 0) + r.total_usd), null);
    emit(
      { session: row.native_id, agent: row.agent, title: row.title, total_usd: total, models: breakdown.map(modelView) },
      inv.mode,
      () => renderBreakdown(row.native_id, breakdown, total),
    );
    return;
  }

  const f = { project, all, sinceMs, agent, limit };

  // --summary: spend grouped by model.
  if (inv.flags.summary === true) {
    const rows = costSummaryByModel(f);
    const total = rows.reduce<number | null>((s, r) => (r.total_usd === null ? s : (s ?? 0) + r.total_usd), null);
    emit({ project: all ? "(all)" : project, total_usd: total, models: rows }, inv.mode, () => renderSummary(rows, total));
    return;
  }

  // Default: per-session list.
  const rows = costForProject(f);
  const total = rows.reduce<number | null>((s, r) => (r.total_usd === null ? s : (s ?? 0) + r.total_usd), null);
  emit({ project: all ? "(all)" : project, total_usd: total, sessions: rows.map(sessionView) }, inv.mode, () => renderList(project, all, rows, total));
}

function sessionView(r: SessionCostRow) {
  return {
    id: shortId(r.native_id),
    agent: r.agent,
    title: r.title,
    updated: relativeTime(r.last_ts, Date.now()),
    msgs: r.msg_count,
    tokens: r.total_tokens,
    cost_usd: r.total_usd,
    estimated: r.estimated === 1,
  };
}

function modelView(r: ModelCostRow) {
  return {
    model: r.model,
    tokens: r.input_tokens + r.output_tokens,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cost_usd: r.total_usd,
    token_source: r.token_source,
  };
}

function renderList(project: string | null, all: boolean, rows: SessionCostRow[], total: number | null): string {
  const lines: string[] = [`${all ? "(all)" : (project ?? "(no project)")} — cost  total ${usd(total)}`];
  if (rows.length === 0) lines.push("  (no sessions)");
  for (const r of rows) {
    const est = r.estimated === 1 ? " ~" : "";
    lines.push(`${usd(r.total_usd).padStart(9)}${est}  ${shortId(r.native_id)}  ${r.agent}  ${(r.total_tokens / 1000).toFixed(0)}k tok  ${relativeTime(r.last_ts, Date.now())}  ${JSON.stringify(r.title ?? "")}`);
  }
  lines.push("");
  lines.push(`breakdown: \`${BIN_NAME} cost <session>\` · by model: \`${BIN_NAME} cost --summary\``);
  return lines.join("\n");
}

function renderSummary(rows: { model: string | null; agent: string; sessions: number; total_usd: number | null; total_tokens: number }[], total: number | null): string {
  const lines: string[] = [`cost by model  total ${usd(total)}`];
  for (const r of rows) {
    lines.push(`${usd(r.total_usd).padStart(9)}  ${(r.model ?? "(unknown)").padEnd(20)}  ${r.agent}  ${r.sessions} sess  ${(r.total_tokens / 1000).toFixed(0)}k tok`);
  }
  return lines.join("\n");
}

function renderBreakdown(nativeId: string, rows: ModelCostRow[], total: number | null): string {
  const lines: string[] = [`${shortId(nativeId)} — cost  total ${usd(total)}`];
  for (const r of rows) {
    const src = r.token_source === "byte_estimate" ? " ~est" : "";
    lines.push(`${usd(r.total_usd).padStart(9)}  ${(r.model ?? "(unknown)").padEnd(20)}  in ${r.input_tokens} out ${r.output_tokens} cacheR ${r.cache_read_tokens}${src}`);
  }
  return lines.join("\n");
}
