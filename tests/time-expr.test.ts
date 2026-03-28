import { describe, test, expect } from "bun:test";
import { parseTimeExpr, resolveDateFilters } from "../server/core/time-expr";

describe("parseTimeExpr", () => {
  const now = new Date("2026-03-27T12:00:00Z");

  test("parses 'past N days'", () => {
    const result = parseTimeExpr("past 7 days", now);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-03-20T12:00:00.000Z");
  });

  test("parses 'last N weeks'", () => {
    const result = parseTimeExpr("last 2 weeks", now);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-03-13T12:00:00.000Z");
  });

  test("parses 'past N hours'", () => {
    const result = parseTimeExpr("past 3 hours", now);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-03-27T09:00:00.000Z");
  });

  test("parses 'last N minutes'", () => {
    const result = parseTimeExpr("last 30 minutes", now);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-03-27T11:30:00.000Z");
  });

  test("parses 'past 1 month'", () => {
    const result = parseTimeExpr("past 1 month", now);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-02-27T12:00:00.000Z");
  });

  test("parses 'last 1 year'", () => {
    const result = parseTimeExpr("last 1 year", now);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2025-03-27T12:00:00.000Z");
  });

  test("is case-insensitive", () => {
    const result = parseTimeExpr("PAST 7 DAYS", now);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-03-20T12:00:00.000Z");
  });

  test("handles singular units", () => {
    const result = parseTimeExpr("past 1 day", now);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-03-26T12:00:00.000Z");
  });

  test("trims whitespace", () => {
    const result = parseTimeExpr("  past 7 days  ", now);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-03-20T12:00:00.000Z");
  });

  test("returns null for invalid format", () => {
    expect(parseTimeExpr("7 days ago", now)).toBeNull();
    expect(parseTimeExpr("since last week", now)).toBeNull();
    expect(parseTimeExpr("", now)).toBeNull();
    expect(parseTimeExpr("past days", now)).toBeNull();
    expect(parseTimeExpr("past -1 days", now)).toBeNull();
  });

  test("uses current time when now is omitted", () => {
    const before = Date.now();
    const result = parseTimeExpr("past 1 day");
    const after = Date.now();
    expect(result).not.toBeNull();
    // Should be approximately 24 hours ago
    const ms = result!.getTime();
    expect(ms).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000 - 100);
    expect(ms).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000 + 100);
  });
});

describe("resolveDateFilters", () => {
  test("returns empty filters when no inputs", () => {
    const result = resolveDateFilters({});
    expect(result.after).toBeUndefined();
    expect(result.before).toBeUndefined();
  });

  test("parses after and before ISO dates", () => {
    const result = resolveDateFilters({ after: "2025-06-01", before: "2026-01-01" });
    expect(result.after).toEqual(new Date("2025-06-01"));
    expect(result.before).toEqual(new Date("2026-01-01"));
  });

  test("resolves time_expr to after", () => {
    const before = Date.now();
    const result = resolveDateFilters({ time_expr: "past 7 days" });
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(result.after).toBeInstanceOf(Date);
    expect(result.after!.getTime()).toBeGreaterThanOrEqual(before - sevenDaysMs - 100);
  });

  test("explicit after takes precedence over time_expr", () => {
    const result = resolveDateFilters({ after: "2025-06-01", time_expr: "past 7 days" });
    expect(result.after).toEqual(new Date("2025-06-01"));
  });

  test("throws on invalid after date", () => {
    expect(() => resolveDateFilters({ after: "not-a-date" })).toThrow("not a valid date");
  });

  test("throws on invalid time_expr", () => {
    expect(() => resolveDateFilters({ time_expr: "7 days ago" })).toThrow("Unsupported time_expr");
  });

  test("throws when after >= before", () => {
    expect(() => resolveDateFilters({ after: "2026-01-01", before: "2025-06-01" })).toThrow("must be before");
  });
});
