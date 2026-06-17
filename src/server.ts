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
  logBatchCost,
  type ListFilter,
} from "./queries.ts";
import { adapterFor } from "./adapters/registry.ts";
import { parseDuration } from "./time.ts";
import { INDEX_HTML } from "./web/index-html.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
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
    if (process.env.LB_SKIP_REINDEX !== "1") reindex(); // fresh on pull (test seam)
    const f = filterFromUrl(u);
    const sessions = costForProject(f);
    const total = sessions.reduce<number | null>((s, r) => (r.total_usd === null ? s : (s ?? 0) + r.total_usd), null);
    return json({ total_usd: total, count: sessions.length, sessions });
  }

  if (p === "/api/summary") {
    if (process.env.LB_SKIP_REINDEX !== "1") reindex();
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
    let turns: { role: string; text: string; tools: { name: string; summary?: string }[] }[] = [];
    try {
      turns = adapter
        .readEvents(row.path)
        .filter((e) => e.role === "user" || e.role === "assistant")
        .map((e) => ({ role: e.role, text: (e.text || "").slice(0, 1200), tools: (e.tools ?? []).map((t) => ({ name: t.name, summary: t.inputSummary })) }));
    } catch {
      turns = [];
    }
    return json({ total: turns.length, offset, limit, messages: turns.slice(offset, offset + limit) });
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
      return { id: w.id, text: w.text, body: w.body, msg_count: w.msg_count, cost_usd: c.total_usd, tokens: c.total_tokens };
    });
    return json({ session: row, total_usd: total, models, worklog });
  }

  return json({ error: "not_found" }, 404);
}

export function startServer(port: number) {
  return Bun.serve({ port, fetch: (req: Request) => handle(req) });
}
