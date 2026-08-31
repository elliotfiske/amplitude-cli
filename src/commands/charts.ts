/**
 * Chart commands — search, read, and run Amplitude charts.
 *
 * Reads go through get_amplitude_charts, whose `include` mode selects what comes
 * back (link / typed / definition / data / guide). Ad-hoc chart creation goes
 * through query_amplitude_data, which returns a chart *edit* id.
 *
 * Note: the current tool surface has no standalone "save this edit as a named
 * chart" operation. Edit ids are persisted by referencing them from
 * `amp dashboards create`, which is why `charts create` stops at the edit.
 */

import { Command } from "commander";
import { AmplitudeMcpClient } from "../mcp-client.js";
import { output, type OutputFormat } from "../utils/format.js";
import { extractMcpText } from "../utils/mcp-helpers.js";
import { handleError } from "../utils/errors.js";

async function readDefinition(inline?: string): Promise<Record<string, unknown>> {
  if (inline) return JSON.parse(inline);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    throw new Error("No definition provided. Pass --definition '<json>' or pipe JSON on stdin.");
  }
  return JSON.parse(raw);
}

export function registerChartCommands(program: Command): void {
  const charts = program
    .command("charts")
    .description("Create and manage Amplitude charts");

  charts
    .command("search <query>")
    .description("Search for existing charts by name")
    .option("--limit <n>", "Max results", "10")
    .option("--semantic", "Also use semantic search, not just keyword matching")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (query, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.searchEntities({
          query,
          entityTypes: ["CHART"],
          limit: parseInt(opts.limit, 10),
          ...(opts.semantic && { semanticSearch: true }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  charts
    .command("get <chart-id...>")
    .description("Get raw chart definitions by ID")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (chartIds, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getCharts(chartIds);
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  charts
    .command("typed <chart-id...>")
    .description("Get charts as typed params — the shape 'query segment' etc. accept")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (chartIds, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getChartTyped(chartIds);
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  charts
    .command("link <chart-id...>")
    .description("Resolve chart IDs to their Amplitude URLs (does not run them)")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (chartIds, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getChartLinks(chartIds);
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  charts
    .command("query <chart-id...>")
    .description("Run saved chart(s) and return the data (max 3)")
    .option("--edit-ids", "Treat the arguments as chart edit IDs instead of saved chart IDs")
    .option("--group-by-limit <n>", "Max group-by values to return (1-1000)")
    .option("--time-series-limit <n>", "Max group-by values with per-interval rows")
    .option("--exclude-incomplete", "Drop the current, still-incomplete interval")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (ids, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getChartData({
          ...(opts.editIds ? { chartEditIds: ids } : { chartIds: ids }),
          ...(opts.groupByLimit && { groupByLimit: parseInt(opts.groupByLimit, 10) }),
          ...(opts.timeSeriesLimit && { timeSeriesLimit: parseInt(opts.timeSeriesLimit, 10) }),
          ...(opts.excludeIncomplete && { excludeIncompleteDatapoints: true }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  charts
    .command("create")
    .description("Run a chart definition and return its data + chart edit ID")
    .option("--definition <json>", "Chart JSON (typed 'chart' shape or raw definition)")
    .option("--raw", "Force the raw-definition fallback instead of the typed path")
    .option("--chart-id <id>", "Parent chart to fork/modify — its params become defaults")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (opts) => {
      try {
        const parsed = await readDefinition(opts.definition);
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });

        // A `kind` field means it is already in the typed shape; anything with a
        // `type`/`params` pair is a raw definition.
        const isTyped = !opts.raw && typeof parsed.kind === "string";
        const result = isTyped
          ? await mcp.queryChart(parsed, { ...(opts.chartId && { chartId: opts.chartId }) })
          : await mcp.queryDefinition(parsed);

        output(extractMcpText(result), opts.format as OutputFormat);
        console.error(
          "\nThis produced a chart *edit*. To persist it as a saved chart, reference the " +
            "returned chartEditId from `amp dashboards create --definition '[...]'`."
        );
      } catch (err) {
        handleError(err);
      }
    });

  charts
    .command("guide [chart-type]")
    .description("Parameter schema, valid enums and an example for a chart type")
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
