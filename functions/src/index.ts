import { onRequest } from "firebase-functions/v2/https";
import { app } from "./app";

export const mcp = onRequest(
  {
    region: "us-central1", // must match the rewrite region in firebase.json
    secrets: ["PBI_TENANT_ID", "PBI_CLIENT_ID", "PBI_CLIENT_SECRET"],
    timeoutSeconds: 60,
    memory: "512MiB",
    maxInstances: 10,
  },
  app
);
