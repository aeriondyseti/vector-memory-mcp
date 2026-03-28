const PATTERN =
  /^(?:past|last)\s+(\d+)\s+(minute|hour|day|week|month|year)s?$/i;

export function parseTimeExpr(
  expr: string,
  now: Date = new Date(),
): Date | null {
  const match = expr.trim().match(PATTERN);
  if (!match) return null;

  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const result = new Date(now);

  switch (unit) {
    case "minute":
      result.setMinutes(result.getMinutes() - n);
      break;
    case "hour":
      result.setHours(result.getHours() - n);
      break;
    case "day":
      result.setDate(result.getDate() - n);
      break;
    case "week":
      result.setDate(result.getDate() - n * 7);
      break;
    case "month":
      result.setMonth(result.getMonth() - n);
      break;
    case "year":
      result.setFullYear(result.getFullYear() - n);
      break;
  }

  return result;
}

export interface DateFilters {
  after?: Date;
  before?: Date;
}

export function resolveDateFilters(raw: {
  after?: unknown;
  before?: unknown;
  time_expr?: unknown;
}): DateFilters {
  let after: Date | undefined;
  let before: Date | undefined;

  if (raw.after !== undefined) {
    after = new Date(raw.after as string);
    if (isNaN(after.getTime())) throw new Error("'after' is not a valid date");
  }
  if (raw.before !== undefined) {
    before = new Date(raw.before as string);
    if (isNaN(before.getTime())) throw new Error("'before' is not a valid date");
  }

  if (!after && typeof raw.time_expr === "string") {
    const resolved = parseTimeExpr(raw.time_expr);
    if (!resolved) {
      throw new Error(
        `Unsupported time_expr format: "${raw.time_expr}". ` +
        `Use "past N unit" or "last N unit" (e.g. "past 7 days", "last 2 weeks").`,
      );
    }
    after = resolved;
  }

  if (after && before && after >= before) {
    throw new Error("'after' date must be before 'before' date");
  }

  return { after, before };
}
