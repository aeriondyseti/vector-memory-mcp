/**
 * Time ranges named in natural language ("last week", "two months ago",
 * "in March", "March 15th", "this year"), resolved against a clock.
 *
 * Used to focus search on a period without filtering: memories from the
 * range get a vote in the ranking (the temporal lane), the rest still
 * compete. Deliberately conservative — only clear expressions resolve; a
 * wrong range would push the right memory down, so ambiguity resolves to
 * nothing.
 */

export interface TimeRange {
  start: Date;
  end: Date;
}

const DAY = 86_400_000;
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3,
};
const COUNT = `(\\d+|${Object.keys(NUMBER_WORDS).join("|")})`;
const MONTH = `(${MONTHS.join("|")}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)`;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
/** `n` months from `d`, the day clamped to the target month's length (May 31 − 1 month = April 30). */
const addMonths = (d: Date, n: number) => {
  const lastDay = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), lastDay), d.getHours(), d.getMinutes());
};
const count = (s: string) => NUMBER_WORDS[s.toLowerCase()] ?? parseInt(s, 10);
const monthIndex = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3)));

/** The latest occurrence, not after `now`, of `month` (0-11) in `year` if given. */
function monthRange(month: number, now: Date, year?: number): TimeRange {
  const y = year ?? (month <= now.getMonth() ? now.getFullYear() : now.getFullYear() - 1);
  return { start: new Date(y, month, 1), end: new Date(y, month + 1, 1) };
}

type Rule = [RegExp, (m: RegExpMatchArray, now: Date) => TimeRange | null];

const RULES: Rule[] = [
  // ISO-like dates: 2023-05-01, 2023/05/01
  [/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/, (m) => {
    const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!);
    return { start: d, end: addDays(d, 1) };
  }],
  // "March 15th", "March 15, 2023", "15 March"
  [new RegExp(`\\b${MONTH}\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?\\b`, "i"), (m, now) => {
    const month = monthIndex(m[1]!);
    const { start } = monthRange(month, now, m[3] ? +m[3] : undefined);
    const d = new Date(start.getFullYear(), month, +m[2]!);
    return { start: addDays(d, -1), end: addDays(d, 2) };
  }],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH}\\b`, "i"), (m, now) => {
    const month = monthIndex(m[2]!);
    const { start } = monthRange(month, now);
    const d = new Date(start.getFullYear(), month, +m[1]!);
    return { start: addDays(d, -1), end: addDays(d, 2) };
  }],
  // "in March", "during February 2023", "the month of June"
  [new RegExp(`\\b(?:in|during|throughout|month of|since|back in) ${MONTH}(?: (\\d{4}))?\\b`, "i"), (m, now) =>
    monthRange(monthIndex(m[1]!), now, m[2] ? +m[2] : undefined)],
  [/\byesterday\b/i, (_m, now) => {
    const today = startOfDay(now);
    return { start: addDays(today, -1), end: today };
  }],
  [/\btoday\b(?!'s date)/i, (_m, now) => ({ start: startOfDay(now), end: now })],
  [/\blast weekend\b/i, (_m, now) => {
    const today = startOfDay(now);
    const sinceSaturday = (today.getDay() + 1) % 7 || 7;
    const saturday = addDays(today, -sinceSaturday);
    return { start: saturday, end: addDays(saturday, 2) };
  }],
  // "two weeks ago", "a month ago", "3 days ago" — a window around that point
  [new RegExp(`\\b${COUNT} (day|week|month|year)s? ago\\b`, "i"), (m, now) => {
    const n = count(m[1]!);
    const unit = m[2]!.toLowerCase();
    if (unit === "day") return { start: startOfDay(addDays(now, -n - 1)), end: startOfDay(addDays(now, -n + 2)) };
    if (unit === "week") return { start: addDays(now, -7 * n - 4), end: addDays(now, -7 * n + 4) };
    if (unit === "month") return { start: addDays(addMonths(now, -n), -15), end: addDays(addMonths(now, -n), 15) };
    return { start: addMonths(now, -12 * n - 6), end: addMonths(now, -12 * n + 6) };
  }],
  [/\blast year\b/i, (_m, now) => ({ start: new Date(now.getFullYear() - 1, 0, 1), end: new Date(now.getFullYear(), 0, 1) })],
  // "past 3 weeks", "last two months", "the past month", "last week"
  [new RegExp(`\\b(past|last|previous) (?:${COUNT} )?(day|week|month|year)s?\\b`, "i"), (m, now) => {
    const unit = m[3]!.toLowerCase();
    // A count, or "past", means that much time up to now; a bare "last week" /
    // "last month" also reaches back through the whole previous week / month.
    const n = m[2] ? count(m[2]) : m[1]!.toLowerCase() === "past" ? 1 : 2;
    const today = startOfDay(now);
    if (unit === "day") return { start: addDays(today, -n), end: now };
    if (unit === "week") return { start: addDays(today, -7 * n), end: now };
    if (unit === "month") return { start: addMonths(today, -n), end: now };
    return { start: addMonths(today, -12 * n), end: now };
  }],
  [/\bthis (week|month|year)\b/i, (m, now) => {
    const unit = m[1]!.toLowerCase();
    if (unit === "week") return { start: addDays(startOfDay(now), -7), end: now };
    if (unit === "month") return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
    return { start: new Date(now.getFullYear(), 0, 1), end: now };
  }],
  // "in 2023"
  [/\b(?:in|during|since) (\d{4})\b/, (m) => ({ start: new Date(+m[1]!, 0, 1), end: new Date(+m[1]! + 1, 0, 1) })],
];

/** The first clear time expression in `text`, as a range relative to `now`; null if none. */
export function findTimeRange(text: string, now: Date = new Date()): TimeRange | null {
  for (const [pattern, resolve] of RULES) {
    const m = text.match(pattern);
    if (!m) continue;
    const range = resolve(m, now);
    if (range && !isNaN(range.start.getTime()) && !isNaN(range.end.getTime()) && range.start < range.end) {
      return range;
    }
  }
  return null;
}

/**
 * An explicit time focus: "YYYY-MM-DD..YYYY-MM-DD" (either side may be
 * empty: open-ended), a single date, or any expression findTimeRange reads.
 */
export function parseTimeFocus(value: string, now: Date = new Date()): TimeRange | null {
  const span = value.match(/^\s*(\S*)\s*\.\.\s*(\S*)\s*$/);
  if (span) {
    const start = span[1] ? new Date(span[1]) : new Date(0);
    const end = span[2] ? new Date(span[2]) : now;
    return isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end ? null : { start, end };
  }
  return findTimeRange(value, now);
}
