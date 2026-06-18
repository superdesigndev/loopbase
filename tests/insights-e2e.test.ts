import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end: build a fixture HOME with two Claude sessions that share a
// repeated tool-call SEQUENCE (curl → read → query), plus a recurring error,
// then drive the real CLI. Exercises: index writes tool_call facts (Phase 2),
// tool-freq / tool-errors / tool-ngram analyzers (Phases 3-4).

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let HOME: string;
let LB_HOME: string;
const PROJ = "/tmp/lb-insights-proj";
const ENC = "-tmp-lb-insights-proj";
const S1 = "aaaaaaaa-1111-1111-1111-111111111111";
const S2 = "bbbbbbbb-2222-2222-2222-222222222222";

function run(args: string[]): any {
  const res = Bun.spawnSync(["bun", "run", CLI, ...args], { env: { ...process.env, HOME, LB_HOME } });
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

// One tool call = an assistant tool_use line + a user tool_result line.
function step(id: string, name: string, input: unknown, result: string, isError = false): string[] {
  return [
    JSON.stringify({ type: "assistant", sessionId: "", cwd: PROJ, gitBranch: "main", timestamp: "2026-06-17T00:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }),
    JSON.stringify({ type: "user", cwd: PROJ, timestamp: "2026-06-17T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result, ...(isError ? { is_error: true } : {}) }] } }),
  ];
}

// The shared A→B→C sequence, repeated `reps` times, with unique ids per session.
function sequenceLines(sid: string, reps: number): string[] {
  const lines: string[] = [
    JSON.stringify({ type: "user", sessionId: sid, cwd: PROJ, gitBranch: "main", timestamp: "2026-06-17T00:00:00.000Z", message: { role: "user", content: "build the prompt library item" } }),
  ];
  let i = 0;
  for (let r = 0; r < reps; r++) {
    lines.push(...step(`${sid}-a${r}`, "Bash", { command: `curl -X POST https://api.superdesign.dev/v1/prompts -d @body${i++}.json` }, "ok " + "x".repeat(40)));
    lines.push(...step(`${sid}-b${r}`, "Read", { file_path: `/repo/src/Component${i++}.tsx` }, "file contents ".repeat(20)));
    lines.push(...step(`${sid}-c${r}`, "mcp__supabase__query", { sql: `select ${i++} from prompts` }, "rows ".repeat(10)));
  }
  return lines;
}

beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), "lb-home-"));
  LB_HOME = mkdtempSync(join(tmpdir(), "lb-store-"));
  const dir = join(HOME, ".claude", "projects", ENC);
  mkdirSync(dir, { recursive: true });

  // Session 1: the sequence ×2, plus 3 recurring psql errors.
  const s1 = sequenceLines(S1, 2);
  for (let e = 0; e < 3; e++) s1.push(...step(`${S1}-e${e}`, "Bash", { command: `psql -c "select * from missing_${e}"` }, "ERROR: relation does not exist", true));
  writeFileSync(join(dir, `${S1}.jsonl`), s1.join("\n") + "\n");

  // Session 2: the same sequence ×2 (gives cross-session ngram recurrence).
  writeFileSync(join(dir, `${S2}.jsonl`), sequenceLines(S2, 2).join("\n") + "\n");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(LB_HOME, { recursive: true, force: true });
});

describe("insights end-to-end", () => {
  test("Phase 2: index writes tool_call facts (sessions show up)", () => {
    const r = run(["index", "--rebuild"]);
    expect(r.ok).toBe(true);
    expect(r.updated).toBeGreaterThanOrEqual(2);
  });

  test("Phase 3: tool-freq surfaces the repeated buckets, deduped by signature", () => {
    const r = run(["insights", "--analyzer", "tool-freq", "--path", PROJ]);
    const keys = r.analyzers["tool-freq"].map((s: any) => s.key);
    // each of the 3 sig kinds appears 4× across the two sessions (> floor of 3)
    expect(keys).toContain("Bash:curl POST api.superdesign.dev/v1/prompts");
    expect(keys).toContain("Read:*.tsx");
    expect(keys).toContain("mcp__supabase__query(sql)");
    const readBucket = r.analyzers["tool-freq"].find((s: any) => s.key === "Read:*.tsx");
    expect(readBucket.count).toBe(4);
    expect(readBucket.sessions).toBe(2);
    expect(readBucket.examples.length).toBeLessThanOrEqual(3);
    expect(readBucket.examples[0].session.length).toBe(8); // short id, show-resolvable
  });

  test("Phase 3: count floor drops one-offs", () => {
    // The psql error sig only appears in session 1; as a non-error frequency it's
    // 3 calls → exactly at the floor, so it MAY appear. A truly rare sig wouldn't.
    const r = run(["insights", "--analyzer", "tool-freq", "--path", PROJ]);
    for (const s of r.analyzers["tool-freq"]) expect(s.count).toBeGreaterThanOrEqual(3);
  });

  test("Phase 4: tool-errors surfaces the recurring failure with a sample", () => {
    const r = run(["insights", "--analyzer", "tool-errors", "--path", PROJ]);
    expect(r.analyzers["tool-errors"].length).toBeGreaterThanOrEqual(1);
    const psql = r.analyzers["tool-errors"][0];
    expect(psql.count).toBe(3);
    expect(psql.key).toContain("psql");
    expect(psql.sample).toContain("ERROR");
  });

  test("Phase 4: tool-ngram surfaces the cross-session sequence only", () => {
    const r = run(["insights", "--analyzer", "tool-ngram", "--path", PROJ]);
    const grams = r.analyzers["tool-ngram"];
    expect(grams.length).toBeGreaterThanOrEqual(1);
    const top = grams[0];
    // the A→B→C motif, recurring in BOTH sessions
    expect(top.key).toBe("Bash:curl POST api.superdesign.dev/v1/prompts → Read:*.tsx → mcp__supabase__query(sql)");
    expect(top.sessions).toBe(2);
    expect(top.count).toBeGreaterThanOrEqual(3);
  });

  test("default runs all analyzers", () => {
    const r = run(["insights", "--path", PROJ]);
    expect(Object.keys(r.analyzers).sort()).toEqual(["tool-errors", "tool-freq", "tool-ngram"]);
  });

  test("bad --analyzer enumerates the valid set (self-healing)", () => {
    const r = run(["insights", "--analyzer", "bogus", "--path", PROJ]);
    expect(r.error).toBe("invalid_value");
    expect(r.valid).toContain("tool-freq");
  });

  test("--show-signature prints raw -> signature collapse", () => {
    const r = run(["insights", "--show-signature", "--path", PROJ]);
    expect(Array.isArray(r.signatures)).toBe(true);
    const read = r.signatures.find((s: any) => s.sig === "Read:*.tsx");
    expect(read).toBeTruthy();
    expect(read.count).toBeGreaterThanOrEqual(2);
  });
});
