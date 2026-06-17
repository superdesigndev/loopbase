import { test, expect, describe } from "bun:test";
import { parse } from "../src/parse.ts";
import { lintSpec } from "../src/spec.ts";
import { CliError, EXIT } from "../src/output.ts";

describe("naming lint", () => {
  test("spec passes the vocabulary lint", () => {
    expect(lintSpec()).toEqual([]);
  });
});

describe("parse", () => {
  test("no args → top help", () => {
    expect(parse([]).kind).toBe("help-top");
  });

  test("command --help → command help", () => {
    const r = parse(["list", "--help"]);
    expect(r.kind).toBe("help-command");
    expect(r.command?.name).toBe("list");
  });

  test("defaults to JSON mode", () => {
    const r = parse(["list"]);
    expect(r.invocation?.mode.json).toBe(true);
  });

  test("--text flips to human mode", () => {
    const r = parse(["list", "--text"]);
    expect(r.invocation?.mode.json).toBe(false);
  });

  test("positional arg is captured", () => {
    const r = parse(["show", "abc123"]);
    expect(r.invocation?.args.session_id).toBe("abc123");
  });

  test("int flag coerced", () => {
    const r = parse(["list", "--limit", "5"]);
    expect(r.invocation?.flags.limit).toBe(5);
  });

  test("--flag=value form", () => {
    const r = parse(["list", "--limit=7"]);
    expect(r.invocation?.flags.limit).toBe(7);
  });

  function code(fn: () => unknown): number | undefined {
    try {
      fn();
    } catch (e) {
      return e instanceof CliError ? e.code : -1;
    }
    return undefined;
  }

  test("unknown command → USAGE(2)", () => {
    expect(code(() => parse(["frob"]))).toBe(EXIT.USAGE);
  });

  test("bad enum → INVALID_VALUE(4)", () => {
    expect(code(() => parse(["list", "--agent", "gpt"]))).toBe(EXIT.INVALID_VALUE);
  });

  test("unknown flag → USAGE(2)", () => {
    expect(code(() => parse(["list", "--nope"]))).toBe(EXIT.USAGE);
  });

  test("missing required arg → USAGE(2)", () => {
    expect(code(() => parse(["show"]))).toBe(EXIT.USAGE);
  });
});

describe("self-healing errors (Principle 3)", () => {
  function payload(fn: () => unknown): any {
    try {
      fn();
    } catch (e) {
      return e instanceof CliError ? e.payload : null;
    }
    return null;
  }

  test("unknown command names the valid set + a next step", () => {
    const p = payload(() => parse(["frob"]));
    expect(p.valid).toContain("list");
    expect(p.hint).toBeTruthy();
  });

  test("unknown flag enumerates valid flags + shows usage", () => {
    const p = payload(() => parse(["list", "--frob"]));
    expect(p.valid).toContain("--limit");
    expect(p.usage).toMatch(/list/);
  });

  test("missing required arg shows a working invocation", () => {
    const p = payload(() => parse(["show"]));
    expect(p.usage).toMatch(/show <session_id>/);
  });

  test("bad enum names the valid values", () => {
    const p = payload(() => parse(["list", "--agent", "gpt"]));
    expect(p.valid).toEqual(["claude", "codex", "pi"]);
  });
});
