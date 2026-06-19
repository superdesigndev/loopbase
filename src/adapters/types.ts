// Adapter interface + normalized Event shape shared by all agents.
// (PLAN.md → "Cursor abstraction", common Event shape.)

export type AgentKind = "claude" | "codex" | "pi" | "openclaw" | "hermes";

export interface ToolCall {
  id: string; // stable id from native tool_use_id
  name: string;
  inputSummary?: string; // one-line summary for default `show`
  input?: unknown; // full input (for --expand-tools / --tool)
  isTask?: boolean; // subagent spawn
  agentId?: string; // for Task calls → child transcript
  result?: string; // tool result text (for --expand-tools / --tool)
}

// Normalized token usage for ONE assistant message. Counts follow the ax
// convention: `inputTokens` is INCLUSIVE of cache (each adapter normalizes its
// harness's native shape into this), so the cost layer subtracts cache to
// recover fresh input. (docs/cost-plan.md → Critical correctness notes.)
export interface UsageRow {
  seq: number; // assistant-message index within the session
  offset: number; // byte offset of the source line (worklog-span attribution)
  ts: number | null;
  model: string | null;
  inputTokens: number; // INCLUSIVE of cache
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  dedupKey?: string; // message id:requestId — stable join key for insights cost
}

// One normalized message in a session trace.
export interface Event {
  role: "user" | "assistant" | "tool_result" | "system" | "other";
  text: string;
  ts: number | null; // epoch ms
  tools?: ToolCall[];
  // session-level hints carried on some source lines:
  sessionId?: string;
  cwd?: string;
  branch?: string;
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  // Byte offset of the source JSONL line (set on full-file readEvents). Lets a
  // tool call join to its assistant message's memoized cost. (docs/INSIGHTS.md.)
  offset?: number;
  // Stable identity of an assistant message, for deduping copies the harness
  // re-logs on compaction/resume (same key the cost layer uses). Insights dedups
  // on this so re-logged tool calls aren't double-counted / mis-joined to cost.
  dedupKey?: string;
  // When role === "tool_result": the tool_use id this result is for.
  toolResultId?: string;
  // When role === "tool_result": whether the tool reported an error. Optional —
  // adapters that can't tell simply omit it (the insights error analyzer then
  // counts it as a success). (docs/INSIGHTS.md → fact extraction.)
  toolResultError?: boolean;
}

// A source transcript file discovered by an adapter.
export interface SourceFile {
  path: string;
  mtimeMs: number;
  kind: "session" | "subagent";
  // subagent linkage (kind === "subagent"):
  parentNativeId?: string;
  agentId?: string;
  // Lazily load subagent sidecar metadata — only called when the file is new or
  // changed, so we don't read hundreds of .meta.json files on every scan.
  loadMeta?: () => { agentType?: string; description?: string; toolUseId?: string };
}

// Aggregated session metadata derived from parsing a transcript.
export interface DerivedMeta {
  nativeId: string;
  cwd: string | null;
  branch: string | null;
  startedAt: number | null;
  lastTs: number | null;
  msgCount: number;
  // Best available label: a provider-native title/summary if one exists,
  // otherwise the first user message. (v0 agents have no native title → always
  // the first message; v1 openclaw has conversations.title.)
  title: string | null;
}

// Truncate to n chars, appending an ellipsis when it actually cut something.
export function ellipsize(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export interface Adapter {
  kind: AgentKind;
  // Discover transcript files for this agent (sessions + any subagents).
  enumerate(): SourceFile[];
  // Parse a transcript file into normalized events.
  readEvents(path: string): Event[];
  // Parse raw JSONL content (a whole file or a byte-aligned slice) into events.
  parseContent(content: string): Event[];
  // Derive session metadata from a parsed event list.
  deriveMeta(path: string, events: Event[]): DerivedMeta;
  // Resolve the calling agent's own current session id (write path). Null if the
  // agent doesn't expose one (caller falls back to mtime heuristic).
  resolveCurrentSession(): string | null;
  // Extract per-assistant-message token usage with byte offsets. Optional: an
  // adapter for a harness that records no usage simply omits it (the indexer
  // falls back to a byte-estimate). (docs/cost-plan.md → Phase 2.)
  readUsage?(path: string): UsageRow[];
  // All subagent transcript files (ANY depth — direct Task spawns AND nested
  // workflow agents) whose token usage rolls into this session's cost. Separate
  // from enumerate()'s thread discovery so cost can be complete without changing
  // agent_threads. Returns [] for harnesses without subagents.
  subagentFilesFor?(sessionPath: string): string[];
}

// --- shared parsing helpers --------------------------------------------------

export function parseJsonl(content: string): unknown[] {
  const out: unknown[] = [];
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // Tolerate truncated/partial lines (crash mid-write). Skip and move on.
    }
  }
  return out;
}

// Like parseJsonl, but also yields each line's BYTE offset within the file —
// needed so token rows can be attributed to a worklog's byte span. Offsets are
// byte-based (worklog spans are byte offsets), so non-ASCII content stays
// aligned. (docs/cost-plan.md → Phase 2, offset tracking.)
export function parseJsonlWithOffsets(content: string): { obj: unknown; offset: number }[] {
  const out: { obj: unknown; offset: number }[] = [];
  let offset = 0;
  for (const line of content.split("\n")) {
    const lineStart = offset;
    offset += Buffer.byteLength(line, "utf8") + 1; // +1 for the split "\n"
    const s = line.trim();
    if (!s) continue;
    try {
      out.push({ obj: JSON.parse(s), offset: lineStart });
    } catch {
      // Tolerate truncated/partial lines.
    }
  }
  return out;
}

// Extract plain text from a content field that may be a string or an array of
// {type:"text", text} / typed blocks.
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b === "string") parts.push(b);
      // Any block carrying a string `.text` (covers text / input_text /
      // output_text across Claude, codex, pi).
      else if (b && typeof b === "object" && typeof (b as any).text === "string") {
        parts.push((b as any).text);
      }
    }
    return parts.join("");
  }
  return "";
}

export function toEpochMs(ts: unknown): number | null {
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000; // sec vs ms
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}
