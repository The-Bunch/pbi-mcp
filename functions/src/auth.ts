import axios from "axios";
import { config } from "./config";

/**
 * The server talks to Power BI as a *service principal* (app-only,
 * client-credentials), not as the signed-in user. Users prove who they are via
 * Entra ID; the service principal decides what data is reachable — so scope it
 * by adding it only to the workspaces you want exposed.
 */
let tokenCache: { token: string; expires: number } | null = null;
let inFlight: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  // Never let the raw axios error escape: its config holds the client secret.
  const { data } = await axios
    .post(
    `https://login.microsoftonline.com/${config.tenantId()}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId(),
      client_secret: config.clientSecret(),
      scope: "https://analysis.windows.net/powerbi/api/.default",
    }),
    { timeout: 15_000 }
    )
    .catch((err: { response?: { status?: number; data?: { error?: string } } }) => {
      const reason = err.response?.data?.error ?? err.response?.status ?? "network error";
      throw new Error(`Service principal token request failed: ${reason}`);
    });

  tokenCache = {
    token: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.token;
}

export async function getPbiToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expires - 60_000) {
    return tokenCache.token;
  }
  // Single-flight: concurrent requests share one token fetch.
  inFlight ??= fetchToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
