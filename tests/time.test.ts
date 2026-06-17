import { test, expect, describe } from "bun:test";
import { parseDuration, relativeTime } from "../src/time.ts";

describe("parseDuration", () => {
  test("units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
  });
  test("rejects garbage", () => {
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("10")).toBeNull();
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  test("buckets", () => {
    expect(relativeTime(now, now)).toBe("0s ago");
    expect(relativeTime(now - 5_000, now)).toBe("5s ago");
    expect(relativeTime(now - 120_000, now)).toBe("2m ago");
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(relativeTime(null, now)).toBe("?");
  });
});
