import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server";

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([createMcpServer().connect(serverSide), client.connect(clientSide)]);
  return client;
}

test("exposes all eight tools", async () => {
  delete process.env.PBI_READ_ONLY;
  const { tools } = await (await connect()).listTools();
  assert.equal(tools.length, 8);
});

test("read-only mode hides and refuses the refresh tools", async () => {
  process.env.PBI_READ_ONLY = "true";
  try {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(names.length, 6);
    assert.ok(!names.includes("pbi_refresh_dataset"));
    assert.ok(!names.includes("pbi_ensure_fresh"));
    const result = await client
      .callTool({ name: "pbi_refresh_dataset", arguments: { workspaceId: "w", datasetId: "d" } })
      .catch((e: Error) => ({ isError: true, message: e.message }));
    assert.ok((result as { isError?: boolean }).isError);
  } finally {
    delete process.env.PBI_READ_ONLY;
  }
});

test("dataset hint is appended to the query tools", async () => {
  process.env.PBI_DATASET_HINT = "Use the Warehouse dataset.";
  try {
    const { tools } = await (await connect()).listTools();
    const dax = tools.find((t) => t.name === "pbi_execute_dax")!;
    assert.match(dax.description ?? "", /Use the Warehouse dataset\.$/);
  } finally {
    delete process.env.PBI_DATASET_HINT;
  }
});
