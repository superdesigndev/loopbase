import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argSig, stripNoise, errorClass, extractToolCalls } from "../src/insights-extract.ts";
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
      "INSERT INTO tool_call (session_native_id, seq, turn, name, arg_sig, est_tokens, has_error, error_class) VALUES (?,?,?,?,?,?,?,?)",
    );
    // 4 identical Read calls → above the count floor of 3
    for (let i = 0; i < 4; i++) ins.run("ses12345extra", i, 0, "Read", "Read:*.tsx", 500, 0, null);
    return db;
  }

  test("GET /api/insights returns analyzers with short, show-resolvable example ids", async () => {
    seed();
    const j = (await handle(new Request("http://x/api/insights?all=true&analyzer=tool-freq")).json()) as any;
    expect(j.analyzers["tool-freq"].length).toBe(1);
    const sig = j.analyzers["tool-freq"][0];
    expect(sig.key).toBe("Read:*.tsx");
    expect(sig.count).toBe(4);
    expect(sig.examples[0].session).toBe("ses12345"); // shortId = first 8 chars
  });

  test("default returns every analyzer group", async () => {
    seed();
    const j = (await handle(new Request("http://x/api/insights?all=true")).json()) as any;
    expect(Object.keys(j.analyzers).sort()).toEqual(["tool-errors", "tool-freq", "tool-ngram"]);
  });
});
