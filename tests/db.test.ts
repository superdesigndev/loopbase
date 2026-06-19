import { test, expect, describe } from "bun:test";
import { withBusyRetry, isBusyError } from "../src/db.ts";

describe("withBusyRetry — daemonless write contention safety net", () => {
  test("isBusyError matches SQLITE_BUSY phrasings, not unrelated errors", () => {
    expect(isBusyError(new Error("database is locked"))).toBe(true);
    expect(isBusyError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(isBusyError(new Error("no such column: foo"))).toBe(false);
  });

  test("returns immediately on success (no retries)", () => {
    let calls = 0;
    const r = withBusyRetry(() => { calls++; return 42; });
    expect(r).toBe(42);
    expect(calls).toBe(1);
  });

  test("retries past a transient lock, then succeeds", () => {
    let calls = 0;
    const r = withBusyRetry(() => {
      calls++;
      if (calls < 3) throw new Error("database is locked");
      return "ok";
    });
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });

  test("rethrows a non-lock error without retrying", () => {
    let calls = 0;
    expect(() => withBusyRetry(() => { calls++; throw new Error("syntax error"); })).toThrow("syntax error");
    expect(calls).toBe(1);
  });

  test("gives up after the attempt budget on a persistent lock", () => {
    let calls = 0;
    expect(() => withBusyRetry(() => { calls++; throw new Error("database is locked"); }, 3)).toThrow("database is locked");
    expect(calls).toBe(3);
  });
});
