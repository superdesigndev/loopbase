// `lb insights` — ranked automation candidates over the stored tool-call facts.
// A READER: it refreshes the index (daemonless) then runs the shared analyzers;
// it never triggers a heavy compute of its own. Candidates only — the
// deterministic / safe-to-script judgment stays human. (docs/INSIGHTS.md.)

import { reindex } from "../indexer.ts";
import { listSessions } from "../queries.ts";
import { ANALYZERS, ANALYZER_NAMES, DEFAULT_ANALYZERS, type InsightFilter, type Signal } from "../insights.ts";
import { argSig } from "../insights-extract.ts";
import { ADAPTERS } from "../adapters/registry.ts";
import { resolveProject } from "../project.ts";
import { parseDuration } from "../time.ts";
import { emit, errUsage, errInvalidValue } from "../output.ts";
import { BIN_NAME } from "../constants.ts";
import { shortId } from "./list.ts";
import type { Invocation } from "../parse.ts";

export function runInsights(inv: Invocation): void {
  reindex(); // daemonless: facts fresh on call

  const all = inv.flags.all === true;
  const path = typeof inv.flags.path === "string" ? inv.flags.path : process.cwd();
  const project = all ? null : resolveProject(path);
  const top = typeof inv.flags.top === "number" ? inv.flags.top : 20;
  const agent = typeof inv.flags.agent === "string" ? inv.flags.agent : undefined;

  let sinceMs: number | null = null;
  if (typeof inv.flags.since === "string") {
    const d = parseDuration(inv.flags.since);
    if (d == null) throw errUsage(`--since expects a duration like 24h, 7d, 30m (got ${JSON.stringify(inv.flags.since)})`, `${BIN_NAME} insights --since 7d`);
    sinceMs = Date.now() - d;
  }

  const filter: InsightFilter = { project, all, sinceMs, agent, top, includeEdits: inv.flags["include-edits"] === true };

  // Debug: eyeball signature collapse instead of running analyzers.
  if (inv.flags["show-signature"] === true) {
    emitSignatures(inv, filter);
    return;
  }

  // Resolve the analyzer list. Default = the cheap index-only lenses; the rest
  // (error-retry, user-correction) are opt-in via --analyzer. Validate against
  // the full registry so a typo enumerates the valid set (self-healing).
  let names = DEFAULT_ANALYZERS;
  if (typeof inv.flags.analyzer === "string") {
    names = inv.flags.analyzer.split(",").map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      if (!ANALYZERS[n]) throw errInvalidValue("--analyzer", n, ANALYZER_NAMES, `${BIN_NAME} insights --analyzer tool-freq`);
    }
  }

  const groups: Record<string, ReturnType<typeof signalView>[]> = {};
  for (const n of names) groups[n] = ANALYZERS[n]!(filter).map(signalView);

  emit(
    { project: all ? "(all)" : project, analyzers: groups },
    inv.mode,
    () => renderText(all ? "(all)" : project, groups),
  );
}

// Shorten the example session ids for display (prefix is `show`-resolvable).
function signalView(s: Signal) {
  return {
    key: s.key,
    score: s.score,
    count: s.count,
    usd: s.usd,
    tokens: s.tokens,
    sessions: s.sessions,
    ...(s.project ? { project: s.project } : {}),
    ...(s.details && s.details.length ? { details: s.details } : {}),
    ...(s.sample ? { sample: s.sample } : {}),
    examples: s.examples.map((e) => ({ session: shortId(e.session), turn: e.turn })),
  };
}

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

// USD with a $ feel; null → "unpriced" (never $0, which would imply free).
function usd(v: number | null): string {
  if (v == null) return "unpriced";
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(2)}`;
}

function renderText(project: string | null, groups: Record<string, ReturnType<typeof signalView>[]>): string {
  const lines: string[] = [`${project ?? "(no project)"} — insights (automation CANDIDATES; the script-it call is yours)`];
  for (const [name, rows] of Object.entries(groups)) {
    lines.push("");
    lines.push(`## ${name}  (${rows.length})`);
    if (rows.length === 0) {
      lines.push("  (nothing above the noise floor)");
      continue;
    }
    for (const r of rows) {
      const ex = r.examples.map((e) => `${e.session}${e.turn != null ? `#${e.turn}` : ""}`).join(" ");
      const extra = r.sample ? `  «${r.sample}»` : "";
      const proj = r.project ? `  [${r.project}]` : "";
      lines.push(`  ${k(r.count).padStart(5)}×  ${usd(r.usd).padStart(8)}  ${r.sessions} sess${proj}  ${r.key}${extra}`);
      if (r.details && r.details.length) {
        lines.push("         ┗ " + r.details.map((d) => `${d.key || "(misc)"} ×${d.count}`).join("  ·  "));
      }
      if (ex) lines.push(`         e.g. ${BIN_NAME} show ${ex.split(" ")[0]!.replace("#", " --turn ")}`);
    }
  }
  return lines.join("\n");
}

// --show-signature: re-read a sample of in-scope sessions and print
// raw tool call -> normalized signature, so collapse quality is inspectable.
function emitSignatures(inv: Invocation, f: InsightFilter): void {
  const sessions = listSessions({ project: f.project, all: f.all, sinceMs: f.sinceMs, agent: f.agent, limit: f.top });
  const seen = new Map<string, { name: string; summary: string; sig: string; count: number }>();
  for (const s of sessions) {
    const adapter = ADAPTERS.find((a) => a.kind === s.agent);
    if (!adapter) continue;
    let events;
    try {
      events = adapter.readEvents(s.path);
    } catch {
      continue;
    }
    for (const e of events) {
      if (e.role !== "assistant" || !e.tools) continue;
      for (const t of e.tools) {
        const sig = argSig(t.name, t.input, t.inputSummary);
        const prev = seen.get(sig);
        if (prev) prev.count++;
        else seen.set(sig, { name: t.name, summary: (t.inputSummary ?? t.name).slice(0, 70), sig, count: 1 });
      }
    }
  }
  const rows = [...seen.values()].sort((a, b) => b.count - a.count);
  emit(
    { signatures: rows },
    inv.mode,
    () => ["signature collapse (raw sample -> signature):", ...rows.map((r) => `  ${String(r.count).padStart(4)}×  ${r.sig.padEnd(36)}  e.g. ${r.summary}`)].join("\n"),
  );
}
