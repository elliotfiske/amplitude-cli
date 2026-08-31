/**
 * Event discovery commands — list events, get properties, semantic search.
 *
 * Event listing goes through manage_amp_events (action=get); property listing
 * through get_properties. Fuzzy "what is this event called" lookups use
 * search_amp_data_taxonomy, which is semantic rather than substring-matched.
 */

import { Command } from "commander";
import { AmplitudeMcpClient } from "../mcp-client.js";
import { output, type OutputFormat } from "../utils/format.js";
import { extractMcpText } from "../utils/mcp-helpers.js";
import { handleError } from "../utils/errors.js";

export function registerEventCommands(program: Command): void {
  const events = program
    .command("events")
    .description("Discover and inspect event types");

  events
    .command("list")
    .description("List event types in the project")
    .option("--limit <n>", "Page size (1-500)", "50")
    .option("--cursor <cursor>", "Pagination cursor from a previous response")
    .option("--include-deleted", "Include soft-deleted events")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getEvents({
          limit: parseInt(opts.limit, 10),
          ...(opts.cursor && { cursor: opts.cursor }),
          ...(opts.includeDeleted && { includeDeleted: true }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  events
    .command("get <event-type...>")
    .description("Hydrate specific events by exact name")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (eventTypes, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getEvents({ eventTypes });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  events
    .command("search <description>")
    .description('Semantic event discovery, phrased as a behavior ("user completes a purchase")')
    .option("--limit <n>", "Max hits (1-50)", "10")
    .option("--detail <level>", "compact, stats, or full", "compact")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (description, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.searchTaxonomy(
          [{ kind: "events", description, limit: parseInt(opts.limit, 10) }],
          { detail: opts.detail }
        );
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  events
    .command("props [event-type]")
    .description("Get event properties for one event, or project-wide when omitted")
    .option("--limit <n>", "Max properties for project-wide listing (1-500)")
    .option("--cursor <cursor>", "Pagination cursor for project-wide listing")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (eventType, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getEventProperties(eventType, {
          ...(opts.limit && { limit: parseInt(opts.limit, 10) }),
          ...(opts.cursor && { cursor: opts.cursor }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  events
    .command("user-props")
    .description("List user properties for the project")
    .option("--name <name>", "Exact user property name (case-sensitive)")
    .option("--limit <n>", "Max properties to return")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getUserProperties({
          ...(opts.name && { name: opts.name }),
          ...(opts.limit && { limit: parseInt(opts.limit, 10) }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  events
    .command("values <property-name>")
    .description("Look up observed values for a known property")
    .option("--event <event-type>", "Owning event for an event property (omit for user properties)")
    .option("--limit <n>", "Max values (1-50)", "10")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (propertyName, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.searchTaxonomy([
          {
            kind: "property_values",
            propertyName,
            ...(opts.event && { eventType: opts.event }),
            limit: parseInt(opts.limit, 10),
          },
        ]);
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });
}
