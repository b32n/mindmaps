#!/usr/bin/env node
// One-time setup: create the Managed Agent + environment, print their IDs.
//
// Agents are PERSISTENT, versioned resources — created once and reused for
// every session. Never create one in the request path.
//
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/setup.mjs

// Either a long-lived API key, or a short-lived OAuth token from
//   ant auth login && ant auth print-credentials --access-token
const API_KEY = process.env.ANTHROPIC_API_KEY;
const AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
if (!API_KEY && !AUTH_TOKEN) {
  console.error("set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN");
  process.exit(1);
}

// OAuth tokens go on Authorization: Bearer (never x-api-key) and need the
// oauth beta alongside the managed-agents one.
const AUTH = AUTH_TOKEN
  ? {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "anthropic-beta": "managed-agents-2026-04-01,oauth-2025-04-20",
    }
  : {
      "x-api-key": API_KEY,
      "anthropic-beta": "managed-agents-2026-04-01",
    };

const call = async (path, body) => {
  const res = await fetch(`https://api.anthropic.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...AUTH,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json();
};

const SYSTEM = [
  "You are a research assistant for an engineering leader running many",
  "parallel workstreams. You have read-only access to mounted git repos",
  "under /workspace, plus web search.",
  "",
  "Use bash, grep, and glob to trace across repos, and git log/blame for",
  "history. You cannot push; do not try.",
  "",
  "Lead with the outcome. Write for someone who did not watch you work:",
  "complete sentences, terms spelled out, no shorthand or arrow chains.",
  "Write substantial deliverables to /mnt/session/outputs/ as markdown.",
].join("\n");

const agent = await call("/v1/agents", {
  name: "Workstream Researcher",
  model: "claude-opus-5",
  system: SYSTEM,
  tools: [
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: true },
      // read-only research: no edit. `write` stays for /mnt/session/outputs/.
      configs: [{ name: "edit", enabled: false }],
    },
  ],
});

const env = await call("/v1/environments", {
  name: `workstream-board-${Date.now()}`,
  config: { type: "cloud", networking: { type: "unrestricted" } },
});

console.log(`
Created:
  agent        ${agent.id}  (v${agent.version})
  environment  ${env.id}

Store them as Worker secrets:
  npx wrangler secret put ANTHROPIC_AGENT_ID         # ${agent.id}
  npx wrangler secret put ANTHROPIC_ENVIRONMENT_ID   # ${env.id}
  npx wrangler secret put ANTHROPIC_API_KEY
  npx wrangler secret put GITHUB_TOKEN               # Contents: Read ONLY

For local dev, put the same keys in worker/.dev.vars
`);
