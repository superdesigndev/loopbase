import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argSig, stripNoise, errorClass, extractToolCalls, callDetail } from "../src/insights-extract.ts";
import { openDb, closeDb } from "../src/db.ts";
import { handle } from "../src/server.ts";
import type { Event } from "../src/adapters/types.ts";

describe("argSig — signature normalization", () => {
  test("Bash: generic = argv0 + first non-flag subtoken", () => {
    expect(argSig("Bash", { command: "git commit -m 'x'" })).toBe("Bash:git commit");
    expect(argSig("Bash", { command: "pnpm install" })).toBe("Bash:pnpm install");
    expect(argSig("Bash", { command: "ls" })).toBe("Bash:ls"); // no subtoken
  });

  test("Bash: identical command shape collapses regardless of message value", () => {
    const a = argSig("Bash", { command: "playwright screenshot --out a.png" });
    const b = argSig("Bash", { command: "playwright screenshot --out b.png" });
    expect(a).toBe(b);
    expect(a).toBe("Bash:playwright screenshot");
  });

  test("Bash: leading `cd && ...` is skipped — signature the real command, not the dir change", () => {
    const a = argSig("Bash", { command: 'cd "/Users/me/Documents/GitHub/superdesign agi" && git commit -m x' });
    expect(a).toBe("Bash:git commit");
    // different repo path, same real command → one bucket (was the over-collapse bug)
    const b = argSig("Bash", { command: 'cd "/other/repo" && git commit -m y' });
    expect(a).toBe(b);
    // env-setup prefixes are skipped too
    expect(argSig("Bash", { command: "export X=1 && pnpm install" })).toBe("Bash:pnpm install");
  });

  test("Bash: a pure `cd` (no real command) still buckets harmlessly", () => {
    expect(argSig("Bash", { command: 'cd "/some/dir"' })).toContain("Bash:cd");
  });

  test("Agent/Task: buckets by subagent type", () => {
    expect(argSig("Agent", { subagent_type: "Explore", prompt: "a" })).toBe("Agent:Explore");
    expect(argSig("Agent", { subagent_type: "Explore", prompt: "b" })).toBe("Agent:Explore");
  });

  test("Bash: curl keeps method + host+path so distinct endpoints don't over-collapse", () => {
    const prompts = argSig("Bash", { command: "curl -X POST https://api.x.dev/v1/prompts -d @b.json" });
    const upload = argSig("Bash", { command: "curl -X POST https://api.x.dev/v1/upload -F f=@t.png" });
    expect(prompts).not.toBe(upload);
    expect(prompts).toContain("POST");
    expect(prompts).toContain("api.x.dev/v1/prompts");
  });

  test("Bash: same curl endpoint with different query/body collapses", () => {
    const a = argSig("Bash", { command: "curl https://api.x.dev/prompts?id=1" });
    const b = argSig("Bash", { command: "curl https://api.x.dev/prompts?id=2" });
    expect(a).toBe(b);
  });

  test("Bash: curl skips -H value — gets the URL, not the Authorization header", () => {
    const sig = argSig("Bash", { command: 'curl -s -H "Authorization: Bearer abc" https://api.ahrefs.com/v3/keywords' });
    expect(sig).toBe("Bash:curl GET api.ahrefs.com/v3/keywords");
    expect(sig).not.toContain("Authorization");
  });

  test("Bash: leading env assignments are stripped", () => {
    expect(argSig("Bash", { command: "POSTHOG_KEY=x bun run script.ts" })).toBe("Bash:bun run");
  });

  test("Bash: heredoc collapses to one bucket (body is unique each call)", () => {
    const a = argSig("Bash", { command: "python3 <<'PY'\nprint(1)\nPY" });
    const b = argSig("Bash", { command: "python3 <<'PY'\nprint(2)\nPY" });
    expect(a).toBe(b);
    expect(a).toBe("Bash:python3 <<heredoc");
  });

  test("Bash: pipe chain signatures the first real command", () => {
    expect(argSig("Bash", { command: "cat file.json | jq '.x'" })).toBe("Bash:cat file.json");
  });

  test("MCP: name + sorted arg KEYS, never values", () => {
    const a = argSig("mcp__supabase__query", { sql: "select 1" });
    const b = argSig("mcp__supabase__query", { sql: "select 2 from t" });
    expect(a).toBe(b);
    expect(a).toBe("mcp__supabase__query(sql)");
    // key set, sorted + stable
    expect(argSig("mcp__x__y", { b: 1, a: 2 })).toBe("mcp__x__y(a,b)");
  });

  test("file tools: extension or dir, never the full path", () => {
    expect(argSig("Read", { file_path: "/a/b/c/Foo.tsx" })).toBe("Read:*.tsx");
    expect(argSig("Edit", { file_path: "/x/y/Bar.tsx" })).toBe("Edit:*.tsx");
    // same extension, different files → one bucket
    expect(argSig("Read", { file_path: "/p/q/Baz.tsx" })).toBe("Read:*.tsx");
  });

  test("Task: buckets by subagent type", () => {
    expect(argSig("Task", { subagent_type: "Explore", prompt: "find x" })).toBe("Task:Explore");
    expect(argSig("Task", { subagent_type: "Explore", prompt: "find y" })).toBe("Task:Explore");
  });

  test("unknown tools fall back to the bare name (value-bearing args bucket together)", () => {
    expect(argSig("Grep", { pattern: "foo" })).toBe("Grep");
    expect(argSig("WebFetch", { url: "https://a.com" })).toBe("WebFetch");
  });
});

describe("callDetail — sub-cluster within a signature", () => {
  test("ALLCAPS API slug wins (composio → the Intercom tool)", () => {
    expect(callDetail({ command: 'composio run --logs-off INTERCOM_SEARCH_CONVERSATIONS --params x' })).toBe("INTERCOM_SEARCH_CONVERSATIONS");
  });
  test("falls back to SQL table", () => {
    expect(callDetail({ command: 'supabase db query --linked "SELECT * FROM subscriptions"' })).toBe("→subscriptions");
  });
  test("falls back to a normalized command shape", () => {
    const a = callDetail({ command: "git commit -m 'a'" });
    const b = callDetail({ command: "git commit -m 'b'" });
    expect(a).toBe(b); // values stripped → same shape
  });
});

describe("stripNoise — anti-fragmentation", () => {
  test("temp paths, hashes, dates, long digit runs become placeholders", () => {
    expect(stripNoise("/tmp/claude-502/x.png")).toBe("·path");
    expect(stripNoise("deadbeefcafe1234")).toBe("·hash");
    expect(stripNoise("2026-06-18T00:00")).toBe("·date");
    expect(stripNoise("port 8080")).toBe("port ·n");
  });
});

describe("errorClass", () => {
  test("first non-empty line, noise-stripped + capped", () => {
    expect(errorClass("Error: connection refused on 5432\nstack...")).toBe("Error: connection refused on ·n");
    expect(errorClass("")).toBe(null);
  });
});

describe("extractToolCalls — facts from events", () => {
  function ev(partial: Partial<Event>): Event {
    return { role: "assistant", text: "", ts: null, ...partial };
  }

  test("assigns each call to its user turn and joins result error/length", () => {
    const events: Event[] = [
      ev({ role: "user", text: "first task" }), // turn 0
      ev({ role: "assistant", tools: [{ id: "t1", name: "Bash", input: { command: "ls" } }] }),
      ev({ role: "tool_result", toolResultId: "t1", text: "a\nb\nc" }),
      ev({ role: "user", text: "second task" }), // turn 1
      ev({ role: "assistant", tools: [{ id: "t2", name: "Read", input: { file_path: "/x/Foo.tsx" } }] }),
      ev({ role: "tool_result", toolResultId: "t2", text: "FAILED", toolResultError: true }),
    ];
    const facts = extractToolCalls(events);
    expect(facts.length).toBe(2);
    expect(facts[0]).toMatchObject({ seq: 0, turn: 0, name: "Bash", argSig: "Bash:ls", hasError: false });
    expect(facts[1]).toMatchObject({ seq: 1, turn: 1, name: "Read", argSig: "Read:*.tsx", hasError: true });
    expect(facts[1]!.errorClass).toBe("FAILED");
    // est tokens grows with I/O size and is non-negative
    expect(facts[0]!.estTokens).toBeGreaterThanOrEqual(0);
  });

  test("soft errors (read-before-edit, cancellation) are NOT counted as errors", () => {
    const events: Event[] = [
      ev({ role: "user", text: "go" }),
      ev({ role: "assistant", tools: [{ id: "s1", name: "Edit", input: { file_path: "/x/a.ts" } }] }),
      ev({ role: "tool_result", toolResultId: "s1", text: "<tool_use_error>File has not been read yet. Read it first</tool_use_error>", toolResultError: true }),
      ev({ role: "assistant", tools: [{ id: "s2", name: "Bash", input: { command: "psql -c 'x'" } }] }),
      ev({ role: "tool_result", toolResultId: "s2", text: "ERROR: boom", toolResultError: true }),
    ];
    const facts = extractToolCalls(events);
    expect(facts.find((f) => f.name === "Edit")!.hasError).toBe(false); // soft → not an error
    expect(facts.find((f) => f.name === "Bash")!.hasError).toBe(true); // real failure
  });

  test("calls before the first user turn get turn = null", () => {
    const events: Event[] = [
      ev({ role: "assistant", tools: [{ id: "t0", name: "Bash", input: { command: "echo hi" } }] }),
    ];
    expect(extractToolCalls(events)[0]!.turn).toBe(null);
  });

  test("no tools → no facts", () => {
    const events: Event[] = [ev({ role: "user", text: "hi" }), ev({ role: "assistant", text: "done" })];
    expect(extractToolCalls(events).length).toBe(0);
  });
});

describe("serve /api/insights — reads through the shared analyzers", () => {
  let dir: string;
  afterEach(() => {
    closeDb();
    delete process.env.LB_HOME;
    delete process.env.LB_SKIP_REINDEX;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function seed() {
    process.env.LB_SKIP_REINDEX = "1"; // don't scan real transcripts
    dir = mkdtempSync(join(tmpdir(), "lb-ins-"));
    process.env.LB_HOME = dir;
    const db = openDb();
    db.prepare("INSERT INTO sessions (native_id, agent, project, path, msg_count, last_ts) VALUES (?,?,?,?,?,?)").run(
      "ses12345extra",
      "claude",
      "/proj",
      "/x/s",
      10,
      1000,
    );
    const ins = db.prepare(
      "INSERT INTO tool_call (session_native_id, seq, turn, name, arg_sig, detail, est_tokens, has_error, error_class) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    // 4 identical automatable calls → above the count floor of 3
    for (let i = 0; i < 4; i++) ins.run("ses12345extra", i, 0, "Bash", "Bash:composio run", "INTERCOM_SEARCH_CONVERSATIONS", 500, 0, null);
    // harness + web tools that should NEVER appear in the automation lens
    for (let i = 0; i < 5; i++) ins.run("ses12345extra", 10 + i, 0, "Agent", "Agent:Explore", "x", 500, 0, null);
    for (let i = 0; i < 5; i++) ins.run("ses12345extra", 20 + i, 0, "WebSearch", "WebSearch", "q", 500, 0, null);
    return db;
  }

  test("GET /api/insights returns analyzers with short, show-resolvable example ids", async () => {
    seed();
    const j = (await handle(new Request("http://x/api/insights?all=true&analyzer=tool-freq")).json()) as any;
    expect(j.analyzers["tool-freq"].length).toBe(1);
    const sig = j.analyzers["tool-freq"][0];
    expect(sig.key).toBe("Bash:composio run");
    expect(sig.count).toBe(4);
    expect(sig.project).toBe("proj"); // dominant repo attribution
    expect(sig.details[0].key).toBe("INTERCOM_SEARCH_CONVERSATIONS"); // nested drill
    expect(sig.examples[0].session).toBe("ses12345"); // shortId = first 8 chars
  });

  test("default returns every analyzer group", async () => {
    seed();
    const j = (await handle(new Request("http://x/api/insights?all=true")).json()) as any;
    expect(Object.keys(j.analyzers).sort()).toEqual(["tool-errors", "tool-freq", "tool-ngram"]);
  });

  test("harness (Agent) and web (WebSearch) tools are excluded from the automation lens", async () => {
    seed();
    const j = (await handle(new Request("http://x/api/insights?all=true&analyzer=tool-freq")).json()) as any;
    const keys = j.analyzers["tool-freq"].map((s: any) => s.key);
    expect(keys).toContain("Bash:composio run");
    expect(keys).not.toContain("Agent:Explore");
    expect(keys).not.toContain("WebSearch");
  });
});
