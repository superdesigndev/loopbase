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
  detail: string; // finer sub-cluster within argSig (slug / table / shape)
  dedupKey: string | null; // issuing assistant msg id:requestId (cost join)
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
// Pipe output filters — when a command is `realcmd | tail`, the filter is not the
// signal; skip these segments so we signature the real command.
const FILTER_HEADS = new Set(["tail", "head", "grep", "rg", "sort", "uniq", "wc", "jq", "sed", "awk", "cut", "tr", "less", "column", "tee", "fold", "nl"]);
// Prefix wrappers — `timeout 30 cmd`, `sudo cmd`, `xargs cmd`. Strip the wrapper
// (and its option/duration tokens) and signature the wrapped command.
const WRAPPER_HEADS = new Set(["timeout", "sudo", "nice", "time", "nohup", "stdbuf", "command", "ionice", "chrt", "xargs", "doas"]);
// Shell control-flow heads — the real command lives inside the body; bucket as
// one clean "<kw> loop" rather than the loop variable ("for i").
const LOOP_HEADS = new Set(["for", "while", "until", "if", "case"]);
// Shell keywords that can lead a split segment (`for x; do <cmd>`) — not commands.
const SHELL_KEYWORDS = new Set(["do", "then", "done", "fi", "else", "elif", "esac", "in"]);
// Leading `FOO=bar` environment assignments before the real command.
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// curl/wget flags that consume the NEXT token as their value — so we don't
// mistake `-H "Authorization: …"`'s value for the URL.
const CURL_VALUE_FLAGS = new Set([
  "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "-F", "--form", "-X", "--request", "-u", "--user", "-A", "--user-agent", "-e",
  "--referer", "-b", "--cookie", "-o", "--output", "-w", "--write-out", "-T",
  "--upload-file", "--url", "-H,",
]);

function unquote(s: string): string {
  return s.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

// Quote-aware tokenizer: split on whitespace OUTSIDE quotes, keep a quoted span
// (e.g. a curl `-A "Mozilla/5.0 (compatible; …)"`) as ONE token, quotes stripped.
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = "";
  let inTok = false;
  for (const c of s) {
    if (q) {
      if (c === q) q = "";
      else cur += c;
      inTok = true;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      inTok = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (inTok) out.push(cur);
      cur = "";
      inTok = false;
      continue;
    }
    cur += c;
    inTok = true;
  }
  if (inTok) out.push(cur);
  return out;
}

// A clean command head from a raw token: basename, unquoted, with surrounding
// shell punctuation stripped ("xargs)" → "xargs", "(compatible" → "compatible").
function cmdHead(tok: string): string {
  return baseName(unquote(tok)).replace(/^[^A-Za-z0-9._/~-]+/, "").replace(/[^A-Za-z0-9._/~-]+$/, "");
}

// The command head of one chain segment, after dropping env assignments.
function segmentHead(seg: string): string {
  const toks = tokenize(seg);
  let i = 0;
  while (i < toks.length && ENV_ASSIGN.test(toks[i]!)) i++;
  return i < toks.length ? cmdHead(toks[i]!) : "";
}

function curlSig(argv0: string, toks: string[]): string {
  let method = "GET";
  let url = "";
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === "-X" || t === "--request") {
      if (toks[i + 1]) method = unquote(toks[++i]!).toUpperCase();
      continue;
    }
    if (CURL_VALUE_FLAGS.has(t)) {
      i++; // skip the flag AND its value (the header/body/etc.)
      continue;
    }
    if (t.startsWith("-")) continue; // other valueless flags
    if (!url) {
      const c = unquote(t);
      if (/^https?:\/\//.test(c) || c.includes("/") || c.includes(".")) url = c; // url-ish
    }
  }
  const hostPath = url.replace(/^https?:\/\//, "").split(/[?#]/)[0]!.replace(/\/+$/, "");
  return `Bash:${argv0}${url ? ` ${method} ${hostPath}` : ""}`;
}

// Signature for a `Bash` command: argv0 + first non-flag subtoken, with special
// handling so the bucket reflects the real work:
//   • skip leading setup segments of a &&/;/| chain (cd, export, …),
//   • strip leading `FOO=bar` env assignments,
//   • curl/wget → method + host+path (skipping flag values like -H),
//   • heredocs (`python3 <<'PY'`) collapse to one bucket (the body is unique).
// Split a command on &&/||/;/| but NOT inside quotes — so a curl User-Agent
// ("Mozilla/5.0 (compatible; …)") or any quoted `;`/`|` doesn't shatter the
// command into bogus segments.
function splitChain(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) {
      cur += c;
      if (c === q) q = "";
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if ((c === "&" && cmd[i + 1] === "&") || (c === "|" && cmd[i + 1] === "|")) {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function bashSig(cmd: string): string {
  // First meaningful chain segment: skip setup heads (cd/export) AND pipe filters
  // (tail/grep) so `cd x && bun run check | tail` signatures `bun run check`.
  const segments = splitChain(cmd);
  const real = (seg: string) => {
    const h = segmentHead(seg);
    return h && !SETUP_HEADS.has(h) && !FILTER_HEADS.has(h);
  };
  const target = segments.find(real) ?? segments.find((s) => { const h = segmentHead(s); return h && !SETUP_HEADS.has(h); }) ?? segments[segments.length - 1] ?? cmd;

  let tokens = tokenize(target);
  while (tokens.length && ENV_ASSIGN.test(tokens[0]!)) tokens.shift(); // drop env prefix
  // Strip prefix wrappers (timeout 30 / sudo -E / xargs -I{}) → the wrapped cmd.
  let argv0 = tokens.length ? cmdHead(tokens[0]!) : "";
  while (WRAPPER_HEADS.has(argv0) && tokens.length > 1) {
    tokens.shift(); // drop the wrapper
    while (tokens.length && (tokens[0]!.startsWith("-") || /^\d+[a-z]?$/i.test(tokens[0]!))) tokens.shift(); // its flags + duration
    argv0 = tokens.length ? cmdHead(tokens[0]!) : "";
  }
  if (tokens.length === 0 || !argv0) return "Bash";

  if (LOOP_HEADS.has(argv0)) return `Bash:${argv0} loop`;
  if (SHELL_KEYWORDS.has(argv0)) return "Bash:(misc)"; // loop-body fragment, not a command

  // Guard parse artifacts: a real command head starts with a letter, has a
  // lowercase char, and isn't ALLCAPS_UNDERSCORE (an env var) — collapse the
  // junk (`SCRAPECREATORS_API_KEY`, `·n`, a split User-Agent) into one bucket.
  if (!(/^[A-Za-z][\w./-]*$/.test(argv0) && /[a-z]/.test(argv0)) || /^[A-Z0-9_]+$/.test(argv0)) return "Bash:(misc)";

  if (argv0 === "curl" || argv0 === "wget" || argv0 === "http" || argv0 === "https") {
    return stripNoise(curlSig(argv0, tokens));
  }

  // Heredoc: the script body is unique each call; the command is the signal.
  if (/<<-?\s*['"]?[A-Za-z0-9_]+/.test(target)) return stripNoise(`Bash:${argv0} <<heredoc`);

  // Generic: argv0 + first non-flag SUBCOMMAND (git commit, composio run). A
  // subcommand is a single short word — skip flags, env assigns, redirects, and
  // quoted multi-word VALUES (`psql -c "select …"`) so those collapse by argv0.
  const sub = tokens.slice(1).find((t) => !t.startsWith("-") && !ENV_ASSIGN.test(t) && !/[<>]/.test(t) && !t.includes(" ") && t.length <= 30);
  return stripNoise(`Bash:${argv0}${sub ? " " + unquote(sub) : ""}`);
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

// "Soft" errors are harness/workflow artifacts, NOT tool failures: the agent
// editing before reading, the user cancelling a tool, a parallel call being
// dropped. They're noise in a reliability lens, so we treat them as non-errors.
const SOFT_ERROR_RE = /has not been read yet|has been modified since read|want to proceed|Cancelled: parallel|^\s*<?tool_use_error>?\s*Blocked:/i;
export function isSoftError(text: string): boolean {
  return SOFT_ERROR_RE.test(text);
}

// Coarse error bucket from a tool-result text — a short, noise-stripped key so
// the same failure groups. Display/grouping aid only; the error analyzer keys
// primarily on (name, argSig). Returns null for empty results.
export function errorClass(resultText: string): string | null {
  const firstLine = resultText.split("\n").map((l) => l.trim()).find(Boolean);
  if (!firstLine) return null;
  return stripNoise(firstLine).slice(0, 60);
}

// The raw body to sub-cluster on: a Bash command / a query / the input JSON.
function bodyOf(input: unknown, inputSummary?: string): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  if (typeof obj?.command === "string") return obj.command;
  if (typeof obj?.query === "string") return obj.query;
  if (typeof obj?.sql === "string") return obj.sql;
  if (obj) {
    try {
      return JSON.stringify(obj);
    } catch {
      /* fall through */
    }
  }
  return inputSummary ?? "";
}

// Structural shape of a command: strip the value-bearing bits (paths, numbers,
// quoted strings) so "the same kind of call" collapses.
function shapeOf(cmd: string): string {
  let n = cmd.trim();
  n = n.replace(/^cd\s+("[^"]*"|\S+)\s*&&\s*/, "");
  n = n.replace(/\/[^\s"']+/g, "PATH");
  n = n.replace(/"[^"]*"/g, "STR").replace(/'[^']*'/g, "STR");
  n = n.replace(/\b\d+\b/g, "N");
  n = n.replace(/\s+/g, " ").trim();
  return n.slice(0, 80);
}

// The finer sub-cluster WITHIN a signature, computed once at index time so the
// drill is a cheap GROUP BY (no transcript re-read). Picks the most salient:
// an ALLCAPS API slug (Composio/Intercom/…), else a SQL table, else the shape.
export function callDetail(input: unknown, inputSummary?: string): string {
  const body = bodyOf(input, inputSummary);
  const slug = body.match(/\b[A-Z][A-Z0-9]{2,}_[A-Z0-9_]+\b/);
  if (slug) return slug[0];
  // SQL keywords are uppercase in these scripts; case-sensitive avoids matching
  // prose like "from the …" in agent prompts.
  const tbl = body.match(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_.]+)/);
  if (tbl) return "→" + tbl[1]!.toLowerCase();
  return shapeOf(body);
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

  // Second pass: assign each tool call to the user turn it sits under. Skip
  // assistant messages the harness re-logged (same dedupKey) so re-logged tool
  // calls aren't double-counted and their offsets stay aligned with the cost
  // layer (which keeps the first occurrence too).
  const facts: ToolCallFact[] = [];
  const seenMsg = new Set<string>();
  let turnNo = -1; // → 0 at the first clean user message (matches collectTurns)
  let seq = 0;
  for (const e of events) {
    if (e.role === "user" && cleanPrompt(e.text)) turnNo++;
    if (e.role === "assistant" && e.tools) {
      if (e.dedupKey) {
        if (seenMsg.has(e.dedupKey)) continue; // re-logged copy → skip
        seenMsg.add(e.dedupKey);
      }
      for (const t of e.tools) {
        const r = t.id ? results.get(t.id) : undefined;
        // A real error = the tool reported one AND it isn't a soft harness/user
        // artifact (read-before-edit, cancellation, parallel-drop).
        let hasError = false;
        let ec: string | null = null;
        if (r?.err) {
          const txt = findResultText(events, t.id);
          if (!isSoftError(txt)) {
            hasError = true;
            ec = errorClass(txt);
          }
        }
        facts.push({
          seq: seq++,
          turn: turnNo < 0 ? null : turnNo,
          name: t.name,
          argSig: argSig(t.name, t.input, t.inputSummary),
          detail: callDetail(t.input, t.inputSummary),
          dedupKey: e.dedupKey ?? null,
          estTokens: estTokensFor(t.input, t.inputSummary, r?.len ?? 0),
          hasError,
          errorClass: ec,
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
