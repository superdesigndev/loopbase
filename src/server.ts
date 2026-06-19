// `lb serve` backend: a tiny read-only JSON API + a self-contained SPA over the
// same graph. Daemonless spirit — each /api call runs the incremental reindex()
// first, so the page is fresh on load. No build step, no framework.
// (docs/cost-plan.md → Phase 6.)

import { reindex } from "./indexer.ts";
import {
  costForProject,
  costSummaryByModel,
  sessionCostBreakdown,
  resolveSession,
  worklogFor,
  recentWorklog,
  logBatchCost,
  type ListFilter,
} from "./queries.ts";
import { adapterFor } from "./adapters/registry.ts";
import { ANALYZERS, ANALYZER_NAMES, DEFAULT_ANALYZERS, type InsightFilter } from "./insights.ts";
import { shortId } from "./commands/list.ts";
import { userTurnStarts } from "./commands/show.ts";
import { parseDuration } from "./time.ts";
import { INDEX_HTML } from "./web/index-html.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// Per-request reindex is a freshness nicety, NOT a hard dependency — the index
// already holds prior data. A transient failure (a concurrent `lb log` holding
// the write lock past busy_timeout, one unparseable transcript) must not 500 the
// whole endpoint, or the dashboard shows a silent "error". Log + serve stale.
function freshen(): void {
  if (process.env.LB_SKIP_REINDEX === "1") return;
  try {
    reindex();
  } catch (e) {
    console.error("[serve] reindex failed; serving the existing index:", e);
  }
}

function filterFromUrl(u: URL): ListFilter {
  const all = u.searchParams.get("all") !== "false"; // default: every project
  const agent = u.searchParams.get("agent") ?? undefined;
  const limit = Number(u.searchParams.get("limit") ?? "200");
  const sinceRaw = u.searchParams.get("since");
  const d = sinceRaw ? parseDuration(sinceRaw) : null;
  return { project: null, all, agent, sinceMs: d != null ? Date.now() - d : null, limit: Number.isFinite(limit) ? limit : 200 };
}

// Route one request. Exported for tests (no network needed).
export function handle(req: Request): Response {
  const u = new URL(req.url);
  const p = u.pathname;

  if (p === "/" || p === "/index.html") {
    return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // Live-reload heartbeat: a cheap hash of the current page. The client polls
  // this and reloads when it changes — so `bun --hot` (which swaps INDEX_HTML in
  // place) gives a true hot-reload feel. No reindex here.
  if (p === "/api/ping") {
    let h = 5381;
    for (let i = 0; i < INDEX_HTML.length; i++) h = ((h << 5) + h + INDEX_HTML.charCodeAt(i)) | 0;
    return json({ v: h });
  }

  if (p === "/api/sessions") {
    freshen(); // fresh on pull (test seam)
    const f = filterFromUrl(u);
    const sessions = costForProject(f);
    const total = sessions.reduce<number | null>((s, r) => (r.total_usd === null ? s : (s ?? 0) + r.total_usd), null);
    return json({ total_usd: total, count: sessions.length, sessions });
  }

  // Flat reverse-chronological worklog feed across sessions — the LOG.md view,
  // every project at once (the web "Logs" tab). Same shared query as `lb list
  // --logs`, so the CLI and the UI can't drift.
  if (p === "/api/logs") {
    freshen();
    const f = filterFromUrl(u);
    // Each entry carries its own cost — range-summed over its byte span, the same
    // attribution the session detail uses — so the feed is a spend ledger too.
    const logs = recentWorklog(f).map((w) => {
      const c = w.from_offset != null && w.to_offset != null ? logBatchCost(w.session_native_id, w.from_offset, w.to_offset) : { total_usd: null, total_tokens: 0 };
      return { ...w, session: shortId(w.session_native_id), cost_usd: c.total_usd, tokens: c.total_tokens };
    });
    const total = logs.reduce<number | null>((s, r) => (r.cost_usd === null ? s : (s ?? 0) + r.cost_usd), null);
    return json({ total_usd: total, count: logs.length, logs });
  }

  // Insights: automation candidates through the SAME shared analyzers the CLI
  // uses — serve and `lb insights` can't drift. Reads the stored tool_call facts.
  // `analyzer=all` runs the full registry (incl. the opt-in transcript lenses).
  if (p === "/api/insights") {
    freshen();
    const lf = filterFromUrl(u);
    const top = Math.min(100, Math.max(1, Number(u.searchParams.get("top") ?? "20") || 20));
    const f: InsightFilter = { project: lf.project, all: lf.all, sinceMs: lf.sinceMs, agent: lf.agent, top, includeEdits: u.searchParams.get("include-edits") === "true" };
    const requested = u.searchParams.get("analyzer");
    const names = requested === "all" ? ANALYZER_NAMES : requested ? requested.split(",").map((s) => s.trim()).filter((n) => ANALYZERS[n]) : DEFAULT_ANALYZERS;
    const analyzers: Record<string, unknown[]> = {};
    for (const n of names) {
      analyzers[n] = ANALYZERS[n]!(f).map((s) => ({
        ...s,
        examples: s.examples.map((e) => ({ session: shortId(e.session), turn: e.turn })),
      }));
    }
    return json({ analyzers });
  }

  if (p === "/api/summary") {
    freshen();
    const rows = costSummaryByModel(filterFromUrl(u));
    const total = rows.reduce<number | null>((s, r) => (r.total_usd === null ? s : (s ?? 0) + r.total_usd), null);
    return json({ total_usd: total, models: rows });
  }

  // Paged conversation transcript for one session (user/assistant turns only,
  // text truncated) — bounded so it's never a heavy load.
  const msgMatch = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (msgMatch) {
    const { row } = resolveSession(decodeURIComponent(msgMatch[1]!));
    if (!row) return json({ error: "not_found" }, 404);
    const adapter = adapterFor(row.agent as never);
    if (!adapter) return json({ error: "unsupported_agent" }, 400);
    const offset = Math.max(0, Number(u.searchParams.get("offset") ?? "0") || 0);
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") ?? "60") || 60));
    // Optional scope: a worklog byte span (?from&to) or a user-turn ordinal
    // (?turn) — so the same viewer drills into ONE log batch or ONE insight
    // example, not the whole session. Turn ordinals line up with `show --turn`.
    let scope = "session";
    let turns: { role: string; text: string; tools: { name: string; summary?: string }[] }[] = [];
    try {
      let events = adapter.readEvents(row.path);
      const turnParam = u.searchParams.get("turn");
      if (turnParam != null && turnParam !== "") {
        const starts = userTurnStarts(events);
        const n = Number(turnParam);
        if (Number.isFinite(n) && n >= 0 && n < starts.length) {
          events = events.slice(starts[n]!, starts[n + 1] ?? events.length);
          scope = `turn:${n}`;
        }
      } else if (u.searchParams.has("from") && u.searchParams.has("to")) {
        const from = Number(u.searchParams.get("from"));
        const to = Number(u.searchParams.get("to"));
        if (Number.isFinite(from) && Number.isFinite(to)) {
          events = events.filter((e) => e.offset != null && e.offset >= from && e.offset < to);
          scope = `span:${from}-${to}`;
        }
      }
      turns = events
        .filter((e) => e.role === "user" || e.role === "assistant")
        .map((e) => ({ role: e.role, text: (e.text || "").slice(0, 1200), tools: (e.tools ?? []).map((t) => ({ name: t.name, summary: t.inputSummary })) }));
    } catch {
      turns = [];
    }
    return json({ total: turns.length, offset, limit, scope, messages: turns.slice(offset, offset + limit) });
  }

  const m = p.match(/^\/api\/sessions\/(.+)$/);
  if (m) {
    const { row, ambiguous } = resolveSession(decodeURIComponent(m[1]!));
    if (!row) return json({ error: "not_found", ambiguous: ambiguous?.map((a) => a.native_id) ?? [] }, 404);
    const models = sessionCostBreakdown(row.native_id);
    const total = models.reduce<number | null>((s, r) => (r.total_usd === null ? s : (s ?? 0) + r.total_usd), null);
    // Per-log-batch cost: range-sum message_tokens over each worklog's byte span.
    const worklog = worklogFor(row.native_id).map((w) => {
      const c = w.from_offset != null && w.to_offset != null ? logBatchCost(row.native_id, w.from_offset, w.to_offset) : { total_usd: null, total_tokens: 0, messages: 0 };
      return { id: w.id, text: w.text, body: w.body, msg_count: w.msg_count, cost_usd: c.total_usd, tokens: c.total_tokens, from_offset: w.from_offset, to_offset: w.to_offset };
    });
    return json({ session: row, total_usd: total, models, worklog });
  }

  return json({ error: "not_found" }, 404);
}

export function startServer(port: number) {
  return Bun.serve({
    port,
    // Last-resort guard: any unexpected throw becomes a parseable JSON 500, never
    // a bodyless 500 (which makes the client's `.json()` blow up into a silent
    // "error"). The client can then show what actually went wrong.
    fetch: (req: Request) => {
      try {
        return handle(req);
      } catch (e) {
        console.error("[serve] request failed:", e);
        return json({ error: "server_error", message: e instanceof Error ? e.message : String(e) }, 500);
      }
    },
  });
}
