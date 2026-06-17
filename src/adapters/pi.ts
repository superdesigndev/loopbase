// pi adapter (@earendil-works/pi-coding-agent). JSONL under
// ~/.pi/agent/sessions/<enc-cwd>/<ts>_<uuid>.jsonl. Header `type:session` line
// carries id+cwd; `type:message` lines carry role/content. Same shape openclaw
// uses for its `main` backend. (PLAN.md → Adapter Matrix.)

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { Glob } from "bun";
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
} from "./types.ts";
import { deriveFromEvents } from "./claude.ts";

const ROOT = join(homedir(), ".pi", "agent", "sessions");

export const piAdapter: Adapter = {
  kind: "pi",

  enumerate(): SourceFile[] {
    if (!existsSync(ROOT)) return [];
    const files: SourceFile[] = [];
    for (const rel of new Glob("*/*.jsonl").scanSync(ROOT)) {
      if (rel.includes(".trajectory.")) continue; // observability stream, not a transcript
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
    let sessionId: string | undefined;
    for (const row of rows as any[]) {
      if (row?.type === "session") {
        cwd = row.cwd ?? cwd;
        sessionId = row.id ?? sessionId;
        continue;
      }
      if (row?.type !== "message") continue;
      const m = row.message ?? {};
      const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : m.role === "toolResult" ? "tool_result" : "other";
      events.push({
        role,
        text: extractText(m.content),
        ts: toEpochMs(row.timestamp ?? m.timestamp),
        cwd,
        sessionId,
      });
    }
    return events;
  },

  deriveMeta(path: string, events: Event[]): DerivedMeta {
    // nativeId from the session header sessionId if present, else filename UUID tail.
    const m = path.match(/_([0-9a-f-]{36})\.jsonl$/i);
    const fallback = m ? m[1]! : path;
    const meta = deriveFromEvents(fallback, events);
    return meta;
  },

  resolveCurrentSession(): string | null {
    return null; // pi exposes no session-id env var → mtime fallback
  },

  // Pi MAY carry a `usage` block per assistant message (often absent). Field
  // names vary (`input`/`output`/`cacheRead`/`cacheWrite`, or Anthropic-style
  // `*_tokens`), so read both. Treated like Claude: inclusive = input + cache.
  // Model is rarely recorded → unpriced (null) is acceptable (C5).
  readUsage(path: string): UsageRow[] {
    const rows = parseJsonlWithOffsets(readFileSync(path, "utf8"));
    const out: UsageRow[] = [];
    let model: string | null = null;
    let seq = 0;
    const num = (u: any, ...keys: string[]): number => {
      for (const k of keys) {
        const v = u?.[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
      return 0;
    };
    for (const { obj, offset } of rows) {
      const row = obj as any;
      if (row?.type === "session") {
        model = row.model ?? row.modelId ?? model;
        continue;
      }
      if (row?.type !== "message") continue;
      const m = row.message ?? {};
      if (m.role !== "assistant") continue;
      const u = m.usage;
      if (!u) continue;
      const input = num(u, "input", "input_tokens");
      const output = num(u, "output", "output_tokens");
      const cacheRead = num(u, "cacheRead", "cache_read_input_tokens");
      const cacheCreation = num(u, "cacheWrite", "cache_creation_input_tokens");
      if (input + output + cacheRead + cacheCreation === 0) continue;
      out.push({
        seq: seq++,
        offset,
        ts: toEpochMs(row.timestamp ?? m.timestamp),
        model: m.model ?? model,
        inputTokens: input + cacheRead + cacheCreation, // INCLUSIVE
        outputTokens: output,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        reasoningTokens: 0,
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
