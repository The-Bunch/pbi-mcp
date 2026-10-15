import axios from "axios";
import { getPbiToken } from "./auth";
import { config } from "./config";

const BASE = "https://api.powerbi.com/v1.0/myorg";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** IDs arrive from a language model — only ever let a GUID into the URL. */
const id = (value: string | undefined, name: string) => {
  const v = typeof value === "string" ? value.trim() : "";
  if (!GUID.test(v)) throw new Error(`${name} must be a Power BI ID (a GUID); got ${JSON.stringify(value)}`);
  return v;
};

async function pbi(path: string, method = "GET", body?: unknown) {
  const token = await getPbiToken();
  try {
    const { data } = await axios({
      method,
      url: `${BASE}${path}`,
      headers: { Authorization: `Bearer ${token}` },
      data: body,
      timeout: 45_000,
    });
    if (config.debug()) {
      console.log(`[pbi] ${method} ${path} -> ${JSON.stringify(data ?? "").substring(0, 200)}`);
    } else {
      console.log(`[pbi] ${method} ${path} -> ok`);
    }
    return data;
  } catch (err: unknown) {
    const e = err as { response?: { status: number; data: unknown }; message?: string };
    const status = e.response?.status ?? "network";
    const detail = e.response ? JSON.stringify(e.response.data) : e.message;
    console.error(`[pbi] ${method} ${path} -> ${status}`);
    throw new Error(`Power BI API error ${status}: ${detail}`);
  }
}

export const listWorkspaces = () => pbi("/groups");

export const listDatasets = (workspaceId: string) =>
  pbi(`/groups/${id(workspaceId, "workspaceId")}/datasets`);

export const listReports = (workspaceId: string) =>
  pbi(`/groups/${id(workspaceId, "workspaceId")}/reports`);

/**
 * Schema discovery without XMLA: COLUMNSTATISTICS() is a DAX function, so we
 * can learn every table and column through the ordinary executeQueries API.
 */
export async function listTables(datasetId: string): Promise<Record<string, string[]>> {
  const result = await pbi(`/datasets/${id(datasetId, "datasetId")}/executeQueries`, "POST", {
    queries: [
      { query: `EVALUATE SELECTCOLUMNS(COLUMNSTATISTICS(), "Table", [Table Name], "Column", [Column Name])` },
    ],
    serializerSettings: { includeNulls: true },
  });
  const rows: Array<{ "[Table]": string; "[Column]": string }> =
    result.results?.[0]?.tables?.[0]?.rows ?? [];
  const schema: Record<string, string[]> = {};
  for (const row of rows) {
    const table = row["[Table]"];
    const col = row["[Column]"];
    // Hide Power BI's auto-generated date tables and internal row-number columns.
    if (table.startsWith("LocalDateTable_") || table.startsWith("DateTableTemplate_")) continue;
    if (col.startsWith("RowNumber-")) continue;
    (schema[table] ??= []).push(col);
  }
  return schema;
}

export const executeDax = (datasetId: string, query: string) =>
  pbi(`/datasets/${id(datasetId, "datasetId")}/executeQueries`, "POST", {
    queries: [{ query }],
    serializerSettings: { includeNulls: true },
  });

export const refreshDataset = (workspaceId: string, datasetId: string) =>
  pbi(`/groups/${id(workspaceId, "workspaceId")}/datasets/${id(datasetId, "datasetId")}/refreshes`, "POST");

export const getRefreshHistory = (workspaceId: string, datasetId: string) =>
  pbi(`/groups/${id(workspaceId, "workspaceId")}/datasets/${id(datasetId, "datasetId")}/refreshes`);
