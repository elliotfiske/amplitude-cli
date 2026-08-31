/**
 * Cohort commands — list, get, create, membership.
 * All via use_amplitude_cohorts, selected by its `action` discriminator.
 */

import { Command } from "commander";
import { AmplitudeMcpClient } from "../mcp-client.js";
import { output, type OutputFormat } from "../utils/format.js";
import { extractMcpText } from "../utils/mcp-helpers.js";
import { handleError } from "../utils/errors.js";

export function registerCohortCommands(program: Command): void {
  const cohorts = program
    .command("cohorts")
    .description("Manage and inspect cohorts");

  cohorts
    .command("list")
    .description("List cohorts in the project")
    .option("-s, --search <query>", "Match against cohort names (omit to browse by recency)")
    .option("--limit <n>", "Max results", "20")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.listCohorts({
          ...(opts.search && { query: opts.search }),
          limit: parseInt(opts.limit, 10),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  cohorts
    .command("get <cohort-id...>")
    .description("Get cohort definitions by ID (max 50)")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (cohortIds, opts) => {
      try {
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.getCohorts(cohortIds);
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  cohorts
    .command("membership <cohort-id...>")
    .description("Check whether a user belongs to the given cohorts (max 5)")
    .option("--amplitude-id <id>", "Amplitude ID")
    .option("--user-id <id>", "Your product's user ID")
    .option("--email <email>", "Email address")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (cohortIds, opts) => {
      try {
        if (!opts.amplitudeId && !opts.userId && !opts.email) {
          throw new Error("Provide one of --amplitude-id, --user-id, or --email.");
        }
        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.callTool("use_amplitude_cohorts", {
          action: "membership",
          cohortIds,
          ...(opts.amplitudeId && { amplitudeId: opts.amplitudeId }),
          ...(opts.userId && { userId: opts.userId }),
          ...(opts.email && { email: opts.email }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });

  cohorts
    .command("create")
    .description("Create a cohort from a JSON definition (reads from stdin or --definition)")
    .requiredOption("--name <name>", "Cohort name")
    .option("--definition <json>", "Cohort definition JSON (andClauses/orClauses, countGroup, …)")
    .option("--cohort-type <type>", "redshift, clause_based_fine_grained_time, cluster, funnels, sessions")
    .option("--owner <login>", "Cohort owner (defaults to the current user)")
    .option("-f, --format <format>", "Output format: json, compact, csv", "json")
    .action(async (opts) => {
      try {
        let definition: Record<string, unknown>;
        if (opts.definition) {
          definition = JSON.parse(opts.definition);
        } else {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          const raw = Buffer.concat(chunks).toString("utf-8").trim();
          if (!raw) {
            throw new Error(
              "No definition provided. Pass --definition '<json>' or pipe JSON on stdin."
            );
          }
          definition = JSON.parse(raw);
        }

        const mcp = new AmplitudeMcpClient({ projectId: program.opts().projectId });
        const result = await mcp.createCohort({
          name: opts.name,
          definition,
          ...(opts.cohortType && { cohortType: opts.cohortType }),
          ...(opts.owner && { cohortOwner: opts.owner }),
        });
        output(extractMcpText(result), opts.format as OutputFormat);
      } catch (err) {
        handleError(err);
      }
    });
}
