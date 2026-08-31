/**
 * Experiment commands — search, read, analyze.
 * Reads/analysis go through use_amp_experiments (`action`); search through
 * search_amp_entities.
 */

import { Command } from "commander";
import { AmplitudeMcpClient } from "../mcp-client.js";
import { output, type OutputFormat } from "../utils/format.js";
import { extractMcpText } from "../utils/mcp-helpers.js";
import { handleError } from "../utils/errors.js";

export function registerExperimentCommands(program: Command): void {
  const experiments = program
    .command("experiments")
    .description("Analyze experiments and feature flags");

  experiments
    .command("search <query>")
    .description("Search for experiments and feature flags")
    .option("--limit <n>", "Max results", "10")
    .option("--flags", "Search feature flags instead of experiments")
    .option("--semantic", "Also use semantic search, not just keyword matching")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (query, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.searchEntities({
          query,
          entityTypes: [opts.flags ? "FLAG" : "EXPERIMENT"],
          limit: parseInt(opts.limit, 10),
          ...(opts.semantic && { semanticSearch: true }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  experiments
    .command("get <experiment-id...>")
    .description("Get detailed experiment information")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (ids, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getExperiments(ids);
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  experiments
    .command("results <experiment-id>")
    .description("Analyze experiment results with statistical significance")
    .option("--metric-ids <ids...>", "Specific metrics (default: primary metric only)")
    .option("--group-by <json>", 'Group-by JSON array, e.g. \'[{"type":"user","value":"country"}]\'')
    .option("--filters <json>", "Metric filters as a JSON array")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (experimentId, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.analyzeExperiment(experimentId, {
          ...(opts.metricIds && { metricIds: opts.metricIds }),
          ...(opts.groupBy && { groupBy: JSON.parse(opts.groupBy) }),
          ...(opts.filters && { filters: JSON.parse(opts.filters) }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });
}
