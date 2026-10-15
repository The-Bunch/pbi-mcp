const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A human name for where the authorization code is about to go. */
export function describeDestination(redirectUri: string): string {
  const url = new URL(redirectUri);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
    return "an app on this computer (such as Claude Desktop, Claude Code or the MCP Inspector)";
  }
  if (url.hostname === "claude.ai" || url.hostname === "claude.com") return `Claude (${url.hostname})`;
  return url.host;
}

/** The one page this server ever shows a person: "connect this, yes or no?" */
export function consentPage(redirectUri: string, ticket: string): string {
  const destination = escape(describeDestination(redirectUri));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Power BI</title>
<style>
  :root { color-scheme: light dark; --ink: #10231e; --muted: #4a4a4a; --bg: #fff0e0; --card: #ffffff; --brand: #00725e; }
  @media (prefers-color-scheme: dark) { :root { --ink: #f2f7f5; --muted: #b9c7c2; --bg: #0d1a17; --card: #16302a; --brand: #6ecd96; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
         background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 440px; background: var(--card); border-radius: 20px; padding: 32px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { margin: 0 0 16px; color: var(--muted); }
  strong { color: var(--ink); }
  button { width: 100%; border: 0; border-radius: 12px; padding: 14px; font: inherit; font-weight: 600;
           background: var(--brand); color: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) { button { color: #0d1a17; } }
  small { display: block; margin-top: 16px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Connect to Power BI?</h1>
  <p><strong>${destination}</strong> is asking to query Power BI through this server, using your Microsoft account.</p>
  <p>Only continue if you started this connection yourself just now.</p>
  <form method="post" action="/authorize">
    <input type="hidden" name="ticket" value="${escape(ticket)}">
    <button type="submit">Continue to Microsoft sign-in</button>
  </form>
  <small>Didn't start this? Close this tab and nothing will be connected.</small>
</main>
</body>
</html>`;
}
