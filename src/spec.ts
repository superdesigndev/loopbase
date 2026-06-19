// Declarative command spec — the SINGLE SOURCE OF TRUTH for the CLI surface.
// Drives: (a) argument parsing, (b) --help text, (c) the CI naming-lint.
// Consistency holds by construction, not review. (PLAN.md → Conventions.)

import { BIN_NAME } from "./constants.ts";

export type FlagType = "string" | "bool" | "int" | "enum";

export interface FlagSpec {
  name: string; // long flag without leading dashes, e.g. "max-chars"
  type: FlagType;
  enumValues?: string[]; // when type === "enum"
  default?: string | number | boolean;
  desc: string;
}

export interface ArgSpec {
  name: string;
  required: boolean;
  desc: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  args: ArgSpec[];
  flags: FlagSpec[];
  hidden?: boolean;
}

// Flags available on every command.
export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "json", type: "bool", default: true, desc: "Force JSON output (default)." },
  { name: "text", type: "bool", default: false, desc: "Human-readable output instead of JSON." },
  { name: "help", type: "bool", default: false, desc: "Show help for this command." },
];

export const COMMANDS: CommandSpec[] = [
  {
    name: "log",
    summary: "Append a worklog entry to the current session (auto-resolved, auto-spanned).",
    args: [{ name: "text", required: true, desc: "Title — what you just did (one line)." }],
    flags: [
      { name: "tags", type: "string", desc: "Comma-separated tags (e.g. infra,product)." },
      { name: "body", type: "string", desc: "Optional 1-2 line detail (outcome first), like LOG.md's `What:`." },
      { name: "turns", type: "string", desc: "Advanced: retro-tag a past turn range (e.g. 12 or 12-18) instead of auto-spanning. Inspect turns with `show` first." },
      { name: "dry-run", type: "bool", default: false, desc: "Preview the resolved session + span without writing." },
      { name: "session", type: "string", desc: "Manual session-id override (rarely needed)." },
    ],
  },
  {
    name: "list",
    summary: "List sessions for the current project, each with its worklog entries.",
    args: [],
    flags: [
      { name: "path", type: "string", desc: "Scope to another directory instead of cwd." },
      { name: "all", type: "bool", default: false, desc: "Every project, not just the current one." },
      { name: "since", type: "string", desc: "Only entries within this window, e.g. 24h, 7d." },
      { name: "agent", type: "enum", enumValues: ["claude", "codex", "pi"], desc: "Filter by agent." },
      { name: "limit", type: "int", default: 20, desc: "Max rows to return." },
      { name: "logs", type: "bool", default: false, desc: "Flat worklog feed across sessions (LOG.md-style) instead of a session list." },
    ],
  },
  {
    name: "search",
    summary: "Find sessions/turns by content across agents, then dive with `show --turn`.",
    args: [{ name: "query", required: true, desc: "Text to find (case-insensitive substring; --regex for a pattern)." }],
    flags: [
      { name: "path", type: "string", desc: "Scope to another directory instead of cwd." },
      { name: "all", type: "bool", default: false, desc: "Search every project, not just the current one." },
      { name: "session", type: "string", desc: "Search within a single session id." },
      { name: "agent", type: "enum", enumValues: ["claude", "codex", "pi"], desc: "Filter by agent." },
      { name: "since", type: "string", desc: "Only sessions updated within this window, e.g. 24h, 7d." },
      { name: "limit", type: "int", default: 20, desc: "Max matches." },
      { name: "regex", type: "bool", default: false, desc: "Treat the query as a regular expression." },
      { name: "include-tools", type: "bool", default: false, desc: "Also search tool inputs/results (noisier)." },
      { name: "files", type: "bool", default: false, desc: "Only list matching sessions + raw file paths (grep -l style), for custom piping." },
      { name: "include-current", type: "bool", default: false, desc: "Include the caller's own session (excluded by default — it echoes the query you just typed)." },
    ],
  },
  {
    name: "show",
    summary: "Understand a session: the map by default; --turn/--log/--role to read messages.",
    args: [{ name: "session_id", required: true, desc: `Session id from \`${BIN_NAME} list\`.` }],
    flags: [
      { name: "log", type: "string", desc: "Scope to one worklog span (log id)." },
      { name: "turn", type: "int", desc: "Open one user turn by its `turn` index from the map." },
      { name: "agent", type: "string", desc: "Descend into a subagent transcript (agent id)." },
      { name: "tool", type: "string", desc: "Full untruncated result of ONE tool call (tool id)." },
      { name: "role", type: "enum", enumValues: ["assistant", "all"], desc: "Read messages: `all` = full transcript, `assistant` = assistant only. (Omit for the default map.)" },
      { name: "expand-tools", type: "bool", default: false, desc: "Inline tool I/O, truncated." },
      { name: "max-chars", type: "int", default: 2000, desc: "Truncate long text/results to N chars." },
      { name: "limit", type: "int", default: 40, desc: "Max messages returned (page size) — bounds long sessions." },
      { name: "offset", type: "int", default: 0, desc: "Skip the first N messages (paging through a long session)." },
      { name: "deliver", type: "string", desc: "Output sink: stdout (default) or file:PATH." },
    ],
  },
  {
    name: "cost",
    summary: "Token + USD cost per session (memoized at index). Pass a session id for its model breakdown.",
    args: [{ name: "session_id", required: false, desc: `Optional session id from \`${BIN_NAME} list\` for a per-model breakdown.` }],
    flags: [
      { name: "path", type: "string", desc: "Scope to another directory instead of cwd." },
      { name: "all", type: "bool", default: false, desc: "Every project, not just the current one." },
      { name: "since", type: "string", desc: "Only sessions updated within this window, e.g. 24h, 7d." },
      { name: "agent", type: "enum", enumValues: ["claude", "codex", "pi"], desc: "Filter by agent." },
      { name: "limit", type: "int", default: 20, desc: "Max sessions to return." },
      { name: "summary", type: "bool", default: false, desc: "Aggregate spend by model/provider instead of per session." },
      { name: "refresh", type: "bool", default: false, desc: "Refresh the price catalog from upstream, then reprice stored history." },
    ],
  },
  {
    name: "insights",
    summary: "Ranked automation candidates: repeated/expensive tool patterns, call sequences, and errors.",
    args: [],
    flags: [
      { name: "analyzer", type: "string", desc: "Comma-separated analyzers (default all): tool-freq, tool-ngram, tool-errors." },
      { name: "path", type: "string", desc: "Scope to another directory instead of cwd." },
      { name: "all", type: "bool", default: false, desc: "Every project, not just the current one." },
      { name: "since", type: "string", desc: "Only sessions updated within this window, e.g. 24h, 7d." },
      { name: "agent", type: "enum", enumValues: ["claude", "codex", "pi"], desc: "Filter by agent." },
      { name: "top", type: "int", default: 20, desc: "Max candidates per analyzer." },
      { name: "include-edits", type: "bool", default: false, desc: "Include file-mutation tools (Read/Edit/Write) in the automation lens — off by default (they're the substance of coding, not scriptable)." },
      { name: "show-signature", type: "bool", default: false, desc: "Debug: print raw tool call -> normalized signature, to eyeball collapse quality." },
    ],
  },
  {
    name: "serve",
    summary: "Local web UI for sessions + cost (reads the index; re-indexes on each load).",
    args: [],
    flags: [{ name: "port", type: "int", default: 4178, desc: "Port to listen on (default 4178)." }],
  },
  {
    name: "index",
    summary: "Maintenance: force a full re-index.",
    hidden: true,
    args: [],
    flags: [{ name: "rebuild", type: "bool", default: false, desc: "Drop and rebuild the index from scratch." }],
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

// A working invocation line for a command — embedded in errors so an agent can
// self-correct in one retry. (Principle 3.)
export function usageString(cmd: CommandSpec): string {
  const args = cmd.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
  return `${BIN_NAME} ${cmd.name}${args ? " " + args : ""}${cmd.flags.length ? " [flags]" : ""}`;
}

// --- Naming lint (Principle 6: vocabulary by construction) -------------------
// Banned tokens that must never appear in the spec. Fails CI if they do.
const BANNED_VERBS = ["ls", "info", "rm", "remove", "delete", "get", "create"];
const BANNED_FLAGS = ["format", "output", "skip-confirmations", "skip-confirm", "yes", "no-input"];

export function lintSpec(): string[] {
  const errors: string[] = [];
  for (const cmd of COMMANDS) {
    if (BANNED_VERBS.includes(cmd.name)) {
      errors.push(`command "${cmd.name}" uses a banned verb (use the canonical synonym)`);
    }
    for (const flag of [...cmd.flags, ...GLOBAL_FLAGS]) {
      if (BANNED_FLAGS.includes(flag.name)) {
        errors.push(`flag --${flag.name} on "${cmd.name}" is banned (use canonical flag)`);
      }
      if (flag.type === "enum" && (!flag.enumValues || flag.enumValues.length === 0)) {
        errors.push(`enum flag --${flag.name} on "${cmd.name}" has no enumValues`);
      }
    }
  }
  return errors;
}
