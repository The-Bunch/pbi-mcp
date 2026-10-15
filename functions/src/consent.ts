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
  /* helloBill DS (10.26): Soft oat (light) and Warm night (dark) */
  :root { color-scheme: light dark; --bill-oat: #f8f2ea; --bill-surface: #ffffff; --bill-ink: #14302a;
          --bill-ink-soft: #456258; --bill-emerald: #00725e; --bill-line: #cfc6b8; --bill-logo-hello: #00725e; --bill-logo-bill: #3e8e68; }
  @media (prefers-color-scheme: dark) {
    :root { --bill-oat: #191512; --bill-surface: #231e1a; --bill-ink: #f4ece3; --bill-ink-soft: #b8ab9c;
            --bill-emerald: #3dbd94; --bill-line: #3a332b; --bill-logo-hello: #3e8e68; --bill-logo-bill: #6ecd96; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bill-oat);
         color: var(--bill-ink); font: 16px/1.55 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 440px; background: var(--bill-surface); border: 1px solid var(--bill-line);
         border-radius: 24px; padding: 32px; }
  h1 { font: 800 26px/1.1 "Bricolage Grotesque", Inter, sans-serif; letter-spacing: -0.03em; margin: 0 0 12px; }
  p { margin: 0 0 16px; color: var(--bill-ink-soft); }
  strong { color: var(--bill-ink); }
  button { width: 100%; border: 0; border-radius: 999px; padding: 14px; font: inherit; font-weight: 600;
           background: var(--bill-emerald); color: var(--bill-oat); cursor: pointer; }
  button:focus-visible { outline: 3px solid var(--bill-emerald); outline-offset: 3px; }
  small { display: block; margin-top: 16px; color: var(--bill-ink-soft); }
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
