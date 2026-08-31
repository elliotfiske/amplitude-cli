/**
 * Date-range helpers.
 *
 * The typed `chart` parameter on query_amplitude_data takes a date_range of
 * either { relative } or { start, end } in epoch SECONDS — not the date strings
 * the older raw-definition API accepted. These helpers do that conversion and
 * keep the CLI's --from/--to/--range flags in one place.
 */

export interface DateRange {
  relative?: string;
  start?: number;
  end?: number;
  timezone?: string;
}

/**
 * Parse a YYYY-MM-DD date into epoch seconds at UTC midnight.
 * Also accepts a full ISO 8601 timestamp, or a bare epoch-seconds number.
 */
export function toEpochSeconds(input: string, endOfDay = false): number {
  const trimmed = input.trim();

  // Bare epoch seconds.
  if (/^\d{9,11}$/.test(trimmed)) return parseInt(trimmed, 10);

  // YYYY-MM-DD → pin to UTC so results don't shift with the runner's timezone.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const ms = Date.UTC(
      Number(y),
      Number(m) - 1,
      Number(d),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0
    );
    return Math.floor(ms / 1000);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid date: "${input}". Use YYYY-MM-DD, an ISO 8601 timestamp, or epoch seconds.`
    );
  }
  return Math.floor(parsed / 1000);
}

/**
 * Build a date_range from the CLI's mutually exclusive range flags.
 *
 * --range takes precedence and maps to Amplitude's relative windows
 * ("Last 30 Days"). Otherwise --from is required and --to is optional; omitting
 * --to yields an open-ended "since <from>" window, which the server supports.
 */
export function buildDateRange(opts: {
  range?: string;
  from?: string;
  to?: string;
  timezone?: string;
}): DateRange {
  const tz = opts.timezone ? { timezone: opts.timezone } : {};

  if (opts.range) {
    if (opts.from || opts.to) {
      throw new Error("--range cannot be combined with --from/--to. Use one or the other.");
    }
    return { relative: opts.range, ...tz };
  }

  if (!opts.from) {
    throw new Error(
      "A time window is required: pass --from <YYYY-MM-DD> (optionally --to), or --range \"Last 30 Days\"."
    );
  }

  const start = toEpochSeconds(opts.from);
  if (!opts.to) return { start, ...tz };

  // --to is inclusive of that whole day, matching how the dates read to a human.
  const end = toEpochSeconds(opts.to, true);
  if (end < start) {
    throw new Error(`--to (${opts.to}) is before --from (${opts.from}).`);
  }
  return { start, end, ...tz };
}

/**
 * Map the CLI's -i/--interval flag to the typed model's interval string.
 * Accepts both the legacy numeric form (1/7/30) and plain names.
 */
export function parseInterval(interval?: string): string | undefined {
  if (!interval) return undefined;
  const key = interval.trim().toLowerCase();
  const numeric: Record<string, string> = {
    "1": "day",
    "7": "week",
    "30": "month",
    "-300000": "hour",
  };
  if (numeric[key]) return numeric[key];
  if (["hour", "day", "week", "month", "quarter"].includes(key)) return key;
  throw new Error(
    `Invalid --interval "${interval}". Use hour, day, week, month, quarter (or 1, 7, 30).`
  );
}

/**
 * Parse a group-by flag into the typed model's shape.
 *
 * Accepts "platform", "user:platform", or "event:page_name". The scope prefix
 * maps to the typed model's `scope` field; it defaults to "event" the way the
 * server does when the prefix is omitted.
 */
export function parseGroupBy(groupBy: string): Array<Record<string, string>> {
  return groupBy
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(":");
      if (idx === -1) return { property: entry, scope: "event" };
      const scope = entry.slice(0, idx).trim();
      const property = entry.slice(idx + 1).trim();
      if (!property) {
        throw new Error(`Invalid --group-by entry "${entry}": missing property name.`);
      }
      return { property, scope };
    });
}
