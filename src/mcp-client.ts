/**
 * Amplitude MCP client.
 * Calls Amplitude's MCP server tools (search, query_dataset, save_chart_edits,
 * create_dashboard, etc.) using OAuth tokens.
 *
 * The MCP server exposes tools via JSON-RPC over HTTP (Streamable HTTP transport).
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
   * Resolve the project ID. Uses explicit value, env var, or auto-discovers
   * from get_context and caches the result.
   */
  async getProjectId(): Promise<string | undefined> {
    if (this.projectId) return this.projectId;
    if (this.cachedProjectId) return this.cachedProjectId;

    try {
      const ctx = await this.getContext();
      const text = ctx.content?.find((c) => c.type === "text")?.text;
      if (text) {
        const parsed = JSON.parse(text);
        const id =
          parsed?.appId ??
          parsed?.projectId ??
          parsed?.project_id ??
          parsed?.projects?.[0]?.appId ??
          parsed?.projects?.[0]?.id;
        if (id) {
          this.cachedProjectId = String(id);
          return this.cachedProjectId;
        }
      }
    } catch {
      // Auto-discovery failed; proceed without projectId
    }
    return undefined;
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

  // ─── Convenience methods for common MCP tools ─────────────────────────

  /**
   * Search for entities (charts, dashboards, events, cohorts, etc.)
   */
  async search(
    query: string,
    entityTypes?: string[],
    limit?: number
  ): Promise<McpToolResult> {
    return this.callTool("search", {
      query,
      ...(entityTypes && { entityTypes }),
      ...(limit && { limit }),
    });
  }

  /**
   * Get context (project info, user info).
   */
  async getContext(): Promise<McpToolResult> {
    return this.callTool("get_context");
  }

  /**
   * Get chart definitions by ID.
   */
  async getCharts(chartIds: string[]): Promise<McpToolResult> {
    return this.callTool("get_charts", { chartIds });
  }

  /**
   * Get dashboard by ID.
   */
  async getDashboard(dashboardId: string): Promise<McpToolResult> {
    return this.callTool("get_dashboard", { dashboardId });
  }

  /**
   * Query a dataset (create/preview a chart).
   * Returns data + an editId that can be saved.
   */
  async queryDataset(
    definition: Record<string, unknown>,
    projectId?: string
  ): Promise<McpToolResult> {
    const pid = projectId ?? (await this.getProjectId());
    const args: Record<string, unknown> = { definition };
    if (pid) args.projectId = pid;
    return this.callTool("query_dataset", args);
  }

  /**
   * Create a chart from a query definition.
   */
  async createChart(
    definition: Record<string, unknown>,
    projectId?: string
  ): Promise<McpToolResult> {
    const pid = projectId ?? (await this.getProjectId());
    const args: Record<string, unknown> = { definition };
    if (pid) args.projectId = pid;
    return this.callTool("create_chart", args);
  }

  /**
   * Save a chart from query_dataset results.
   */
  async saveChart(
    editId: string,
    name: string,
    description?: string
  ): Promise<McpToolResult> {
    return this.callTool("save_chart_edits", {
      editId,
      name,
      ...(description && { description }),
    });
  }

  /**
   * Create a dashboard with charts and layout.
   */
  async createDashboard(
    name: string,
    rows: unknown[],
    description?: string
  ): Promise<McpToolResult> {
    return this.callTool("create_dashboard", {
      name,
      rows,
      ...(description && { description }),
    });
  }

  /**
   * Get event properties for an event type.
   */
  async getEventProperties(eventType: string): Promise<McpToolResult> {
    return this.callTool("get_event_properties", { eventType });
  }

  /**
   * Query an existing chart's data.
   */
  async queryChart(chartId: string): Promise<McpToolResult> {
    return this.callTool("query_chart", { chartId });
  }

  /**
   * Get experiment details.
   */
  async getExperiments(experimentIds: string[]): Promise<McpToolResult> {
    return this.callTool("get_experiments", {
      experimentIds,
    });
  }

  /**
   * Query experiment results.
   */
  async queryExperiment(experimentId: string): Promise<McpToolResult> {
    return this.callTool("query_experiment", {
      experimentId,
    });
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
