/**
 * User lookup commands — resolve a user, read their profile, read their timeline.
 * All via get_amp_user_data, whose `include` field selects the mode.
 */

import { Command } from "commander";
import { AmplitudeMcpClient } from "../mcp-client.js";
import { output, type OutputFormat } from "../utils/format.js";
import { extractMcpText } from "../utils/mcp-helpers.js";
import { handleError } from "../utils/errors.js";

/**
 * Decide which identifier field a free-form query should land in. The server
 * resolves userId / email / deviceId to an amplitudeId itself; we only need to
 * pick the right slot so it knows how to interpret the value.
 */
function identifierFor(query: string): Record<string, string> {
  if (query.includes("@")) return { email: query };
  // Amplitude IDs are long numeric strings; product user IDs are usually not.
  if (/^\d{10,}$/.test(query)) return { amplitudeId: query };
  return { userId: query };
}

export function registerUserCommands(program: Command): void {
  const users = program
    .command("users")
    .description("User search and activity lookup");

  users
    .command("search <query>")
    .description("Look up a user by email, user ID, or Amplitude ID")
    .option("--device-id <id>", "Treat the query as a device ID instead")
    .option("--include <mode>", "id, profile, timeline, both", "profile")
    .option("--experiment-data", "Include [Experiment]-prefixed properties")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (query, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getUserData({
          ...(opts.deviceId ? { deviceId: opts.deviceId } : identifierFor(query)),
          include: opts.include,
          ...(opts.experimentData && { includeExperimentData: true }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  users
    .command("activity <identifier>")
    .description("Get the event timeline for a user (accepts email, user ID, or Amplitude ID)")
    .option("--limit <n>", "Max events to return (max 1000)", "50")
    .option("--props", "Include full event properties")
    .option("--filter-events <types...>", "Only include these exact event types")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (identifier, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getUserData({
          ...identifierFor(identifier),
          include: "timeline",
          eventLimit: parseInt(opts.limit, 10),
          ...(opts.props && { includeEventProperties: true }),
          ...(opts.filterEvents && { filterEvents: opts.filterEvents }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  users
    .command("org")
    .description("List org teammates (for sharing); needs no project")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getUserData({ include: "org" });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });
}
