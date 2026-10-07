import { describe, expect, test } from "bun:test";
import { findTimeRange, parseTimeFocus } from "../server/core/time-range";

// Wednesday 2023-05-31, 14:00 local time.
const NOW = new Date(2023, 4, 31, 14, 0);
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const range = (text: string) => {
  const r = findTimeRange(text, NOW);
  return r && { start: r.start.getTime(), end: r.end.getTime() };
};

describe("findTimeRange", () => {
  test("finds nothing in a question without a time expression", () => {
    expect(range("Who leads the Scarlet Covenant?")).toBeNull();
    expect(range("What is my favourite weekend activity?")).toBeNull();
  });

  test("yesterday and today", () => {
    expect(range("What did I cook yesterday?")).toEqual({ start: day(2023, 5, 30), end: day(2023, 5, 31) });
    expect(range("anything new today")?.start).toBe(day(2023, 5, 31));
  });

  test("N units ago is a window around that point", () => {
    const r = range("Which book did I finish a week ago?")!;
    expect(r.start).toBeLessThan(day(2023, 5, 24));
    expect(r.end).toBeGreaterThan(day(2023, 5, 24));
    expect(r.end).toBeLessThan(day(2023, 5, 29));

    const twoDays = range("the restaurant from 2 days ago")!;
    expect(twoDays).toEqual({ start: day(2023, 5, 28), end: day(2023, 5, 31) });
  });

  test("past and last periods reach back from now", () => {
    expect(range("plants I acquired in the past month")?.start).toBe(day(2023, 4, 30));
    expect(range("How many hours did I jog last week?")?.start).toBe(day(2023, 5, 17));
    expect(range("over the past 3 days")?.start).toBe(day(2023, 5, 28));
    expect(range("last year's trip")).toEqual({ start: day(2022, 1, 1), end: day(2023, 1, 1) });
    expect(range("weddings this year")?.start).toBe(day(2023, 1, 1));
  });

  test("a named month is its latest occurrence; a named day a window around it", () => {
    expect(range("events I watched in January")).toEqual({ start: day(2023, 1, 1), end: day(2023, 2, 1) });
    expect(range("museums I visited during August")).toEqual({ start: day(2022, 8, 1), end: day(2022, 9, 1) });
    expect(range("the March 15th issue")).toEqual({ start: day(2023, 3, 14), end: day(2023, 3, 17) });
    expect(range("on 2023-02-10")).toEqual({ start: day(2023, 2, 10), end: day(2023, 2, 11) });
  });
});

describe("parseTimeFocus", () => {
  test("reads explicit ranges, open on either side", () => {
    expect(parseTimeFocus("2023-01-01..2023-02-01", NOW)).toEqual({
      start: new Date("2023-01-01"),
      end: new Date("2023-02-01"),
    });
    expect(parseTimeFocus("2023-05-01..", NOW)?.end).toEqual(NOW);
    expect(parseTimeFocus("..2023-01-01", NOW)?.start).toEqual(new Date(0));
  });

  test("falls back to expressions, and rejects nonsense", () => {
    expect(parseTimeFocus("last week", NOW)?.start.getTime()).toBe(day(2023, 5, 17));
    expect(parseTimeFocus("whenever", NOW)).toBeNull();
    expect(parseTimeFocus("2023-05-01..2023-01-01", NOW)).toBeNull();
  });
});
