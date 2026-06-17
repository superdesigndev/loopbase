import { test, expect, describe } from "bun:test";
import { buildNarrative, collectTurns, collapseTurns, buildMap } from "../src/commands/show.ts";
import type { Event } from "../src/adapters/types.ts";

describe("buildNarrative", () => {
  const events: Event[] = [
    { role: "user", text: "hello world this is long", ts: 1 },
    {
      role: "assistant",
      text: "ok",
      ts: 2,
      tools: [{ id: "toolu_AAAAAA111111", name: "Bash", inputSummary: "Bash: ls", input: { command: "ls" } }],
    },
    { role: "tool_result", text: "file1 file2", ts: 3, toolResultId: "toolu_AAAAAA111111" },
  ];

  test("default narrative: tool one-liners, text truncated", () => {
    const msgs = buildNarrative(events, "all", 5, false);
    expect(msgs[0].text).toBe("hello…");
    expect(msgs[1].tools[0]).toEqual({ id: "111111", summary: "Bash: ls" });
    // tool_result rows are not emitted as standalone messages
    expect(msgs.length).toBe(2);
  });

  test("--expand-tools inlines input + joined result", () => {
    const msgs = buildNarrative(events, "all", 100, true);
    const t = msgs[1].tools[0];
    expect(t.name).toBe("Bash");
    expect(t.input).toEqual({ command: "ls" });
    expect(t.result).toBe("file1 file2");
  });
});

describe("collectTurns", () => {
  test("turns carry mi (msg index), replies, tools; empty user lines aren't turns", () => {
    const evs: Event[] = [
      { role: "user", text: "first", ts: 1 },
      { role: "assistant", text: "a", ts: 2, tools: [{ id: "t1", name: "Bash" }] },
      { role: "user", text: "", ts: 3 }, // counted as a message, but not a turn
      { role: "user", text: "second", ts: 4 },
      { role: "assistant", text: "b", ts: 5 },
    ];
    const t = collectTurns(evs);
    expect(t.map((x) => x.text)).toEqual(["first", "second"]);
    expect(t[0]).toMatchObject({ turn: 0, mi: 0, replies: 1, tools: 1 });
    expect(t[1]).toMatchObject({ turn: 1, mi: 3, replies: 1, tools: 0 }); // mi=3: user,asst,emptyuser,user
  });
});

describe("collapseTurns", () => {
  test("merges consecutive identical text; keeps last ordinal + repeats + summed counts", () => {
    const raw = [
      { turn: 0, mi: 0, text: "dup", replies: 0, tools: 0 },
      { turn: 1, mi: 1, text: "dup", replies: 10, tools: 3 },
      { turn: 2, mi: 2, text: "other", replies: 1, tools: 0 },
    ];
    const c = collapseTurns(raw as any);
    expect(c.length).toBe(2);
    expect(c[0]).toMatchObject({ turn: 1, repeats: 2, then: { replies: 10, tool_calls: 3 } });
    expect(c[1]).toMatchObject({ turn: 2, then: { replies: 1, tool_calls: 0 } });
  });
});

describe("buildMap", () => {
  const evs: Event[] = [
    { role: "user", text: "q1", ts: 1 }, { role: "assistant", text: "a", ts: 2 },
    { role: "user", text: "q2", ts: 3 }, { role: "assistant", text: "b", ts: 4 },
  ];
  const inv = { flags: {} } as any;

  test("flat map when no worklog (inferred from `turns`, no view/logged fields)", () => {
    const m: any = buildMap("s1", evs, [], inv);
    expect(m.view).toBeUndefined();
    expect(m.logged).toBeUndefined();
    expect(m.worklog).toBeUndefined();
    expect(m.turns.map((x: any) => x.text)).toEqual(["q1", "q2"]);
  });

  test("grouped by byte-offset containment; span wraps the turns inside it, rest is unlogged", () => {
    // turn 0 at byte 0, turn 1 at byte 100; span [0,50) contains only turn 0.
    const wl = [{ id: "lg_x", text: "did q1", from_offset: 0, to_offset: 50 }] as any;
    const m: any = buildMap("s1", evs, wl, inv, [0, 100]);
    expect(m.turns).toBeUndefined(); // grouped shape uses worklog/unlogged
    expect(m.worklog[0].id).toBe("lg_x");
    expect(m.worklog[0].turns.map((x: any) => x.turn)).toEqual([0]);
    expect(m.unlogged.map((x: any) => x.turn)).toEqual([1]);
  });

  test("a retro span in the middle groups only its turns (non-contiguous ok)", () => {
    // span covers only turn 1 (byte 100), not turn 0 (byte 0) → turn 0 is unlogged.
    const wl = [{ id: "lg_mid", text: "tagged q2", from_offset: 90, to_offset: 200 }] as any;
    const m: any = buildMap("s1", evs, wl, inv, [0, 100]);
    expect(m.worklog[0].turns.map((x: any) => x.turn)).toEqual([1]);
    expect(m.unlogged.map((x: any) => x.turn)).toEqual([0]);
  });

  test("zero `then` is omitted entirely", () => {
    const evs2: Event[] = [{ role: "user", text: "lonely q", ts: 1 }]; // no replies → then omitted
    const m: any = buildMap("s1", evs2, [], inv);
    expect(m.turns[0].then).toBeUndefined();
  });
});
