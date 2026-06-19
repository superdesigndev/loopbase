// Claude Code adapter. JSONL per session under
// ~/.claude/projects/<enc-cwd>/<session-uuid>.jsonl, with subagents in a
// <session>/subagents/agent-<id>.jsonl sidecar tree. (PLAN.md → On-Disk Formats,
// Nested & parallel agents.)

import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { Glob } from "bun";
import {
  type Adapter,
  type SourceFile,
  type Event,
  type DerivedMeta,
  type ToolCall,
  type UsageRow,
  parseJsonlWithOffsets,
  extractText,
  toEpochMs,
  ellipsize,
} from "./types.ts";
import { scanProjectDirs } from "./scan.ts";

const ROOT = join(homedir(), ".claude", "projects");

function statMtime(path: string): number {
  try {
    return Bun.file(path).lastModified;
  } catch {
    return 0;
  }
}

export const claudeAdapter: Adapter = {
  kind: "claude",

  enumerate(): SourceFile[] {
    if (!existsSync(ROOT)) return [];
    const files: SourceFile[] = [];
    // Main sessions: <project>/<uuid>.jsonl
    for (const rel of scanProjectDirs(ROOT, "*.jsonl")) {
      const path = join(ROOT, rel);
      files.push({ path, mtimeMs: statMtime(path), kind: "session" });
    }
    // Subagents: <project>/<session>/subagents/agent-<id>.jsonl
    for (const rel of scanProjectDirs(ROOT, "*/subagents/agent-*.jsonl")) {
      const path = join(ROOT, rel);
      const parentNativeId = rel.split("/")[1]; // <project>/<SESSION>/subagents/...
      const agentId = basename(path).replace(/^agent-/, "").replace(/\.jsonl$/, "");
      files.push({
        path,
        mtimeMs: statMtime(path),
        kind: "subagent",
        parentNativeId,
        agentId,
        loadMeta: () => readMeta(path) ?? {}, // deferred — read only when indexing this file
      });
    }
    return files;
  },

  readEvents(path: string): Event[] {
    return this.parseContent(readFileSync(path, "utf8"));
  },

  parseContent(content: string): Event[] {
    const rows = parseJsonlWithOffsets(content);
    const events: Event[] = [];
    for (const { obj, offset } of rows) {
      const row = obj as any;
      if (row?.type !== "user" && row?.type !== "assistant") continue;
      const msg = row.message ?? {};
      const ev: Event = {
        role: row.type === "user" ? (row.toolUseResult ? "tool_result" : "user") : "assistant",
        text: extractText(msg.content),
        ts: toEpochMs(row.timestamp),
        sessionId: row.sessionId,
        cwd: row.cwd,
        branch: row.gitBranch,
        uuid: row.uuid,
        parentUuid: row.parentUuid ?? undefined,
        isSidechain: row.isSidechain === true,
        offset,
        // Same dedup key the cost layer keeps (message id + request id), present
        // on assistant lines — lets insights drop re-logged copies.
        dedupKey: row.type === "assistant" && msg.id && row.requestId ? `${msg.id}:${row.requestId}` : undefined,
      };
      const tools = extractTools(msg.content);
      if (tools.length) ev.tools = tools;
      // Capture tool_result blocks (carried on user lines) so --tool/--expand-tools
      // can show the full result, joined by tool_use_id.
      const tr = extractToolResult(msg.content);
      if (tr) {
        ev.role = "tool_result";
        ev.toolResultId = tr.id;
        if (tr.isError) ev.toolResultError = true;
        if (!ev.text) ev.text = tr.text;
      }
      events.push(ev);
    }
    return events;
  },

  deriveMeta(path: string, events: Event[]): DerivedMeta {
    return deriveFromEvents(basename(path).replace(/\.jsonl$/, ""), events);
  },

  resolveCurrentSession(): string | null {
    return process.env.CLAUDE_CODE_SESSION_ID ?? null;
  },

  // For `<project>/<session>.jsonl`, subagents live under `<project>/<session>/`.
  // Match `agent-*.jsonl` at ANY depth so workflow-nested agents
  // (subagents/workflows/wf_*/agent-*.jsonl) are counted, not just direct Task
  // spawns. (ccusage counts all of these toward cost.)
  subagentFilesFor(sessionPath: string): string[] {
    const base = sessionPath.replace(/\.jsonl$/, ""); // the session's sidecar dir
    if (!existsSync(base)) return [];
    const out: string[] = [];
    for (const rel of new Glob("**/agent-*.jsonl").scanSync(base)) out.push(join(base, rel));
    return out;
  },

  // Anthropic emits a `usage` block on each assistant message. `input_tokens` is
  // cache-EXCLUSIVE, so inclusive prompt = input + cache_creation + cache_read.
  //
  // Claude Code RE-LOGS the same assistant message multiple times (on resume /
  // compaction it rewrites prior history into the file). Each copy carries the
  // SAME usage, so summing all lines over-counts ~2x. Deduplicate on
  // `message.id : requestId` and keep the first occurrence — the same key
  // ccusage uses. (Verified: 369/1219 lines were dups, all identical usage.)
  readUsage(path: string): UsageRow[] {
    const rows = parseJsonlWithOffsets(readFileSync(path, "utf8"));
    const out: UsageRow[] = [];
    const seen = new Set<string>();
    let seq = 0;
    for (const { obj, offset } of rows) {
      const row = obj as any;
      if (row?.type !== "assistant") continue;
      const msg = row.message ?? {};
      const u = msg.usage;
      if (!u) continue;
      // Dedup key: only when we have a stable id pair; otherwise keep the row.
      let dedupKey: string | undefined;
      if (msg.id && row.requestId) {
        dedupKey = msg.id + ":" + row.requestId;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
      }
      const input = u.input_tokens ?? 0;
      const cacheCreation = u.cache_creation_input_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const output = u.output_tokens ?? 0;
      if (input + cacheCreation + cacheRead + output === 0) continue;
      out.push({
        seq: seq++,
        offset,
        ts: toEpochMs(row.timestamp),
        model: msg.model ?? null,
        inputTokens: input + cacheCreation + cacheRead, // INCLUSIVE
        outputTokens: output,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        reasoningTokens: 0,
        dedupKey,
      });
    }
    return out;
  },
};

function readMeta(jsonlPath: string): { agentType?: string; description?: string; toolUseId?: string } | null {
  const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function extractTools(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return [];
  const tools: ToolCall[] = [];
  for (const b of content as any[]) {
    if (b && typeof b === "object" && b.type === "tool_use") {
      const isTask = b.name === "Task";
      tools.push({
        id: b.id,
        name: b.name,
        input: b.input,
        inputSummary: summarizeToolInput(b.name, b.input),
        isTask,
        ...(isTask && b.input?.subagent_type ? { agentId: undefined } : {}),
      });
    }
  }
  return tools;
}

function extractToolResult(content: unknown): { id: string; text: string; isError: boolean } | null {
  if (!Array.isArray(content)) return null;
  for (const b of content as any[]) {
    if (b && typeof b === "object" && b.type === "tool_result" && typeof b.tool_use_id === "string") {
      return { id: b.tool_use_id, text: extractText(b.content), isError: b.is_error === true };
    }
  }
  return null;
}

export function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return name;
  if (typeof input.file_path === "string") return `${name} ${basename(input.file_path)}`;
  if (typeof input.command === "string") return `${name}: ${String(input.command).slice(0, 60)}`;
  if (typeof input.description === "string") return `${name}: ${input.description}`;
  if (typeof input.pattern === "string") return `${name} /${input.pattern}/`;
  return name;
}

// Shared meta derivation (also reused by pi which has the same message shape).
export function deriveFromEvents(nativeId: string, events: Event[]): DerivedMeta {
  let cwd: string | null = null;
  let branch: string | null = null;
  let startedAt: number | null = null;
  let lastTs: number | null = null;
  let title: string | null = null;
  let msgCount = 0;
  for (const e of events) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!branch && e.branch) branch = e.branch;
    if (e.sessionId) nativeId = nativeId || e.sessionId;
    if (e.ts != null) {
      if (startedAt == null) startedAt = e.ts;
      lastTs = e.ts;
    }
    if (e.role === "user" || e.role === "assistant") msgCount++;
    if (!title && e.role === "user") {
      const t = cleanPrompt(e.text);
      if (t) title = ellipsize(t, 120);
    }
  }
  return { nativeId, cwd, branch, startedAt, lastTs, msgCount, title };
}

// Strip known wrapper noise so first_prompt reads cleanly. (Claude command
// envelopes, etc.) openclaw's "Sender (untrusted metadata)" wrapper is handled
// in its own adapter.
export function cleanPrompt(text: string): string {
  let t = text.trim();
  // Drop whole slash-command envelopes Claude injects, tag AND content:
  // <command-name>/goal</command-name><command-args>…</command-args>real text
  t = t.replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, "").trim();
  // Drop any remaining stray tags (e.g. <local-command-stdout>…), keeping inner text.
  if (t.includes("<")) {
    const stripped = t.replace(/<[^>]+>/g, "").trim();
    if (stripped) t = stripped;
  }
  // Drop leading system-reminder noise.
  if (t.startsWith("Caveat:") || t.startsWith("[Request interrupted")) return "";
  return t;
}
