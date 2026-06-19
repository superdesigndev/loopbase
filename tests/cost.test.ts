import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../src/db.ts";
import { estimateCost, builtinCatalog, normalizeModelName, pricingForModel, parseLiteLlm } from "../src/pricing.ts";
import { writeFileSync } from "node:fs";
import { claudeAdapter } from "../src/adapters/claude.ts";
import { codexAdapter } from "../src/adapters/codex.ts";
import { makeCostWriter, bucketize, repriceAll } from "../src/cost-index.ts";
import type { Adapter, UsageRow } from "../src/adapters/types.ts";
import { costForProject, costSummaryByModel, sessionCostBreakdown, logBatchCost } from "../src/queries.ts";
import type { ModelPricing } from "../src/pricing.ts";

// Minimal stub adapter that returns canned usage rows, for unit-testing the
// index-time cost writer without transcript file discovery.
function stubAdapter(usage: UsageRow[]): Adapter {
  return {
    kind: "claude",
    enumerate: () => [],
    readEvents: () => [],
    parseContent: () => [],
    deriveMeta: () => ({ nativeId: "x", cwd: null, branch: null, startedAt: null, lastTs: null, msgCount: 0, title: null }),
    resolveCurrentSession: () => null,
    readUsage: () => usage,
  };
}
const ur = (p: Partial<UsageRow> & { seq: number }): UsageRow => ({
  offset: p.seq * 100,
  ts: 0,
  model: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
  ...p,
});

// Cost feature — built incrementally across the cost-plan phases. Each describe
// block maps to a phase in docs/cost-plan.md.

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "lb-cost-"));
  process.env.LB_HOME = dir;
  return { dir, db: openDb() };
}

import { handle } from "../src/server.ts";

function insertSession(db: any, id: string, project: string, agent = "claude", lastTs = 1000) {
  db.prepare(
    "INSERT INTO sessions (native_id, agent, project, path, msg_count, last_ts) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, agent, project, "/x/" + id, 10, lastTs);
}

describe("Phase 6 — server API", () => {
  let dir: string;
  afterEach(() => {
    closeDb();
    delete process.env.LB_HOME;
    delete process.env.LB_SKIP_REINDEX;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function seed() {
    process.env.LB_SKIP_REINDEX = "1"; // don't scan real transcripts in tests
    const t = freshDb();
    dir = t.dir;
    insertSession(t.db, "sa", "/proj");
    makeCostWriter(t.db, builtinCatalog(), "v1").writeForSession(
      stubAdapter([ur({ seq: 0, model: "claude-opus-4-8", outputTokens: 1_000_000 })]),
      "sa",
      "/x",
      0,
    );
    return t.db;
  }

  test("GET / serves the SPA html", async () => {
    await seed();
    const res = handle(new Request("http://x/"));
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("loopbase");
  });

  test("GET /api/sessions returns priced sessions + total", async () => {
    await seed();
    const j = (await handle(new Request("http://x/api/sessions?all=true")).json()) as any;
    expect(j.count).toBe(1);
    expect(j.sessions[0].native_id).toBe("sa");
    expect(j.total_usd).toBeCloseTo(25, 6);
  });

  test("GET /api/sessions/:id returns model breakdown + worklog", async () => {
    await seed();
    const j = (await handle(new Request("http://x/api/sessions/sa")).json()) as any;
    expect(j.session.native_id).toBe("sa");
    expect(j.models.length).toBe(1);
    expect(j.total_usd).toBeCloseTo(25, 6);
  });

  test("GET /api/summary groups by model", async () => {
    await seed();
    const j = (await handle(new Request("http://x/api/summary?all=true")).json()) as any;
    expect(j.models.find((m: any) => m.model === "claude-opus-4-8").total_usd).toBeCloseTo(25, 6);
  });

  test("unknown route → 404", async () => {
    await seed();
    expect(handle(new Request("http://x/nope")).status).toBe(404);
    expect(handle(new Request("http://x/api/sessions/missing")).status).toBe(404);
  });

  test("detail includes per-log-batch cost over the worklog byte span", async () => {
    const db = await seed(); // session 'sa' has message_tokens at offsets 0 (seq0)
    // worklog entry covering offset [0,100) → should pick up the seq-0 message ($25)
    db.prepare(
      "INSERT INTO worklog (id, session_native_id, project, text, from_offset, to_offset, msg_count, created_at, content_hash) VALUES ('lg_x','sa','/proj','did a thing',0,100,1,1,'h')",
    ).run();
    const j = (await handle(new Request("http://x/api/sessions/sa")).json()) as any;
    const w = j.worklog.find((x: any) => x.id === "lg_x");
    expect(w.cost_usd).toBeCloseTo(25, 6);
  });

  test("GET /api/logs returns the global feed (newest first) with attributed cost per entry", async () => {
    const db = await seed(); // session 'sa' has a $25 message at offset 0
    db.prepare(
      "INSERT INTO worklog (id, session_native_id, project, text, body, tags, from_offset, to_offset, msg_count, created_at, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("lg_a", "sa", "/proj", "older entry", null, "infra", null, null, 2, 1000, "h1");
    db.prepare(
      "INSERT INTO worklog (id, session_native_id, project, text, body, tags, from_offset, to_offset, msg_count, created_at, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("lg_b", "sa", "/proj", "newer entry", "the detail", "product", 0, 100, 3, 2000, "h2");
    const j = (await handle(new Request("http://x/api/logs?all=true")).json()) as any;
    expect(j.count).toBe(2);
    expect(j.logs[0].text).toBe("newer entry"); // created_at DESC
    expect(j.logs[0].project).toBe("/proj");
    expect(j.logs[0].agent).toBe("claude");
    expect(j.logs[0].session).toBe("sa"); // shortId
    expect(j.logs[0].cost_usd).toBeCloseTo(25, 6); // span [0,100) picks up the $25 message
    expect(j.logs[1].cost_usd).toBeNull(); // no byte span → no attributable cost
    expect(j.total_usd).toBeCloseTo(25, 6);
  });

  test("/messages scopes by ?turn (insight drill) and ?from&to (log span)", async () => {
    process.env.LB_SKIP_REINDEX = "1";
    const t = freshDb();
    dir = t.dir;
    const db = t.db;
    const SID = "tracesession";
    const file = join(t.dir, SID + ".jsonl");
    const lines = [
      { type: "user", sessionId: SID, timestamp: "2026-06-17T00:00:00.000Z", message: { role: "user", content: "turn zero question" } },
      { type: "assistant", sessionId: SID, timestamp: "2026-06-17T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "reply zero" }] } },
      { type: "user", sessionId: SID, timestamp: "2026-06-17T00:00:02.000Z", message: { role: "user", content: "turn one question" } },
      { type: "assistant", sessionId: SID, timestamp: "2026-06-17T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "reply one" }] } },
    ];
    const ser = lines.map((l) => JSON.stringify(l));
    writeFileSync(file, ser.join("\n") + "\n");
    const off2 = Buffer.byteLength(ser.slice(0, 2).join("\n") + "\n", "utf8"); // start of turn one
    const off4 = Buffer.byteLength(ser.join("\n") + "\n", "utf8");
    db.prepare("INSERT INTO sessions (native_id, agent, project, path, msg_count, last_ts) VALUES (?,?,?,?,?,?)").run(SID, "claude", "/p", file, 4, 1000);

    const jt = (await handle(new Request("http://x/api/sessions/" + SID + "/messages?turn=1")).json()) as any;
    expect(jt.scope).toBe("turn:1");
    expect(jt.messages.map((m: any) => m.text)).toEqual(["turn one question", "reply one"]);

    const js = (await handle(new Request("http://x/api/sessions/" + SID + "/messages?from=" + off2 + "&to=" + off4)).json()) as any;
    expect(js.scope).toBe("span:" + off2 + "-" + off4);
    expect(js.messages.map((m: any) => m.text)).toEqual(["turn one question", "reply one"]);
  });

  test("/messages endpoint returns a paged, bounded shape", async () => {
    await seed();
    const j = (await handle(new Request("http://x/api/sessions/sa/messages?offset=0&limit=60")).json()) as any;
    expect(j).toHaveProperty("total");
    expect(j).toHaveProperty("messages");
    expect(Array.isArray(j.messages)).toBe(true);
  });
});

describe("Phase 4/5 — queries + reprice", () => {
  let dir: string;
  afterEach(() => {
    closeDb();
    delete process.env.LB_HOME;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("costForProject sorts by cost desc, scopes by project, flags estimates", () => {
    const t = freshDb();
    dir = t.dir;
    const { db } = t;
    const w = makeCostWriter(db, builtinCatalog(), "v1");
    insertSession(db, "big", "/proj");
    insertSession(db, "small", "/proj");
    insertSession(db, "other", "/elsewhere");
    w.writeForSession(stubAdapter([ur({ seq: 0, model: "claude-opus-4-8", outputTokens: 1_000_000 })]), "big", "/x", 0); // $25
    w.writeForSession(stubAdapter([ur({ seq: 0, model: "claude-haiku-4-5", outputTokens: 1_000_000 })]), "small", "/x", 0); // $5
    w.writeForSession(stubAdapter([]), "other", "/x", 4000); // byte-estimate, elsewhere

    const rows = costForProject({ project: "/proj", all: false, sinceMs: null, limit: 20 });
    expect(rows.map((r) => r.native_id)).toEqual(["big", "small"]); // cost desc, scoped
    expect(rows[0]!.total_usd).toBeCloseTo(25, 6);

    const allRows = costForProject({ project: null, all: true, sinceMs: null, limit: 20 });
    const otherRow = allRows.find((r) => r.native_id === "other")!;
    expect(otherRow.estimated).toBe(1);
    expect(otherRow.total_usd).toBeNull();
  });

  test("sessionCostBreakdown + costSummaryByModel aggregate per model", () => {
    const t = freshDb();
    dir = t.dir;
    const { db } = t;
    insertSession(db, "s1", "/proj");
    makeCostWriter(db, builtinCatalog(), "v1").writeForSession(
      stubAdapter([
        ur({ seq: 0, model: "claude-opus-4-8", outputTokens: 1_000_000 }),
        ur({ seq: 1, model: "claude-haiku-4-5", outputTokens: 1_000_000 }),
      ]),
      "s1",
      "/x",
      0,
    );
    const bd = sessionCostBreakdown("s1");
    expect(bd.length).toBe(2);
    const sum = costSummaryByModel({ project: "/proj", all: false, sinceMs: null, limit: 20 });
    expect(sum.find((r) => r.model === "claude-opus-4-8")!.total_usd).toBeCloseTo(25, 6);
  });

  test("logBatchCost range-sums message_tokens by offset", () => {
    const t = freshDb();
    dir = t.dir;
    const { db } = t;
    insertSession(db, "s1", "/proj");
    // stub offsets are seq*100 → seq0@0, seq1@100, seq2@200
    makeCostWriter(db, builtinCatalog(), "v1").writeForSession(
      stubAdapter([
        ur({ seq: 0, model: "claude-opus-4-8", outputTokens: 1_000_000 }), // $25 @offset 0
        ur({ seq: 1, model: "claude-opus-4-8", outputTokens: 1_000_000 }), // $25 @offset 100
        ur({ seq: 2, model: "claude-opus-4-8", outputTokens: 1_000_000 }), // $25 @offset 200
      ]),
      "s1",
      "/x",
      0,
    );
    const batch = logBatchCost("s1", 100, 300); // covers seq 1 and 2
    expect(batch.messages).toBe(2);
    expect(batch.total_usd).toBeCloseTo(50, 6);
  });

  test("repriceAll recomputes memoized cost against a new catalog + stamps version", () => {
    const t = freshDb();
    dir = t.dir;
    const { db } = t;
    insertSession(db, "s1", "/proj");
    makeCostWriter(db, builtinCatalog(), "v1").writeForSession(
      stubAdapter([ur({ seq: 0, model: "claude-opus-4-8", outputTokens: 1_000_000 })]),
      "s1",
      "/x",
      0,
    );
    expect(sessionCostBreakdown("s1")[0]!.total_usd).toBeCloseTo(25, 6);

    // Halve the output rate, reprice → cost halves, version updates.
    const cheaper = builtinCatalog();
    const opus = cheaper.get("claude-opus-4-8")! as ModelPricing;
    cheaper.set("claude-opus-4-8", { ...opus, outputPerMillionUsd: 12.5 });
    repriceAll(db, cheaper, "v2");

    const row = db.query("SELECT total_usd, catalog_version FROM session_cost WHERE session_native_id='s1'").get() as any;
    expect(row.total_usd).toBeCloseTo(12.5, 6);
    expect(row.catalog_version).toBe("v2");
  });
});

describe("Phase 3 — index-time aggregate + price", () => {
  let dir: string;
  afterEach(() => {
    closeDb();
    delete process.env.LB_HOME;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("writes message_tokens + per-model session_cost rollup with memoized cost", () => {
    const t = freshDb();
    dir = t.dir;
    const { db } = t;
    const usage: UsageRow[] = [
      ur({ seq: 0, model: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 0 }), // $5
      ur({ seq: 1, model: "claude-opus-4-8", inputTokens: 0, outputTokens: 1_000_000 }), // $25
      ur({ seq: 2, model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 0 }), // $1
    ];
    makeCostWriter(db, builtinCatalog(), "v1").writeForSession(stubAdapter(usage), "sess1", "/x", 0);

    const mtokN = (db.query("SELECT COUNT(*) n FROM message_tokens WHERE session_native_id='sess1'").get() as any).n;
    expect(mtokN).toBe(3);

    const rows = db
      .query("SELECT model, input_tokens, output_tokens, total_usd, burn_buckets FROM session_cost WHERE session_native_id='sess1' ORDER BY model")
      .all() as any[];
    expect(rows.length).toBe(2); // two models
    const opus = rows.find((r) => r.model === "claude-opus-4-8");
    const haiku = rows.find((r) => r.model === "claude-haiku-4-5");
    expect(opus.total_usd).toBeCloseTo(30, 6); // $5 + $25
    expect(haiku.total_usd).toBeCloseTo(1, 6);
    expect(JSON.parse(opus.burn_buckets).length).toBeGreaterThan(0);
  });

  test("byte-estimate fallback when adapter reports no usage (unpriced, not $0)", () => {
    const t = freshDb();
    dir = t.dir;
    const { db } = t;
    makeCostWriter(db, builtinCatalog(), "v1").writeForSession(stubAdapter([]), "sess2", "/x", 8000);

    const mtokN = (db.query("SELECT COUNT(*) n FROM message_tokens WHERE session_native_id='sess2'").get() as any).n;
    expect(mtokN).toBe(0);
    const row = db.query("SELECT * FROM session_cost WHERE session_native_id='sess2'").get() as any;
    expect(row.token_source).toBe("byte_estimate");
    expect(row.estimated_tokens).toBe(2000); // ceil(8000/4)
    expect(row.total_usd).toBeNull(); // unknown model → unpriced
  });

  test("re-index is idempotent (no duplicate rows on a second write)", () => {
    const t = freshDb();
    dir = t.dir;
    const { db } = t;
    const w = makeCostWriter(db, builtinCatalog(), "v1");
    const usage = [ur({ seq: 0, model: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 0 })];
    w.writeForSession(stubAdapter(usage), "sess3", "/x", 0);
    w.writeForSession(stubAdapter(usage), "sess3", "/x", 0);
    const mtokN = (db.query("SELECT COUNT(*) n FROM message_tokens WHERE session_native_id='sess3'").get() as any).n;
    const scostN = (db.query("SELECT COUNT(*) n FROM session_cost WHERE session_native_id='sess3'").get() as any).n;
    expect(mtokN).toBe(1);
    expect(scostN).toBe(1);
  });

  test("bucketize sums into <= n buckets", () => {
    expect(bucketize([1, 2, 3], 16)).toEqual([1, 2, 3]);
    const b = bucketize(Array.from({ length: 100 }, () => 1), 16);
    expect(b.length).toBe(16);
    expect(b.reduce((s, v) => s + v, 0)).toBe(100);
  });
});

describe("Phase 2 — adapter token extraction", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("claude readUsage: inclusive input = fresh + cache; offsets + seq increment", () => {
    dir = mkdtempSync(join(tmpdir(), "lb-px-"));
    const p = join(dir, "s.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ type: "user", message: { content: "hi" }, timestamp: "2026-06-01T00:00:00Z" }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T00:00:01Z",
          message: {
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "yo" }],
            usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 },
          },
        }),
      ].join("\n") + "\n",
    );
    const rows = claudeAdapter.readUsage!(p);
    expect(rows.length).toBe(1);
    expect(rows[0]!.inputTokens).toBe(150); // 100 + 20 + 30 (inclusive)
    expect(rows[0]!.outputTokens).toBe(50);
    expect(rows[0]!.cacheReadTokens).toBe(30);
    expect(rows[0]!.model).toBe("claude-opus-4-8");
    expect(rows[0]!.seq).toBe(0);
    expect(rows[0]!.offset).toBeGreaterThan(0); // second line, after the user line
  });

  test("codex readUsage: per-turn = delta of cumulative total; deltas sum to final", () => {
    dir = mkdtempSync(join(tmpdir(), "lb-px-"));
    const p = join(dir, "rollout-x.jsonl");
    const tc = (input: number, output: number, cached: number) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T00:00:00Z",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached } } },
      });
    writeFileSync(
      p,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "sx", model: "gpt-5-codex" } }),
        tc(1000, 100, 400), // turn 1: Δ in 1000, out 100, cached 400
        tc(3000, 250, 900), // turn 2: Δ in 2000, out 150, cached 500
      ].join("\n") + "\n",
    );
    const rows = codexAdapter.readUsage!(p);
    expect(rows.length).toBe(2);
    expect(rows[0]!.inputTokens).toBe(1000);
    expect(rows[1]!.inputTokens).toBe(2000);
    expect(rows[1]!.outputTokens).toBe(150);
    expect(rows[1]!.cacheReadTokens).toBe(500);
    expect(rows[0]!.model).toBe("gpt-5-codex");
    // telescoping: deltas sum to the final cumulative total
    const sumIn = rows.reduce((s, r) => s + r.inputTokens, 0);
    const sumOut = rows.reduce((s, r) => s + r.outputTokens, 0);
    expect(sumIn).toBe(3000);
    expect(sumOut).toBe(250);
  });
});

describe("Phase 1 — pricing", () => {
  const cat = builtinCatalog();

  test("exact pricing: 1M fresh input + 1M output on claude-opus-4-8", () => {
    // opus-4-8: input $5/M, output $25/M → $5 + $25 = $30
    const c = estimateCost({ modelKey: "claude-opus-4-8", promptTokens: 1_000_000, completionTokens: 1_000_000 }, cat);
    expect(c.totalUsd).toBeCloseTo(30, 6);
    expect(c.inputUsd).toBeCloseTo(5, 6);
    expect(c.outputUsd).toBeCloseTo(25, 6);
  });

  test("cache-exclusivity: prompt INCLUSIVE of cache, fresh input billed separately", () => {
    // prompt=1M inclusive; 600k cache_read, 0 creation → fresh=400k.
    // opus-4-8: fresh 400k×$5/M=$2.0 ; cacheRead 600k×$0.5/M=$0.3 → $2.3
    const c = estimateCost(
      { modelKey: "claude-opus-4-8", promptTokens: 1_000_000, completionTokens: 0, cacheReadInputTokens: 600_000 },
      cat,
    );
    expect(c.inputUsd).toBeCloseTo(2.0, 6);
    expect(c.cacheReadUsd).toBeCloseTo(0.3, 6);
    expect(c.totalUsd).toBeCloseTo(2.3, 6);
  });

  test("200k tiering applies when above-tier rates exist (synthetic catalog)", () => {
    const tiered = new Map(cat);
    tiered.set("tier-model", {
      provider: "x",
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 0,
      cacheCreationPerMillionUsd: null,
      cacheReadPerMillionUsd: null,
      inputAbove200kPerMillionUsd: 2,
      fastMultiplier: 1,
      pricingSource: "test",
    });
    // 300k input: 200k×$1/M + 100k×$2/M = $0.2 + $0.2 = $0.4
    const c = estimateCost({ modelKey: "tier-model", promptTokens: 300_000, completionTokens: 0 }, tiered);
    expect(c.inputUsd).toBeCloseTo(0.4, 6);
  });

  test("unknown model → null cost (never $0)", () => {
    const c = estimateCost({ modelKey: "totally-made-up", promptTokens: 1_000_000 }, cat);
    expect(c.totalUsd).toBeNull();
    expect(c.pricingSource).toBeNull();
  });

  test("family fallback: unseen opus point release prices off the family", () => {
    expect(pricingForModel("claude-opus-4-9-experimental", cat)).not.toBeNull();
    expect(pricingForModel("gpt-5.9-codex", cat)).not.toBeNull();
  });

  test("normalizeModelName: bare provider + synthetic → null", () => {
    expect(normalizeModelName("anthropic")).toBeNull();
    expect(normalizeModelName("<synthetic>")).toBeNull();
    expect(normalizeModelName("Claude-Opus-4-8")).toBe("claude-opus-4-8");
  });

  test("parseLiteLlm converts $/token → $/million", () => {
    const m = parseLiteLlm({ "demo-model": { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 } });
    const row = m.get("demo-model");
    expect(row?.inputPerMillionUsd).toBeCloseTo(2, 6);
    expect(row?.outputPerMillionUsd).toBeCloseTo(8, 6);
  });
});

describe("Phase 0 — schema", () => {
  let dir: string;
  afterEach(() => {
    closeDb();
    delete process.env.LB_HOME;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("message_tokens + session_cost tables exist with expected columns", () => {
    const t = freshDb();
    dir = t.dir;
    const { db } = t;

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("message_tokens");
    expect(tables).toContain("session_cost");

    const mtokCols = db
      .query("SELECT name FROM pragma_table_info('message_tokens')")
      .all()
      .map((r: any) => r.name);
    for (const c of ["session_native_id", "seq", "offset", "model", "input_tokens", "total_usd", "pricing_source"]) {
      expect(mtokCols).toContain(c);
    }

    const scostCols = db
      .query("SELECT name FROM pragma_table_info('session_cost')")
      .all()
      .map((r: any) => r.name);
    for (const c of ["session_native_id", "model", "total_usd", "burn_buckets", "catalog_version", "token_source"]) {
      expect(scostCols).toContain(c);
    }
  });
});
