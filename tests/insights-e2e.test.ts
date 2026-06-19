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

// The shared A→B→C sequence of AUTOMATABLE tools (curl → mcp query → gh pr),
// repeated `reps` times, plus a couple editor calls (for the --include-edits
// path). Unique ids per session.
function sequenceLines(sid: string, reps: number): string[] {
  const lines: string[] = [
    JSON.stringify({ type: "user", sessionId: sid, cwd: PROJ, gitBranch: "main", timestamp: "2026-06-17T00:00:00.000Z", message: { role: "user", content: "build the prompt library item" } }),
  ];
  let i = 0;
  for (let r = 0; r < reps; r++) {
    lines.push(...step(`${sid}-a${r}`, "Bash", { command: `curl -X POST https://api.superdesign.dev/v1/prompts -d @body${i++}.json` }, "ok " + "x".repeat(40)));
    lines.push(...step(`${sid}-b${r}`, "mcp__supabase__query", { sql: `select ${i++} from prompts` }, "rows ".repeat(10)));
    lines.push(...step(`${sid}-c${r}`, "Bash", { command: `gh pr create --title "item ${i++}"` }, "https://github.com/x/pr/1"));
    lines.push(...step(`${sid}-i${r}`, "Bash", { command: `composio run --logs-off INTERCOM_SEARCH_CONVERSATIONS --params '{"q":${i++}}'` }, "conv list"));
  }
  // editor calls — excluded from the automation lens by default
  for (let r = 0; r < reps; r++) lines.push(...step(`${sid}-d${r}`, "Read", { file_path: `/repo/src/Component${i++}.tsx` }, "file contents ".repeat(20)));
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

  test("Phase 3: tool-freq surfaces the automatable buckets, deduped by signature", () => {
    const r = run(["insights", "--analyzer", "tool-freq", "--path", PROJ]);
    const keys = r.analyzers["tool-freq"].map((s: any) => s.key);
    // each automatable sig appears 4× across the two sessions (> floor of 3)
    expect(keys).toContain("Bash:curl POST api.superdesign.dev/v1/prompts");
    expect(keys).toContain("mcp__supabase__query(sql)");
    expect(keys).toContain("Bash:gh pr");
    const curlBucket = r.analyzers["tool-freq"].find((s: any) => s.key === "Bash:curl POST api.superdesign.dev/v1/prompts");
    expect(curlBucket.count).toBe(4);
    expect(curlBucket.sessions).toBe(2);
    expect(curlBucket.project).toBe("lb-insights-proj"); // dominant repo attribution
    expect(curlBucket.examples.length).toBeLessThanOrEqual(3);
    expect(curlBucket.examples[0].session.length).toBe(8); // short id, show-resolvable
  });

  test("Phase 3: file-mutation tools are excluded from the automation lens by default", () => {
    const def = run(["insights", "--analyzer", "tool-freq", "--path", PROJ]);
    expect(def.analyzers["tool-freq"].map((s: any) => s.key)).not.toContain("Read:*.tsx");
    // --include-edits brings them back
    const inc = run(["insights", "--analyzer", "tool-freq", "--path", PROJ, "--include-edits"]);
    expect(inc.analyzers["tool-freq"].map((s: any) => s.key)).toContain("Read:*.tsx");
  });

  test("Phase 3: count floor + no-op drop", () => {
    const r = run(["insights", "--analyzer", "tool-freq", "--path", PROJ]);
    for (const s of r.analyzers["tool-freq"]) expect(s.count).toBeGreaterThanOrEqual(3);
  });

  test("drill: composio bucket nests its sub-cluster (the Intercom slug) by default", () => {
    const r = run(["insights", "--analyzer", "tool-freq", "--path", PROJ]);
    const composio = r.analyzers["tool-freq"].find((s: any) => s.key === "Bash:composio run");
    expect(composio).toBeTruthy();
    expect(composio.details[0].key).toBe("INTERCOM_SEARCH_CONVERSATIONS");
    expect(composio.details[0].count).toBe(4);
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
    // the A→B→C motif (automatable tools), recurring in BOTH sessions
    expect(top.key).toBe("Bash:curl POST api.superdesign.dev/v1/prompts → mcp__supabase__query(sql) → Bash:gh pr");
    expect(top.sessions).toBe(2);
    expect(top.count).toBeGreaterThanOrEqual(3);
    expect(top.project).toBe("lb-insights-proj");
  });

  test("default runs all analyzers", () => {
    const r = run(["insights", "--path", PROJ]);
    expect(Object.keys(r.analyzers).sort()).toEqual(["tool-error-retry", "tool-errors", "tool-freq", "tool-ngram"]);
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
