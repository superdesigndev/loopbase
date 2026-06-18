// Fact extraction for insights: turn a session's normalized events into
// `tool_call` facts. Pure + deterministic so it's unit-testable in isolation and
// reusable by the index writer. (docs/INSIGHTS.md → fact extraction.)
//
// The load-bearing piece is `argSig` — a lossy, per-tool signature that collapses
// "the same kind of call" into one bucket. It is an allowlist, never a general
// parser: anything it doesn't recognize falls back to the bare tool name.

import { cleanPrompt } from "./adapters/claude.ts";
import type { Event } from "./adapters/types.ts";

// One extracted tool-call fact. `turn` is the user-turn ordinal that contains
// the call (so an insight example feeds straight into `show --turn`); null when
// the call precedes the first user turn.
export interface ToolCallFact {
  seq: number;
  turn: number | null;
  name: string;
  argSig: string;
  estTokens: number; // estimate from I/O byte size (input + result) / 4
  hasError: boolean;
  errorClass: string | null;
}

// Strip value-bearing noise that would otherwise fragment identical tasks into
// distinct signatures (under-collapse): temp paths, hashes, ISO dates, long
// digit runs, and quoted literals all become a stable placeholder.
export function stripNoise(s: string): string {
  return s
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/\S+/g, "·path") // temp paths
    .replace(/\b[0-9a-f]{8,}\b/gi, "·hash") // hex ids / sha
    .replace(/\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?)?/gi, "·date") // ISO date(time)
    .replace(/\b\d{3,}\b/g, "·n") // long digit runs (ports, counts, ids)
    .trim();
}

// basename without importing node:path (keep this module dependency-light).
function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function fileExtOrDir(p: string): string {
  const base = baseName(p);
  const dot = base.lastIndexOf(".");
  if (dot > 0) return "*" + base.slice(dot); // *.tsx
  // no extension → first path segment, so dir-level work still buckets
  const seg = p.replace(/^\/+/, "").split("/")[0];
  return seg || "(root)";
}

// Setup/no-op command heads that prefix a real command in a chain (e.g.
// `cd "$REPO" && git commit`). Signaturing the `cd` would collapse every command
// run from a given dir into one useless bucket, so we skip past these.
const SETUP_HEADS = new Set(["cd", "export", "source", ".", "set", "pushd", "popd", "env"]);

// Signature for a `Bash` command: argv0 + first non-flag subtoken, EXCEPT
// curl/wget/http where we keep method + host+path so distinct endpoints don't
// over-collapse into one "curl" bucket. Leading setup segments of a &&/; chain
// (cd, export, …) are dropped so we signature the real command.
function bashSig(cmd: string): string {
  // Pick the first chain segment whose head isn't a setup/no-op command.
  const segments = cmd.split(/&&|;/).map((s) => s.trim()).filter(Boolean);
  const target =
    segments.find((seg) => !SETUP_HEADS.has(baseName(seg.split(/\s+/)[0] ?? ""))) ??
    segments[segments.length - 1] ??
    cmd;

  const tokens = target.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "Bash";
  const argv0 = baseName(tokens[0]!);

  if (argv0 === "curl" || argv0 === "wget" || argv0 === "http" || argv0 === "https") {
    let method = "GET";
    let url = "";
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if ((t === "-X" || t === "--request") && tokens[i + 1]) method = tokens[++i]!.toUpperCase();
      else if (/^https?:\/\//.test(t)) url = t;
      else if (!url && !t.startsWith("-")) url = t; // bare host/path argument
    }
    const hostPath = url
      .replace(/^https?:\/\//, "")
      .split(/[?#]/)[0]! // drop query/fragment
      .replace(/\/+$/, "");
    return stripNoise(`Bash:${argv0} ${method} ${hostPath}`);
  }

  // Generic: argv0 + first non-flag subtoken (git commit, playwright screenshot).
  const sub = tokens.slice(1).find((t) => !t.startsWith("-"));
  return stripNoise(`Bash:${argv0}${sub ? " " + sub : ""}`);
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);

// The signature normalizer. `input` is the raw tool input (may be undefined);
// `inputSummary` is the adapter's one-line summary fallback.
export function argSig(name: string, input: unknown, inputSummary?: string): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;

  // MCP tools: name + sorted ARG-KEY names, never values.
  if (name.startsWith("mcp__")) {
    const keys = obj ? Object.keys(obj).sort() : [];
    return `${name}(${keys.join(",")})`;
  }

  if (name === "Bash") {
    const cmd = typeof obj?.command === "string" ? (obj.command as string) : inputSummary ?? "";
    return bashSig(cmd);
  }

  // Native file tools: tool + extension or dir-depth-1, never the full path.
  if (FILE_TOOLS.has(name)) {
    const p = typeof obj?.file_path === "string" ? (obj.file_path as string) : typeof obj?.notebook_path === "string" ? (obj.notebook_path as string) : "";
    return p ? `${name}:${fileExtOrDir(p)}` : name;
  }

  // Subagent spawns (Task / Agent): bucket by the subagent type (the unit of
  // repeated work), not the one-off prompt.
  if (name === "Task" || name === "Agent") {
    const t = typeof obj?.subagent_type === "string" ? (obj.subagent_type as string) : null;
    return t ? `${name}:${t}` : name;
  }

  // Everything else (Grep, Glob, WebFetch, …): the pattern/url is a value, so
  // bucket by the bare tool name.
  return name;
}

// Coarse error bucket from a tool-result text — a short, noise-stripped key so
// the same failure groups. Display/grouping aid only; the error analyzer keys
// primarily on (name, argSig). Returns null for empty results.
export function errorClass(resultText: string): string | null {
  const firstLine = resultText.split("\n").map((l) => l.trim()).find(Boolean);
  if (!firstLine) return null;
  return stripNoise(firstLine).slice(0, 60);
}

// Estimate the token weight of a tool call from its I/O byte size — a self
// contained proxy (no token-usage join) that captures the real cost driver: big
// inputs (writing a large file) and big results (a command dumping thousands of
// lines). Honest as an ESTIMATE; the score uses it as a relative weight.
function estTokensFor(input: unknown, inputSummary: string | undefined, resultLen: number): number {
  let inputBytes = 0;
  if (input !== undefined) {
    try {
      inputBytes = JSON.stringify(input).length;
    } catch {
      inputBytes = inputSummary?.length ?? 0;
    }
  } else {
    inputBytes = inputSummary?.length ?? 0;
  }
  return Math.ceil((inputBytes + resultLen) / 4);
}

// Walk a session's events into tool-call facts. Tool calls live on assistant
// events; their results (text + error flag) live on later tool_result events
// joined by tool_use id. Turn ordinals follow the same `cleanPrompt` rule as the
// `show` map so an example's `turn` lines up with `show --turn`.
export function extractToolCalls(events: Event[]): ToolCallFact[] {
  // First pass: index results by tool_use id.
  const results = new Map<string, { len: number; err: boolean }>();
  for (const e of events) {
    if (e.role === "tool_result" && e.toolResultId) {
      results.set(e.toolResultId, { len: e.text.length, err: e.toolResultError === true });
    }
  }

  // Second pass: assign each tool call to the user turn it sits under.
  const facts: ToolCallFact[] = [];
  let turnNo = -1; // → 0 at the first clean user message (matches collectTurns)
  let seq = 0;
  for (const e of events) {
    if (e.role === "user" && cleanPrompt(e.text)) turnNo++;
    if (e.role === "assistant" && e.tools) {
      for (const t of e.tools) {
        const r = t.id ? results.get(t.id) : undefined;
        facts.push({
          seq: seq++,
          turn: turnNo < 0 ? null : turnNo,
          name: t.name,
          argSig: argSig(t.name, t.input, t.inputSummary),
          estTokens: estTokensFor(t.input, t.inputSummary, r?.len ?? 0),
          hasError: r?.err === true,
          errorClass: r?.err ? errorClass(findResultText(events, t.id)) : null,
        });
      }
    }
  }
  return facts;
}

// Look up the result text for a tool id (only called for errored calls, so the
// extra scan is rare). Kept separate from the result-length map to avoid storing
// every result body in memory for the common success path.
function findResultText(events: Event[], id: string | undefined): string {
  if (!id) return "";
  for (const e of events) {
    if (e.role === "tool_result" && e.toolResultId === id) return e.text;
  }
  return "";
}
