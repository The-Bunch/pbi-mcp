# Security policy

PBI MCP sits between an AI model and real business data, so we take reports
seriously.

## Reporting a vulnerability

Please **don't open a public issue.** Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/The-Bunch/pbi-mcp/security/advisories/new).

Tell us what you found, how to reproduce it and what an attacker could do with it.
We'll acknowledge it within a few working days, keep you posted while we fix it,
and credit you in the advisory if you'd like.

## Scope

In scope: this repository's code — the OAuth relay, token verification, the
redirect allow-list, the MCP tools and anything that could leak secrets, tokens or
query results.

Out of scope: how a particular deployment is configured (for example, exposing a
workspace to more people than intended), Microsoft Entra ID, Power BI, Firebase and
MCP clients themselves. Please report issues in those to their vendors.

## Supported versions

Only the latest release on `main` gets security fixes.
