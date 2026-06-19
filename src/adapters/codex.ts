// Codex adapter. JSONL rollouts under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Lines are {timestamp, type, payload}: session_meta carries id/cwd/model;
// response_item carries {role, content}. (PLAN.md → Adapter Matrix.)

import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  type Adapter,
  type SourceFile,
  type Event,
  type DerivedMeta,
  type UsageRow,
  parseJsonl,
  parseJsonlWithOffsets,
  extractText,
  toEpochMs,
  ellipsize,
} from "./types.ts";
import { walkFilesResilient } from "./scan.ts";

const ROOT = join(homedir(), ".codex", "sessions");
const ROLLOUT = /^rollout-.*\.jsonl$/;

export const codexAdapter: Adapter = {
  kind: "codex",

  enumerate(): SourceFile[] {
    if (!existsSync(ROOT)) return [];
    const files: SourceFile[] = [];
    // Resilient recursive walk (codex partitions by YYYY/MM/DD, so the flat
    // scanProjectDirs doesn't fit) — one unreadable dir is skipped, not fatal.
    for (const rel of walkFilesResilient(ROOT, (name) => ROLLOUT.test(name))) {
      const path = join(ROOT, rel);
      files.push({ path, mtimeMs: safeMtime(path), kind: "session" });
    }
    return files;
  },

  readEvents(path: string): Event[] {
    return this.parseContent(readFileSync(path, "utf8"));
  },

  parseContent(content: string): Event[] {
    const rows = parseJsonl(content);
    const events: Event[] = [];
    let cwd: string | undefined;
    let branch: string | undefined;
    let sessionId: string | undefined;
    for (const row of rows as any[]) {
      const ts = toEpochMs(row?.timestamp);
      const p = row?.payload ?? {};
      if (row?.type === "session_meta") {
        cwd = p.cwd ?? cwd;
        sessionId = p.id ?? sessionId;
        branch = p.git?.branch ?? branch; // codex records git.branch at session start
        continue;
      }
      if (row?.type === "response_item" && (p.role === "user" || p.role === "assistant")) {
        const text = extractText(p.content);
        // Codex injects AGENTS.md (and a developer permissions block) as a
        // user-role message before the real prompt — skip it everywhere.
        if (p.role === "user" && /^#\s*AGENTS\.md instructions\b/.test(text.trimStart())) continue;
        events.push({ role: p.role, text, ts, cwd, branch, sessionId });
      }
    }
    return events;
  },

  deriveMeta(path: string, events: Event[]): DerivedMeta {
    // nativeId from the rollout filename's UUID tail, or session_meta.
    const m = basename(path).match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i);
    const fallbackId = m ? m[1]! : basename(path).replace(/\.jsonl$/, "");
    let cwd: string | null = null;
    let branch: string | null = null;
    let startedAt: number | null = null;
    let lastTs: number | null = null;
    let title: string | null = null;
    let nativeId = fallbackId;
    let msgCount = 0;
    for (const e of events) {
      if (!cwd && e.cwd) cwd = e.cwd;
      if (!branch && e.branch) branch = e.branch;
      if (e.sessionId) nativeId = e.sessionId;
      if (e.ts != null) {
        if (startedAt == null) startedAt = e.ts;
        lastTs = e.ts;
      }
      if (e.role === "user" || e.role === "assistant") msgCount++;
      if (!title && e.role === "user" && e.text.trim()) title = ellipsize(e.text.trim(), 120);
    }
    // Prefer codex's own semantic title (state_5.sqlite → threads.title); fall
    // back to the first real user message.
    const native = codexTitles().get(nativeId);
    return { nativeId, cwd, branch, startedAt, lastTs, msgCount, title: native ? ellipsize(native, 120) : title };
  },

  resolveCurrentSession(): string | null {
    // Codex calls a session a "thread" and injects its id into the env of every
    // shell command it spawns (verified live: CODEX_THREAD_ID === the rollout
    // filename's UUID tail === session_meta.id === our nativeId). There is no
    // CODEX_SESSION_ID. `lb` runs inside that shell, so this resolves the caller.
    return process.env.CODEX_THREAD_ID ?? null;
  },

  // Codex reports CUMULATIVE token totals on `event_msg`/`token_count` events
  // (`info.total_token_usage`). `last_token_usage` grows with context and is NOT
  // a per-turn delta, so we derive each turn's billed usage as the positive
  // delta of the cumulative total (telescoping → sum equals the final total).
  // Codex `input_tokens` already INCLUDES cached, matching our inclusive
  // convention. (Verified against real rollouts; docs/cost-plan.md → Phase 2.)
  readUsage(path: string): UsageRow[] {
    const rows = parseJsonlWithOffsets(readFileSync(path, "utf8"));
    const out: UsageRow[] = [];
    let model: string | null = null;
    let prevInput = 0;
    let prevOutput = 0;
    let prevCached = 0;
    let prevReasoning = 0;
    let seq = 0;
    for (const { obj, offset } of rows) {
      const row = obj as any;
      const p = row?.payload ?? {};
      // Codex records the active model on `turn_context` events (it can change
      // mid-session), not on session_meta. Track the latest seen.
      if (row?.type === "turn_context" || row?.type === "session_meta") {
        model = p.model ?? model;
        continue;
      }
      if (row?.type !== "event_msg" || p?.type !== "token_count") continue;
      const tot = p.info?.total_token_usage;
      if (!tot) continue;
      const curInput = tot.input_tokens ?? 0; // inclusive of cached
      const curOutput = tot.output_tokens ?? 0;
      const curCached = tot.cached_input_tokens ?? 0;
      const curReasoning = tot.reasoning_output_tokens ?? 0;
      const dInput = Math.max(0, curInput - prevInput);
      const dOutput = Math.max(0, curOutput - prevOutput);
      const dCached = Math.max(0, curCached - prevCached);
      const dReasoning = Math.max(0, curReasoning - prevReasoning);
      prevInput = curInput;
      prevOutput = curOutput;
      prevCached = curCached;
      prevReasoning = curReasoning;
      if (dInput + dOutput === 0) continue;
      out.push({
        seq: seq++,
        offset,
        ts: toEpochMs(row.timestamp),
        model,
        inputTokens: dInput, // already inclusive of cache
        outputTokens: dOutput,
        cacheCreationTokens: 0, // codex has no cache-creation counter
        cacheReadTokens: dCached,
        reasoningTokens: dReasoning,
      });
    }
    return out;
  },
};

function safeMtime(path: string): number {
  try {
    return Bun.file(path).lastModified;
  } catch {
    return 0;
  }
}

// Codex keeps semantic, LLM-generated session titles in a sidecar DB
// (~/.codex/state_5.sqlite → threads.title), keyed by session id. Load once,
// cache, and fall back gracefully if the DB is absent/locked.
let _titles: Map<string, string> | null = null;
function codexTitles(): Map<string, string> {
  if (_titles) return _titles;
  _titles = new Map();
  const dbPath = join(homedir(), ".codex", "state_5.sqlite");
  if (!existsSync(dbPath)) return _titles;
  try {
    const db = new Database(dbPath, { readonly: true });
    for (const r of db.query("SELECT id, title FROM threads WHERE title <> ''").all() as { id: string; title: string }[]) {
      if (r.id && r.title) _titles.set(r.id, r.title);
    }
    db.close();
  } catch {
    // locked / schema drift / older codex → fall back to first user message
  }
  return _titles;
}
