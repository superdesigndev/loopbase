import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end: build a fixture HOME with a Claude session, then drive the real
// CLI via subprocess with isolated HOME + LB_HOME. Tests index → log → dedup →
// span-advance → list TOC → show --log.

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let HOME: string;
let LB_HOME: string;
const SID = "11111111-2222-3333-4444-555555555555";
const PROJ = "/tmp/lb-fixture-proj";

function run(args: string[]): any {
  const res = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, HOME, LB_HOME, CLAUDE_CODE_SESSION_ID: SID },
  });
  // Results go to stdout; errors (structured JSON) go to stderr. Try both.
  const out = res.stdout.toString().trim();
  const err = res.stderr.toString().trim();
  try {
    return JSON.parse(out);
  } catch {}
  try {
    return JSON.parse(err);
  } catch {}
  return { _raw: out, _err: err };
}

beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), "lb-home-"));
  LB_HOME = mkdtempSync(join(tmpdir(), "lb-store-"));
  const enc = "-tmp-lb-fixture-proj";
  const dir = join(HOME, ".claude", "projects", enc);
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", sessionId: SID, cwd: PROJ, gitBranch: "main", timestamp: "2026-06-17T00:00:00.000Z", message: { role: "user", content: "first task please" } },
    { type: "assistant", sessionId: SID, cwd: PROJ, gitBranch: "main", timestamp: "2026-06-17T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  writeFileSync(join(dir, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(LB_HOME, { recursive: true, force: true });
});

describe("end-to-end (cli over a fixture session)", () => {
  test("index picks up the fixture session", () => {
    const r = run(["index", "--rebuild"]);
    expect(r.ok).toBe(true);
    expect(r.updated).toBeGreaterThanOrEqual(1);
  });

  test("log resolves the session via env var and spans the messages", () => {
    const r = run(["log", "implemented the thing"]);
    expect(r.ok).toBe(true);
    expect(r.id).toMatch(/^lg_/);
    expect(r.captured_msgs).toBe(2);
  });

  test("identical log dedups", () => {
    const r = run(["log", "implemented the thing"]);
    expect(r.deduped).toBe(true);
  });

  test("a different log with no new messages is rejected (one entry per batch)", () => {
    const r = run(["log", "a brand new line but nothing happened since"]);
    expect(r.error).toBe("empty");
    expect(r.hint).toContain("last log");
  });

  test("title + tags + body are stored and surfaced", () => {
    // fixture only has the one turn already logged; assert the stored shape via list
    const list = run(["list", "--path", PROJ]);
    const s = list.sessions.find((x: any) => x.id === SID.slice(0, 8));
    expect(s.worklog[0]).toMatchObject({ text: "implemented the thing" });
  });

  test("list --logs returns a flat cross-session worklog feed", () => {
    const r = run(["list", "--logs", "--path", PROJ]);
    expect(Array.isArray(r.logs)).toBe(true);
    expect(r.logs[0].title).toBe("implemented the thing");
    expect(r.logs[0].session).toBe(SID.slice(0, 8));
    expect(r.sessions).toBeUndefined(); // it's the feed, not the session list
  });

  test("search finds content and returns the turn handle", () => {
    const r = run(["search", "first task", "--path", PROJ]);
    expect(r.matches.length).toBeGreaterThanOrEqual(1);
    const m = r.matches.find((x: any) => x.session === SID.slice(0, 8));
    expect(m).toBeTruthy();
    expect(m.turn).toBe(0); // the only user turn
    expect(m.snippet.toLowerCase()).toContain("first task");
  });

  test("search --files returns matching raw paths (no parsing)", () => {
    const r = run(["search", "first task", "--path", PROJ, "--files"]);
    expect(r.matches).toBeUndefined();
    expect(r.files.some((f: any) => f.session === SID.slice(0, 8) && f.path.endsWith(".jsonl"))).toBe(true);
  });

  test("empty search query is rejected", () => {
    const r = run(["search", ""]);
    expect(r.error).toBe("usage");
  });

  test("log --turns retro-tags a past turn range (dry-run, no write)", () => {
    const r = run(["log", "tag the opener", "--turns", "0", "--dry-run"]);
    expect(r.dry_run).toBe(true);
    expect(r.would_log.turns).toBe("0-0");
    expect(r.would_log.captured_msgs).toBeGreaterThan(0);
  });

  test("log --turns out of range is rejected with a self-healing hint", () => {
    const r = run(["log", "x", "--turns", "99"]);
    expect(r.error).toBe("usage");
    expect(r.usage).toContain("show");
  });

  test("list shows the session with its worklog nested", () => {
    const r = run(["list", "--path", PROJ]);
    const s = r.sessions.find((x: any) => x.id === SID.slice(0, 8));
    expect(s).toBeTruthy();
    expect(s.agent).toBe("claude");
    expect(s.worklog.length).toBe(1);
    expect(s.worklog[0].text).toBe("implemented the thing");
  });

  test("show defaults to the map; --role all reads the transcript", () => {
    const map = run(["show", SID]);
    // session has a worklog entry → grouped map (worklog/unlogged keys, no `messages`)
    expect(map.worklog).toBeDefined();
    expect(map.messages).toBeUndefined();

    const full = run(["show", SID, "--role", "all"]);
    expect(full.messages[0].text).toBe("first task please");
  });

  test("dry-run does not write a second entry", () => {
    const r = run(["log", "a brand new entry", "--dry-run"]);
    expect(r.dry_run).toBe(true);
    const list = run(["list", "--path", PROJ]);
    const s = list.sessions.find((x: any) => x.id === SID.slice(0, 8));
    expect(s.worklog.length).toBe(1); // still just the one
  });
});
