/**
 * Amplitude MCP client.
 *
 * The MCP server exposes tools via JSON-RPC over HTTP (Streamable HTTP transport).
 *
 * Tool names below track Amplitude's current consolidated surface: a handful of
 * multiplexer tools that take an `action`/`include` discriminator rather than one
 * tool per verb. Run `amp tools list` to see the live surface.
 */

import { createRequire } from "node:module";

import { getAccessToken, getMcpBaseUrl, getOAuthConfig } from "./utils/oauth.js";

// Single source of truth for the version: package.json. Hardcoding it here
// lets `amp --version` and the MCP clientInfo drift from the published version.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const CLI_VERSION: string = version;

export interface McpToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: unknown;
  }>;
  isError?: boolean;
}

export class AmplitudeMcpClient {
  private region: string;
  private projectId?: string;
  private cachedProjectId?: string;
  private sessionId?: string;
  private initialized = false;

  constructor(opts?: { region?: string; projectId?: string }) {
    const oauth = getOAuthConfig();
    this.region =
      opts?.region ||
      process.env.AMPLITUDE_REGION ||
      oauth?.region ||
      "us";
    this.projectId =
      opts?.projectId ||
      process.env.AMPLITUDE_PROJECT_ID ||
      undefined;
  }

  /**
   * Resolve the project ID (Amplitude calls it appId).
   *
   * Order: explicit constructor arg / --project-id, then AMPLITUDE_PROJECT_ID,
   * then auto-discovery from get_amplitude_context. Result is cached per client.
   */
  async getProjectId(): Promise<string | undefined> {
    if (this.projectId) return this.projectId;
    if (this.cachedProjectId) return this.cachedProjectId;

    try {
      const ctx = await this.getContext();
      const parsed = parseToolJson(ctx);
      if (parsed && typeof parsed === "object") {
        const o = parsed as Record<string, any>;
        // get_amplitude_context (org route) returns { user: { defaultAppId }, projects: [{ appId }] }.
        const id =
          o.user?.defaultAppId ??
          o.projects?.[0]?.appId ??
          o.appId ??
          o.projectId;
        if (id) {
          this.cachedProjectId = String(id);
          return this.cachedProjectId;
        }
      }
    } catch {
      // Auto-discovery failed; caller decides whether a project is mandatory.
    }
    return undefined;
  }

  /**
   * Like getProjectId, but throws a actionable error instead of returning
   * undefined. Most of the current tool surface requires an explicit projectId.
   */
  async requireProjectId(): Promise<string> {
    const pid = await this.getProjectId();
    if (!pid) {
      throw new Error(
        "Could not determine an Amplitude project ID.\n" +
          "Pass --project-id <id>, set AMPLITUDE_PROJECT_ID, or run " +
          "`amp auth context` to see the projects you can access."
      );
    }
    return pid;
  }

  /**
   * Initialize MCP session. Must be called before any tool calls.
   * Auto-called by callTool if not yet initialized.
   */
  private async ensureSession(): Promise<void> {
    if (this.initialized && this.sessionId) return;

    const token = await getAccessToken(this.region);
    const baseUrl = getMcpBaseUrl(this.region);

    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "amplitude-cli", version: CLI_VERSION },
      },
    };

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const newSessionId = res.headers.get("mcp-session-id");
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new McpError(res.status, text, "initialize");
    }

    this.initialized = true;
  }

  /**
   * Call an MCP tool on the Amplitude server.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<McpToolResult> {
    try {
      return await this._callToolOnce(toolName, args);
    } catch (err) {
      // Auto-recover from session errors by re-initializing
      if (err instanceof McpError && err.detail.toLowerCase().includes("session")) {
        this.sessionId = undefined;
        this.initialized = false;
        return await this._callToolOnce(toolName, args);
      }
      throw err;
    }
  }

  private async _callToolOnce(
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<McpToolResult> {
    await this.ensureSession();

    const token = await getAccessToken(this.region);
    const baseUrl = getMcpBaseUrl(this.region);

    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    };

    // Include session ID for continuity if we have one
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    // Capture session ID from response
    const newSessionId = res.headers.get("mcp-session-id");
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new McpError(res.status, text, toolName);
    }

    const contentType = res.headers.get("content-type") || "";

    // Handle SSE (text/event-stream) response
    if (contentType.includes("text/event-stream")) {
      return this.parseSSEResponse(res);
    }

    // Handle direct JSON response
    const result = (await res.json()) as {
      result?: McpToolResult;
      error?: { message: string; code: number };
    };

    if (result.error) {
      throw new McpError(
        result.error.code,
        result.error.message,
        toolName
      );
    }

    return result.result || { content: [] };
  }

  /**
   * Parse SSE response from MCP server.
   */
  private async parseSSEResponse(res: Response): Promise<McpToolResult> {
    const text = await res.text();
    const lines = text.split("\n");
    let lastData = "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        lastData = line.slice(6);
      }
    }

    if (!lastData) {
      return { content: [] };
    }

    try {
      const parsed = JSON.parse(lastData) as {
        result?: McpToolResult;
        error?: { message: string; code: number };
      };

      if (parsed.error) {
        throw new McpError(
          parsed.error.code,
          parsed.error.message,
          "sse"
        );
      }

      return parsed.result || { content: [] };
    } catch (err) {
      if (err instanceof McpError) throw err;
      // Return raw text as content
      return {
        content: [{ type: "text", text: lastData }],
      };
    }
  }

  /**
   * List available MCP tools.
   */
  async listTools(): Promise<unknown> {
    await this.ensureSession();
    const token = await getAccessToken(this.region);
    const baseUrl = getMcpBaseUrl(this.region);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    };

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/list",
        params: {},
      }),
    });

    const newSessionId = res.headers.get("mcp-session-id");
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new McpError(res.status, text, "tools/list");
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      return this.parseSSEResponse(res);
    }

    return res.json();
  }

  // ─── Convenience wrappers over the live tool surface ──────────────────
  //
  // Each wrapper names the real tool it calls. When Amplitude changes the
  // surface again, `amp tools list` / `amp tools describe <name>` is the
  // source of truth and only this section should need to move.

  // -- context -----------------------------------------------------------

  /** get_amplitude_context — org + project list, or one project's settings. */
  async getContext(projectId?: number): Promise<McpToolResult> {
    return this.callTool("get_amplitude_context", {
      ...(projectId !== undefined && { projectId }),
      rationale: "amp CLI: resolve org/project context",
    });
  }

  // -- search ------------------------------------------------------------

  /**
   * search_amp_entities — find saved entities (charts, dashboards, cohorts,
   * experiments, …) by name. Note: `queries` is an array and the per-query cap
   * is `limitPerQuery`, not `limit`.
   */
  async searchEntities(opts: {
    query?: string;
    entityTypes?: string[];
    limit?: number;
    appIds?: string[];
    sortOrder?: string;
    semanticSearch?: boolean;
  }): Promise<McpToolResult> {
    return this.callTool("search_amp_entities", {
      ...(opts.query ? { queries: [opts.query] } : {}),
      ...(opts.entityTypes && { entityTypes: opts.entityTypes }),
      ...(opts.limit !== undefined && { limitPerQuery: opts.limit }),
      ...(opts.appIds && { appIds: opts.appIds }),
      ...(opts.sortOrder && { sortOrder: opts.sortOrder }),
      ...(opts.semanticSearch !== undefined && { semanticSearch: opts.semanticSearch }),
      rationale: "amp CLI: entity search",
    });
  }

  /**
   * search_amp_data_taxonomy — semantic discovery over events, properties and
   * property values. Requires projectId and a batch of `searches`.
   */
  async searchTaxonomy(
    searches: Array<Record<string, unknown>>,
    opts?: { projectId?: string; detail?: "compact" | "stats" | "full" }
  ): Promise<McpToolResult> {
    const projectId = opts?.projectId ?? (await this.requireProjectId());
    return this.callTool("search_amp_data_taxonomy", {
      projectId,
      searches,
      ...(opts?.detail && { detail: opts.detail }),
      rationale: "amp CLI: taxonomy search",
    });
  }

  // -- events & properties -----------------------------------------------

  /** manage_amp_events (action=get) — list/hydrate tracking-plan events. */
  async getEvents(opts?: {
    projectId?: string;
    eventTypes?: string[];
    limit?: number;
    cursor?: string;
    includeDeleted?: boolean;
  }): Promise<McpToolResult> {
    const projectId = opts?.projectId ?? (await this.requireProjectId());
    return this.callTool("manage_amp_events", {
      action: "get",
      kind: "event",
      projectId,
      ...(opts?.eventTypes && { eventTypes: opts.eventTypes }),
      ...(opts?.limit !== undefined && { limit: opts.limit }),
      ...(opts?.cursor && { cursor: opts.cursor }),
      ...(opts?.includeDeleted !== undefined && { includeDeleted: opts.includeDeleted }),
      rationale: "amp CLI: list events",
    });
  }

  /** get_properties (propertyType=event) — properties for one event, or project-wide. */
  async getEventProperties(
    eventType?: string,
    opts?: { projectId?: string; limit?: number; cursor?: string }
  ): Promise<McpToolResult> {
    const projectId = opts?.projectId ?? (await this.requireProjectId());
    return this.callTool("get_properties", {
      propertyType: "event",
      projectId,
      ...(eventType ? { eventType } : {}),
      ...(opts?.limit !== undefined && { limit: opts.limit }),
      ...(opts?.cursor && { cursor: opts.cursor }),
      rationale: "amp CLI: event properties",
    });
  }

  /** get_properties (propertyType=user). */
  async getUserProperties(opts?: {
    projectId?: string;
    name?: string;
    limit?: number;
  }): Promise<McpToolResult> {
    const projectId = opts?.projectId ?? (await this.requireProjectId());
    return this.callTool("get_properties", {
      propertyType: "user",
      projectId,
      ...(opts?.name ? { name: opts.name } : {}),
      ...(opts?.limit !== undefined && { limit: opts.limit }),
      rationale: "amp CLI: user properties",
    });
  }

  // -- charts ------------------------------------------------------------

  /** get_amplitude_charts (include=definition) — raw saved chart config. */
  async getCharts(chartIds: string[]): Promise<McpToolResult> {
    return this.callTool("get_amplitude_charts", {
      chartIds,
      include: "definition",
    });
  }

  /** get_amplitude_charts (include=typed) — UI-shaped params, editable + replayable. */
  async getChartTyped(chartIds: string[]): Promise<McpToolResult> {
    return this.callTool("get_amplitude_charts", { chartIds, include: "typed" });
  }

  /** get_amplitude_charts (include=link) — just the chart URL(s). */
  async getChartLinks(chartIds: string[]): Promise<McpToolResult> {
    return this.callTool("get_amplitude_charts", { chartIds, include: "link" });
  }

  /**
   * get_amplitude_charts (include=data) — run saved charts or chart edits.
   * Max 3 ids/edits combined, per the tool contract.
   */
  async getChartData(opts: {
    chartIds?: string[];
    chartEditIds?: string[];
    groupByLimit?: number;
    timeSeriesLimit?: number;
    excludeIncompleteDatapoints?: boolean;
  }): Promise<McpToolResult> {
    return this.callTool("get_amplitude_charts", {
      include: "data",
      ...(opts.chartIds && { chartIds: opts.chartIds }),
      ...(opts.chartEditIds && { chartEditIds: opts.chartEditIds }),
      ...(opts.groupByLimit !== undefined && { groupByLimit: opts.groupByLimit }),
      ...(opts.timeSeriesLimit !== undefined && { timeSeriesLimit: opts.timeSeriesLimit }),
      ...(opts.excludeIncompleteDatapoints !== undefined && {
        excludeIncompleteDatapoints: opts.excludeIncompleteDatapoints,
      }),
    });
  }

  /**
   * get_amplitude_charts (include=guide) — parameter schema, valid enums and a
   * working example for a chart type. Omit chartType to list supported types.
   */
  async getChartGuide(chartType?: string): Promise<McpToolResult> {
    return this.callTool("get_amplitude_charts", {
      include: "guide",
      ...(chartType ? { chartType } : {}),
    });
  }

  // -- ad-hoc queries ----------------------------------------------------

  /**
   * query_amplitude_data with the typed `chart` parameter (the preferred path).
   * Returns the data plus a `chartEditId` that can be rendered or attached to a
   * dashboard.
   */
  async queryChart(
    chart: Record<string, unknown>,
    opts?: {
      projectId?: string;
      chartId?: string;
      groupByLimit?: number;
      timeSeriesLimit?: number;
      excludeIncompleteDatapoints?: boolean;
    }
  ): Promise<McpToolResult> {
    const projectId = opts?.projectId ?? (await this.requireProjectId());
    return this.callTool("query_amplitude_data", {
      projectId,
      chart: normalizeTypedChart(chart),
      ...(opts?.chartId && { chartId: opts.chartId }),
      ...(opts?.groupByLimit !== undefined && { groupByLimit: opts.groupByLimit }),
      ...(opts?.timeSeriesLimit !== undefined && { timeSeriesLimit: opts.timeSeriesLimit }),
      ...(opts?.excludeIncompleteDatapoints !== undefined && {
        excludeIncompleteDatapoints: opts.excludeIncompleteDatapoints,
      }),
    });
  }

  /**
   * query_amplitude_data with the raw `definition` fallback. Needed for chart
   * types the typed model does not cover (revenueLtv, composition, …).
   * `definition.app` is required by the server and is filled in here.
   */
  async queryDefinition(
    definition: Record<string, unknown>,
    opts?: {
      projectId?: string;
      groupByLimit?: number;
      timeSeriesLimit?: number;
      excludeIncompleteDatapoints?: boolean;
    }
  ): Promise<McpToolResult> {
    const projectId = opts?.projectId ?? (await this.requireProjectId());
    return this.callTool("query_amplitude_data", {
      projectId,
      definition: { app: projectId, ...definition },
      ...(opts?.groupByLimit !== undefined && { groupByLimit: opts.groupByLimit }),
      ...(opts?.timeSeriesLimit !== undefined && { timeSeriesLimit: opts.timeSeriesLimit }),
      ...(opts?.excludeIncompleteDatapoints !== undefined && {
        excludeIncompleteDatapoints: opts.excludeIncompleteDatapoints,
      }),
    });
  }

  // -- dashboards --------------------------------------------------------

  /** use_amp_dashboards (action=get) — one to three dashboards. */
  async getDashboards(dashboardIds: string[]): Promise<McpToolResult> {
    return this.callTool("use_amp_dashboards", {
      action: "get",
      dashboardIds,
      rationale: "amp CLI: read dashboard",
    });
  }

  /**
   * use_amp_dashboards (action=create). `rows[].chartId` accepts either a saved
   * chart id or a chart edit id — edit ids are persisted as part of the create.
   */
  async createDashboard(opts: {
    name: string;
    rows: unknown[];
    description?: string;
    chartEdits?: unknown[];
  }): Promise<McpToolResult> {
    return this.callTool("use_amp_dashboards", {
      action: "create",
      name: opts.name,
      rows: opts.rows,
      ...(opts.description && { description: opts.description }),
      ...(opts.chartEdits && { chartEdits: opts.chartEdits }),
      rationale: "amp CLI: create dashboard",
    });
  }

  // -- cohorts -----------------------------------------------------------

  /** use_amplitude_cohorts (action=list). */
  async listCohorts(opts?: {
    projectId?: string;
    query?: string;
    limit?: number;
  }): Promise<McpToolResult> {
    const projectId = opts?.projectId ?? (await this.requireProjectId());
    return this.callTool("use_amplitude_cohorts", {
      action: "list",
      projectId,
      ...(opts?.query ? { query: opts.query } : {}),
      ...(opts?.limit !== undefined && { limit: opts.limit }),
      rationale: "amp CLI: list cohorts",
    });
  }

  /** use_amplitude_cohorts (action=get) — max 50 ids. */
  async getCohorts(cohortIds: string[]): Promise<McpToolResult> {
    return this.callTool("use_amplitude_cohorts", {
      action: "get",
      cohortIds,
      rationale: "amp CLI: read cohorts",
    });
  }

  /** use_amplitude_cohorts (action=create). */
  async createCohort(opts: {
    name: string;
    definition: Record<string, unknown>;
    projectId?: string;
    cohortType?: string;
    cohortOwner?: string;
  }): Promise<McpToolResult> {
    const projectId = opts.projectId ?? (await this.requireProjectId());
    return this.callTool("use_amplitude_cohorts", {
      action: "create",
      projectId,
      name: opts.name,
      definition: opts.definition,
      ...(opts.cohortType && { cohortType: opts.cohortType }),
      ...(opts.cohortOwner && { cohortOwner: opts.cohortOwner }),
      rationale: "amp CLI: create cohort",
    });
  }

  // -- experiments -------------------------------------------------------

  /** use_amp_experiments (action=get). */
  async getExperiments(ids: string[]): Promise<McpToolResult> {
    return this.callTool("use_amp_experiments", {
      action: "get",
      ids,
      rationale: "amp CLI: read experiments",
    });
  }

  /** use_amp_experiments (action=analyze) — results for one experiment. */
  async analyzeExperiment(
    id: string,
    opts?: { metricIds?: string[]; groupBy?: unknown[]; filters?: unknown[] }
  ): Promise<McpToolResult> {
    return this.callTool("use_amp_experiments", {
      action: "analyze",
      id,
      ...(opts?.metricIds && { metricIds: opts.metricIds }),
      ...(opts?.groupBy && { groupBy: opts.groupBy }),
      ...(opts?.filters && { filters: opts.filters }),
      rationale: "amp CLI: analyze experiment",
    });
  }

  // -- users -------------------------------------------------------------

  /**
   * get_amp_user_data — resolve a user and optionally return their profile or
   * event timeline. Exactly one identifier should be supplied.
   */
  async getUserData(opts: {
    projectId?: string;
    amplitudeId?: string;
    userId?: string;
    email?: string;
    deviceId?: string;
    include?: "id" | "profile" | "timeline" | "both" | "org";
    eventLimit?: number;
    includeEventProperties?: boolean;
    includeExperimentData?: boolean;
    filterEvents?: string[];
  }): Promise<McpToolResult> {
    const args: Record<string, unknown> = {
      ...(opts.amplitudeId && { amplitudeId: opts.amplitudeId }),
      ...(opts.userId && { userId: opts.userId }),
      ...(opts.email && { email: opts.email }),
      ...(opts.deviceId && { deviceId: opts.deviceId }),
      ...(opts.include && { include: opts.include }),
      ...(opts.eventLimit !== undefined && { eventLimit: opts.eventLimit }),
      ...(opts.includeEventProperties !== undefined && {
        includeEventProperties: opts.includeEventProperties,
      }),
      ...(opts.includeExperimentData !== undefined && {
        includeExperimentData: opts.includeExperimentData,
      }),
      ...(opts.filterEvents && { filterEvents: opts.filterEvents }),
      rationale: "amp CLI: user lookup",
    };
    // projectId is required for every mode except include='org'.
    if (opts.include !== "org") {
      args.projectId = opts.projectId ?? (await this.requireProjectId());
    }
    return this.callTool("get_amp_user_data", args);
  }
}

/**
 * Normalize a typed chart before sending it back to query_amplitude_data.
 *
 * get_amplitude_charts include='typed' emits `measured_as.as_` (trailing
 * underscore), but query_amplitude_data only reads `measured_as.as` — and it
 * ignores the unknown key silently rather than erroring, so a read-edit-replay
 * round-trip would quietly fall back to unique_users. Verified against the live
 * server: as_='event_totals' returned unique-user counts.
 */
function normalizeTypedChart(chart: Record<string, unknown>): Record<string, unknown> {
  const measured = chart.measured_as;
  if (
    measured &&
    typeof measured === "object" &&
    !Array.isArray(measured) &&
    "as_" in (measured as Record<string, unknown>) &&
    !("as" in (measured as Record<string, unknown>))
  ) {
    const { as_, ...rest } = measured as Record<string, unknown>;
    return { ...chart, measured_as: { as: as_, ...rest } };
  }
  return chart;
}

/**
 * Pull the first JSON text block out of a tool result. Amplitude returns tool
 * payloads as a JSON string inside content[].text.
 */
function parseToolJson(result: McpToolResult): unknown {
  const text = result.content?.find((c) => c.type === "text" && c.text)?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class McpError extends Error {
  constructor(
    public code: number,
    public detail: string,
    public tool: string
  ) {
    super(`MCP error (${code}) calling ${tool}: ${detail}`);
    this.name = "McpError";
  }
}
