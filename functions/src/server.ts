import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as pbi from "./client";
import { config } from "./config";

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
const MAX_RESULT_BYTES = 2_000_000;
const json = (v: unknown) => {
  const out = JSON.stringify(v);
  const bytes = Buffer.byteLength(out);
  if (bytes > MAX_RESULT_BYTES) {
    throw new Error(
      `Result is ${(bytes / 1e6).toFixed(1)} MB, over the ${MAX_RESULT_BYTES / 1e6} MB limit. ` +
        "Aggregate in DAX (SUMMARIZECOLUMNS, TOPN, filters) and ask for fewer rows."
    );
  }
  return text(out);
};

const workspaceArg = { workspaceId: { type: "string", description: "Workspace (group) ID" } };
const datasetArg = { datasetId: { type: "string", description: "Dataset (semantic model) ID" } };

const WRITE_TOOLS = new Set(["pbi_refresh_dataset", "pbi_ensure_fresh"]);

function withHint(description: string): string {
  const hint = config.datasetHint();
  return hint ? `${description}\n\n${hint}` : description;
}

function tools() {
  const all = [
    {
      name: "pbi_list_workspaces",
      description: "List the Power BI workspaces this server can see. Start here to find workspace IDs.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "pbi_list_datasets",
      description: "List the datasets (semantic models) in a Power BI workspace, with their IDs.",
      inputSchema: { type: "object", properties: { ...workspaceArg }, required: ["workspaceId"] },
    },
    {
      name: "pbi_list_reports",
      description: "List the reports in a Power BI workspace and the dataset each one is built on.",
      inputSchema: { type: "object", properties: { ...workspaceArg }, required: ["workspaceId"] },
    },
    {
      name: "pbi_list_tables",
      description: withHint(
        "List every table and its columns in a Power BI dataset. Call this before writing DAX so you use real table and column names."
      ),
      inputSchema: { type: "object", properties: { ...datasetArg }, required: ["datasetId"] },
    },
    {
      name: "pbi_execute_dax",
      description: withHint(
        "Run a DAX query against a Power BI dataset and return the rows. The query must start with EVALUATE. " +
          "Prefer aggregated results (SUMMARIZECOLUMNS, TOPN) over dumping whole tables; the Power BI API caps a result at 100,000 rows."
      ),
      inputSchema: {
        type: "object",
        properties: {
          ...datasetArg,
          query: {
            type: "string",
            description: "DAX query, e.g. EVALUATE TOPN(10, 'Sales', 'Sales'[Revenue], DESC)",
          },
        },
        required: ["datasetId", "query"],
      },
    },
    {
      name: "pbi_refresh_dataset",
      description: "Trigger a refresh of a Power BI dataset. Refreshes are asynchronous and count against your capacity's daily refresh limit.",
      inputSchema: { type: "object", properties: { ...workspaceArg, ...datasetArg }, required: ["workspaceId", "datasetId"] },
    },
    {
      name: "pbi_refresh_history",
      description: "Get the recent refresh history of a Power BI dataset: status, start and end times, and errors.",
      inputSchema: { type: "object", properties: { ...workspaceArg, ...datasetArg }, required: ["workspaceId", "datasetId"] },
    },
    {
      name: "pbi_ensure_fresh",
      description:
        "Check whether a dataset has refreshed successfully today (UTC). If it hasn't, and no refresh is running, trigger one. " +
        "Call this before answering questions that need today's numbers.",
      inputSchema: { type: "object", properties: { ...workspaceArg, ...datasetArg }, required: ["workspaceId", "datasetId"] },
    },
  ];
  return config.readOnly() ? all.filter((t) => !WRITE_TOOLS.has(t.name)) : all;
}

export function createMcpServer() {
  const server = new Server({ name: "pbi-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Failures go back as tool results the model can read and act on,
    // rather than protocol errors it may never see.
    try {
      return await callTool(request.params.name, request.params.arguments ?? {});
    } catch (err) {
      return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
    }
  });

  return server;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const a = args as Record<string, string>;

  if (config.readOnly() && WRITE_TOOLS.has(name)) {
    throw new Error(`${name} is disabled: this server runs in read-only mode (PBI_READ_ONLY).`);
  }

  switch (name) {
    case "pbi_list_workspaces": {
      const workspaces = (await pbi.listWorkspaces()).value ?? [];
      if (workspaces.length === 0) {
        throw new Error(
          "The service principal can't see any Power BI workspaces. A Power BI admin must " +
            "(1) allow service principals to use Power BI APIs (Admin portal > Tenant settings > Developer settings) and " +
            "(2) add the service principal to at least one workspace as a Contributor or Member."
        );
      }
      return json(workspaces);
    }
    case "pbi_list_datasets":
      return json((await pbi.listDatasets(a.workspaceId)).value);
    case "pbi_list_reports":
      return json((await pbi.listReports(a.workspaceId)).value);
    case "pbi_list_tables":
      return json(await pbi.listTables(a.datasetId));
    case "pbi_execute_dax":
      if (!a.query?.trim()) throw new Error("query is required");
      return json(await pbi.executeDax(a.datasetId, a.query));
    case "pbi_refresh_dataset":
      await pbi.refreshDataset(a.workspaceId, a.datasetId);
      return text("Dataset refresh triggered. Use pbi_refresh_history to follow its progress.");
    case "pbi_refresh_history":
      return json((await pbi.getRefreshHistory(a.workspaceId, a.datasetId)).value);
    case "pbi_ensure_fresh":
      return text(await ensureFresh(a.workspaceId, a.datasetId));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Refreshed today? Say so. Running? Say so. Neither? Kick one off. */
async function ensureFresh(workspaceId: string, datasetId: string): Promise<string> {
  const history = await pbi.getRefreshHistory(workspaceId, datasetId);
  const refreshes: Array<{ status: string; endTime?: string; startTime?: string }> = history.value ?? [];
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSuccess = refreshes.find((r) => r.status === "Completed");
  const lastSuccessDate = lastSuccess?.endTime?.slice(0, 10);

  if (lastSuccessDate === todayUtc) {
    return `Data is current. Last successful refresh completed at ${lastSuccess!.endTime} (UTC).`;
  }

  // Power BI reports an in-progress refresh with status "Unknown".
  const inProgress = refreshes.find((r) => r.status === "Unknown");
  if (inProgress) {
    return `A refresh is already running (started ${inProgress.startTime}). Data from ${lastSuccessDate ?? "an unknown date"} is loaded meanwhile.`;
  }

  await pbi.refreshDataset(workspaceId, datasetId);
  return `Refresh triggered. Last successful refresh was ${lastSuccessDate ?? "unknown"}. New data usually lands within 10–30 minutes.`;
}
