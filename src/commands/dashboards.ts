/**
 * Dashboard commands — search, read, create.
 * Reads/writes go through use_amp_dashboards, selected by its `action` field;
 * search goes through search_amp_entities.
 */

import { Command } from "commander";
import { AmplitudeMcpClient } from "../mcp-client.js";
import { output, type OutputFormat } from "../utils/format.js";
import { extractMcpText } from "../utils/mcp-helpers.js";
import { handleError } from "../utils/errors.js";

export function registerDashboardCommands(program: Command): void {
  const dashboards = program
    .command("dashboards")
    .description("Create and manage Amplitude dashboards");

  dashboards
    .command("search <query>")
    .description("Search for existing dashboards by name")
    .option("--limit <n>", "Max results", "10")
    .option("--semantic", "Also use semantic search, not just keyword matching")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (query, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.searchEntities({
          query,
          entityTypes: ["DASHBOARD"],
          limit: parseInt(opts.limit, 10),
          ...(opts.semantic && { semanticSearch: true }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  dashboards
    .command("get <dashboard-id...>")
    .description("Get full dashboard definitions and contents (one to three)")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (dashboardIds, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getDashboards(dashboardIds);
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  dashboards
    .command("create")
    .description("Create a dashboard from a JSON array of layout rows")
    .requiredOption("--name <name>", "Dashboard name")
    .option("--description <desc>", "Dashboard description")
    .option("--definition <json>", "Rows as a JSON array; rows[].chartId takes chart or edit IDs")
    .option("--chart-edits <json>", "Optional JSON array naming the chart edits referenced in rows")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (opts) => {
      try {
        let rows: unknown;

        if (opts.definition) {
          rows = JSON.parse(opts.definition);
        } else {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          const raw = Buffer.concat(chunks).toString("utf-8").trim();
          if (!raw) {
            throw new Error(
              "No rows provided. Pass --definition '[...]' or pipe a JSON array on stdin."
            );
          }
          rows = JSON.parse(raw);
        }

        if (!Array.isArray(rows)) {
          throw new Error("Dashboard definition must be a JSON array of layout rows.");
        }

        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        console.error(`Creating dashboard "${opts.name}"...`);
        const result = await mcp.createDashboard({
          name: opts.name,
          rows,
          ...(opts.description && { description: opts.description }),
          ...(opts.chartEdits && { chartEdits: JSON.parse(opts.chartEdits) }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });
}
