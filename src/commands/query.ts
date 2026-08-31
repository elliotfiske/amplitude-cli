/**
 * Query commands — event segmentation, funnels, retention, revenue, sessions.
 *
 * These build the typed `chart` parameter of query_amplitude_data, which is the
 * path Amplitude prefers: it validates server-side and returns both the data and
 * a chartEditId. Revenue is the exception — there is no typed `revenue` variant,
 * so it goes through the raw `definition` fallback with type "revenueLtv".
 */

import { Command } from "commander";
import { AmplitudeMcpClient } from "../mcp-client.js";
import { output, type OutputFormat } from "../utils/format.js";
import { extractMcpText } from "../utils/mcp-helpers.js";
import { handleError } from "../utils/errors.js";
import { buildDateRange, parseGroupBy, parseInterval } from "../utils/dates.js";

/** Measured-as aliases, so the old -m values keep working. */
const SEGMENT_METRICS: Record<string, string> = {
  uniques: "unique_users",
  unique_users: "unique_users",
  totals: "event_totals",
  event_totals: "event_totals",
  avg: "avg_per_user",
  avg_per_user: "avg_per_user",
  pctdau: "active_pct",
  active_pct: "active_pct",
  frequency: "frequency",
  formula: "formula",
  property_sum: "property_sum",
  property_avg: "property_avg",
  property_min: "property_min",
  property_max: "property_max",
  property_median: "property_median",
  property_count: "property_count",
  histogram: "histogram",
};

const REVENUE_METRICS: Record<string, string> = {
  total: "total",
  "total-revenue": "total",
  ltv: "total",
  arpu: "arpu",
  "avg-revenue": "arpu",
  arppu: "arppu",
  paying: "paying",
  "new-paying-users": "paying",
};

function resolveSegmentMetric(metric?: string): string {
  if (!metric) return "unique_users";
  const resolved = SEGMENT_METRICS[metric.trim().toLowerCase()];
  if (!resolved) {
    throw new Error(
      `Invalid --metric "${metric}". Valid: ${Object.keys(SEGMENT_METRICS).join(", ")}.`
    );
  }
  return resolved;
}

/** Shared flags for every query subcommand. */
function withCommonOptions(cmd: Command): Command {
  return cmd
    .option("--from <date>", "Start date (YYYY-MM-DD, ISO 8601, or epoch seconds)")
    .option("--to <date>", "End date (inclusive). Omit for an open-ended 'since --from' window")
    .option("-r, --range <window>", 'Relative window instead of --from/--to, e.g. "Last 30 Days"')
    .option("--timezone <tz>", "IANA timezone for the window, e.g. America/Los_Angeles")
    .option("-i, --interval <interval>", "hour, day, week, month, quarter (or 1, 7, 30)")
    .option("-g, --group-by <props>", "Group by, comma-separated. Format: prop or scope:prop")
    .option("--vis <type>", "Visualization: line, area, bar, column, stackedbar, pie, kpi")
    .option("--name <name>", "Chart name recorded with the query")
    .option("--group-by-limit <n>", "Max group-by values to return (1-1000)")
    .option("--time-series-limit <n>", "Max group-by values with per-interval rows (0 = totals only)")
    .option("--exclude-incomplete", "Drop the current, still-incomplete interval")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json");
}

/** Translate the shared flags into query_amplitude_data's non-chart options. */
function queryOptions(opts: Record<string, any>) {
  return {
    ...(opts.groupByLimit !== undefined && { groupByLimit: parseInt(opts.groupByLimit, 10) }),
    ...(opts.timeSeriesLimit !== undefined && {
      timeSeriesLimit: parseInt(opts.timeSeriesLimit, 10),
    }),
    ...(opts.excludeIncomplete && { excludeIncompleteDatapoints: true }),
  };
}

/** Fields shared by every typed chart kind. */
function sharedChartFields(opts: Record<string, any>) {
  const interval = parseInterval(opts.interval);
  const groupBy = opts.groupBy ? parseGroupBy(opts.groupBy) : undefined;
  return {
    date_range: buildDateRange(opts),
    ...(interval && { interval }),
    ...(groupBy && { group_by: groupBy }),
    ...(opts.vis && { vis: opts.vis }),
    ...(opts.name && { name: opts.name }),
  };
}

export function registerQueryCommands(program: Command): void {
  const query = program.command("query").description("Run analytics queries");

  // --- Event Segmentation ---
  withCommonOptions(
    query
      .command("segment")
      .description("Event segmentation — count events/users over time")
      .requiredOption("-e, --event <type...>", "Event type(s) (_active, _all, or custom)")
      .option("-m, --metric <metric>", "Measured as: uniques, totals, avg, pctdau, …", "uniques")
      .option("--formula <expr>", 'Formula when --metric formula, e.g. "UNIQUES(A)/TOTALS(B)"')
  ).action(async (opts) => {
    try {
      const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
      const measuredAs = resolveSegmentMetric(opts.metric);
      const chart = {
        kind: "segmentation",
        events: (opts.event as string[]).map((event) => ({ event })),
        measured_as: {
          as: measuredAs,
          ...(opts.formula && { formula: opts.formula }),
        },
        ...sharedChartFields(opts),
      };
      const result = await mcp.queryChart(chart, queryOptions(opts));
      output(extractMcpText(result), opts.format as OutputFormat);
    } catch (err) {
      handleError(err);
    }
  });

  // --- Funnel Analysis ---
  withCommonOptions(
    query
      .command("funnel")
      .description("Funnel analysis — conversion through an event sequence")
      .requiredOption("-e, --events <types...>", "Events in funnel order (space-separated)")
      .option("-w, --window <n>", "Conversion window length", "7")
      .option("-u, --window-unit <unit>", "Window unit: second, minute, hour, day, week", "day")
      .option("--mode <mode>", "Step order: ordered, unordered, sequential", "ordered")
  ).action(async (opts) => {
    try {
      const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
      const chart = {
        kind: "funnel",
        steps: (opts.events as string[]).map((event) => ({ event })),
        conversion_window: {
          value: parseInt(opts.window, 10),
          unit: opts.windowUnit,
        },
        ...(opts.mode && { mode: opts.mode }),
        ...sharedChartFields(opts),
      };
      const result = await mcp.queryChart(chart, queryOptions(opts));
      output(extractMcpText(result), opts.format as OutputFormat);
    } catch (err) {
      handleError(err);
    }
  });

  // --- Retention Analysis ---
  withCommonOptions(
    query
      .command("retention")
      .description("Retention analysis — how users return over time")
      .requiredOption("--start-event <type>", "Cohort-entry event (_new for new users)")
      .requiredOption("--return-event <type...>", "Return event(s), OR-combined (_active for any)")
      .option("--method <method>", "rolling, nday, bracket, nday_or_before", "rolling")
      .option("--measured-as <mode>", "retention or usage_interval", "retention")
  ).action(async (opts) => {
    try {
      const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
      const chart = {
        kind: "retention",
        start_event: { event: opts.startEvent },
        return_events: (opts.returnEvent as string[]).map((event) => ({ event })),
        ...(opts.method && { retention_method: opts.method }),
        ...(opts.measuredAs && { measured_as: opts.measuredAs }),
        ...sharedChartFields(opts),
      };
      const result = await mcp.queryChart(chart, queryOptions(opts));
      output(extractMcpText(result), opts.format as OutputFormat);
    } catch (err) {
      handleError(err);
    }
  });

  // --- Sessions ---
  withCommonOptions(
    query
      .command("sessions")
      .description("Session analytics")
      .option(
        "-m, --metric <metric>",
        "totalSessions, average, length, peruser, totalTime, averageTimePerUser, " +
          "averageEventsPerSession, totalEvents, eventCountDistribution",
        "totalSessions"
      )
  ).action(async (opts) => {
    try {
      const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
      // sessions takes measured_as as a bare string, unlike segmentation's object.
      const chart = {
        kind: "sessions",
        measured_as: opts.metric,
        ...sharedChartFields(opts),
      };
      const result = await mcp.queryChart(chart, queryOptions(opts));
      output(extractMcpText(result), opts.format as OutputFormat);
    } catch (err) {
      handleError(err);
    }
  });

  // --- Revenue ---
  // No typed `revenue` kind exists, so this uses the raw definition fallback.
  withCommonOptions(
    query
      .command("revenue")
      .description("Revenue LTV — cumulative revenue from users new in the window")
      .option("-m, --metric <type>", "total, arpu, arppu, paying", "total")
      .option("-e, --event <type>", "Revenue event", "_any_revenue_event")
      .option("--revenue-property <prop>", "Property holding the amount", "$revenue")
  ).action(async (opts) => {
    try {
      const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
      const metric = REVENUE_METRICS[String(opts.metric).trim().toLowerCase()];
      if (!metric) {
        throw new Error(
          `Invalid --metric "${opts.metric}". Valid: ${Object.keys(REVENUE_METRICS).join(", ")}.`
        );
      }

      const range = buildDateRange(opts);
      const interval = parseInterval(opts.interval);
      // The raw definition uses the legacy range/start/end params, not date_range.
      const rangeParams = range.relative
        ? { range: range.relative }
        : { start: range.start, ...(range.end !== undefined && { end: range.end }) };

      const definition = {
        type: "revenueLtv",
        name: opts.name || "Revenue LTV",
        ...(opts.vis && { vis: opts.vis }),
        params: {
          ...rangeParams,
          metric,
          event: { event_type: opts.event, filters: [], group_by: [] },
          revenueProperty: opts.revenueProperty,
          groupBy: opts.groupBy
            ? parseGroupBy(opts.groupBy).map((g) => ({
                type: g.scope,
                value: g.property,
                group_type: "User",
              }))
            : [],
          countGroup: "User",
          ...(interval && { interval: opts.interval }),
          segments: [{ conditions: [] }],
        },
      };

      const result = await mcp.queryDefinition(definition, queryOptions(opts));
      output(extractMcpText(result), opts.format as OutputFormat);
    } catch (err) {
      handleError(err);
    }
  });

  // --- Saved chart data ---
  query
    .command("chart <chart-id...>")
    .description("Get data from saved Amplitude chart(s) by ID (max 3)")
    .option("--group-by-limit <n>", "Max group-by values to return (1-1000)")
    .option("--time-series-limit <n>", "Max group-by values with per-interval rows")
    .option("--exclude-incomplete", "Drop the current, still-incomplete interval")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (chartIds, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getChartData({ chartIds, ...queryOptions(opts) });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  // --- Chart-type guide ---
  query
    .command("guide [chart-type]")
    .description("Show parameter schema, valid enums and an example for a chart type")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (chartType, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getChartGuide(chartType);
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });
}
