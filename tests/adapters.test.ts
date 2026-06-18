import { test, expect, describe } from "bun:test";
import { parseJsonl, extractText, toEpochMs, ellipsize, type Event } from "../src/adapters/types.ts";
import { deriveFromEvents, cleanPrompt } from "../src/adapters/claude.ts";
import { scanProjectDirs } from "../src/adapters/scan.ts";
import { resolveProject } from "../src/project.ts";

describe("parseJsonl", () => {
  test("parses valid lines and tolerates a truncated one", () => {
    const content = '{"a":1}\n{bad json\n\n{"b":2}\n';
    expect(parseJsonl(content)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("extractText", () => {
  test("string passthrough", () => {
    expect(extractText("hi")).toBe("hi");
  });
  test("array of text blocks (claude/codex/pi shapes)", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "output_text", text: "b" }])).toBe("ab");
  });
  test("ignores tool_use blocks (no .text)", () => {
    expect(extractText([{ type: "tool_use", name: "Bash" }, { type: "text", text: "z" }])).toBe("z");
  });
});

describe("ellipsize", () => {
  test("appends … only when truncating", () => {
    expect(ellipsize("short", 10)).toBe("short");
    expect(ellipsize("abcdefghij", 5)).toBe("abcde…");
  });
});

describe("toEpochMs", () => {
  test("ISO string", () => {
    expect(toEpochMs("2026-06-17T05:00:00.000Z")).toBe(Date.parse("2026-06-17T05:00:00.000Z"));
  });
  test("seconds → ms", () => {
    expect(toEpochMs(1780000000)).toBe(1780000000 * 1000);
  });
  test("already ms", () => {
    expect(toEpochMs(1780000000000)).toBe(1780000000000);
  });
});

describe("deriveFromEvents", () => {
  test("derives cwd, first prompt, counts, timestamps", () => {
    const events: Event[] = [
      { role: "user", text: "do the thing", ts: 1000, cwd: "/repo", branch: "main" },
      { role: "assistant", text: "ok", ts: 2000 },
      { role: "user", text: "again", ts: 3000 },
    ];
    const m = deriveFromEvents("sess1", events);
    expect(m.cwd).toBe("/repo");
    expect(m.branch).toBe("main");
    expect(m.title).toBe("do the thing");
    expect(m.msgCount).toBe(3);
    expect(m.startedAt).toBe(1000);
    expect(m.lastTs).toBe(3000);
  });
});

describe("cleanPrompt", () => {
  test("strips xml command wrappers", () => {
    expect(cleanPrompt("<command-name>/goal</command-name>do it")).toBe("do it");
  });
  test("drops interrupt noise", () => {
    expect(cleanPrompt("[Request interrupted by user]")).toBe("");
  });
});

describe("resolveProject", () => {
  test("a git repo resolves to its root (this repo)", () => {
    const p = resolveProject(process.cwd());
    expect(p).toBeTruthy();
    expect(process.cwd().startsWith(p!)).toBe(true);
  });
  test("null cwd → null", () => {
    expect(resolveProject(null)).toBeNull();
  });
});

describe("scanProjectDirs", () => {
  // Fake readdir returning two project dirs; "locked" throws EACCES when scanned.
  const fakeReaddir = ((_root: string, _opts?: unknown) =>
    [
      { name: "proj-ok", isDirectory: () => true },
      { name: "proj-locked", isDirectory: () => true },
      { name: "stray.jsonl", isDirectory: () => false }, // top-level file → ignored
    ]) as unknown as typeof import("node:fs").readdirSync;

  function fakeScan(files: Record<string, string[]>) {
    return (dir: string, _pattern: string): Iterable<string> => {
      const project = dir.split("/").pop()!;
      if (project === "proj-locked") {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return files[project] ?? [];
    };
  }

  test("re-prefixes per-dir matches with the project name", () => {
    const out = scanProjectDirs("/root", "*.jsonl", fakeScan({ "proj-ok": ["a.jsonl", "b.jsonl"] }), fakeReaddir);
    expect(out).toEqual(["proj-ok/a.jsonl", "proj-ok/b.jsonl"]);
  });

  test("skips a directory that throws EACCES instead of aborting the whole scan", () => {
    // proj-locked throws; proj-ok must still be returned.
    const out = scanProjectDirs("/root", "*.jsonl", fakeScan({ "proj-ok": ["keep.jsonl"] }), fakeReaddir);
    expect(out).toEqual(["proj-ok/keep.jsonl"]);
  });

  test("re-throws a non-permission error", () => {
    const boom = (_dir: string): Iterable<string> => {
      const err = new Error("boom") as NodeJS.ErrnoException;
      err.code = "EMFILE";
      throw err;
    };
    expect(() => scanProjectDirs("/root", "*.jsonl", boom, fakeReaddir)).toThrow("boom");
  });

  test("re-throws ENOENT instead of silently treating it like EACCES", () => {
    const missing = (_dir: string): Iterable<string> => {
      const err = new Error("missing") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    expect(() => scanProjectDirs("/root", "*.jsonl", missing, fakeReaddir)).toThrow("missing");
  });

  test("returns [] when the root itself is unreadable (EACCES)", () => {
    const lockedReaddir = (() => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }) as unknown as typeof import("node:fs").readdirSync;
    expect(scanProjectDirs("/root", "*.jsonl", fakeScan({}), lockedReaddir)).toEqual([]);
  });

  test("keeps subagent rel shape as <project>/<session>/subagents/<file>", () => {
    const out = scanProjectDirs(
      "/root",
      "*/subagents/agent-*.jsonl",
      fakeScan({ "proj-ok": ["session-1/subagents/agent-2.jsonl"] }),
      fakeReaddir,
    );
    expect(out).toEqual(["proj-ok/session-1/subagents/agent-2.jsonl"]);
    expect(out[0]!.split("/")[1]).toBe("session-1");
  });
});
