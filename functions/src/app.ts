import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import oauthRouter from "./oauth";
import { requireAuth } from "./middleware";
import { createMcpServer } from "./server";

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  // Method and path only: headers and bodies carry tokens and data.
  console.log(`[request] ${req.method} ${req.path}`);
  next();
});

// OAuth discovery, registration and sign-in relay — public by design.
app.use(oauthRouter);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
// Clients treat 405 as "not offered" and carry on with POST.
export function methodNotAllowed(_req: express.Request, res: express.Response) {
  res.set("Allow", "POST").status(405).json({ error: "Method not allowed" });
}
app.get(["/", "/mcp"], requireAuth, methodNotAllowed);
app.delete(["/", "/mcp"], requireAuth, methodNotAllowed);

// The MCP endpoint itself. Stateless: a fresh server + transport per request,
// which is exactly what a scale-to-zero Cloud Function wants.
app.post(["/", "/mcp"], requireAuth, async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Plain JSON responses: Firebase Hosting buffers responses anyway.
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});
