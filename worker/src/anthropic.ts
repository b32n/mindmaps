// Thin client for the Anthropic Managed Agents beta.
// Plain fetch rather than the SDK — keeps the Worker bundle small and avoids
// Node-shim issues on workerd.

const API = "https://api.anthropic.com";
const MA_BETA = "managed-agents-2026-04-01";
const FILES_BETA = "files-api-2025-04-14";

export interface Repo {
  url: string;
  mount_path?: string;
  branch?: string;
}

export interface Credentials {
  /** long-lived API key */
  apiKey?: string;
  /** short-lived OAuth access token from `ant auth print-credentials` */
  authToken?: string;
}

export class Anthropic {
  constructor(private creds: Credentials) {
    if (!creds.apiKey && !creds.authToken) {
      throw new Error("no Anthropic credentials configured");
    }
  }

  /**
   * OAuth tokens and API keys use DIFFERENT headers — a token sent as
   * `x-api-key` is rejected. A bearer token also requires the
   * `oauth-2025-04-20` beta on top of whatever betas the call needs.
   */
  private auth(betas: string[]): Record<string, string> {
    if (this.creds.authToken) {
      return {
        authorization: `Bearer ${this.creds.authToken}`,
        "anthropic-beta": [...betas, "oauth-2025-04-20"].join(","),
      };
    }
    return {
      "x-api-key": this.creds.apiKey!,
      "anthropic-beta": betas.join(","),
    };
  }

  private async call(path: string, init: RequestInit = {}, betas = [MA_BETA]) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...this.auth(betas),
        ...(init.headers as Record<string, string>),
      },
    });
    if (!res.ok) {
      throw new Error(`anthropic ${path} ${res.status}: ${await res.text()}`);
    }
    return res.json<any>();
  }

  // --- setup (run once; store the returned id) -----------------------------

  /**
   * Research agent. Read-only by design: `edit` is disabled, `write` stays so
   * the agent can produce deliverables in /mnt/session/outputs/.
   */
  createAgent(name = "Workstream Researcher") {
    return this.call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        name,
        model: "claude-opus-5",
        system: [
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
        ].join("\n"),
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: true },
            configs: [{ name: "edit", enabled: false }],
          },
        ],
      }),
    });
  }

  createEnvironment(name = "workstream-board") {
    return this.call("/v1/environments", {
      method: "POST",
      body: JSON.stringify({
        name,
        config: { type: "cloud", networking: { type: "unrestricted" } },
      }),
    });
  }

  // --- per-card runtime ----------------------------------------------------

  createSession(opts: {
    agentId: string;
    environmentId: string;
    title: string;
    brief: string;
    repos: Repo[];
    githubToken?: string;
  }) {
    const resources = opts.githubToken
      ? opts.repos.map((r) => ({
          type: "github_repository",
          url: r.url,
          mount_path: r.mount_path ?? `/workspace/${r.url.split("/").pop()}`,
          authorization_token: opts.githubToken,
          ...(r.branch ? { checkout: { type: "branch", name: r.branch } } : {}),
        }))
      : [];

    return this.call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        agent: opts.agentId,
        environment_id: opts.environmentId,
        title: opts.title,
        resources,
        // starts the agent loop in the same call — session is created `running`
        initial_events: [
          { type: "user.message", content: [{ type: "text", text: opts.brief }] },
        ],
      }),
    });
  }

  /** Resume: same session id, another user message. No transcript to restore. */
  sendMessage(sessionId: string, text: string) {
    return this.call(`/v1/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      }),
    });
  }

  getSession(sessionId: string) {
    return this.call(`/v1/sessions/${sessionId}`);
  }

  listEvents(sessionId: string, page?: string) {
    const q = page ? `?page=${encodeURIComponent(page)}` : "";
    return this.call(`/v1/sessions/${sessionId}/events${q}`);
  }

  /** Files the agent wrote to /mnt/session/outputs/. Needs BOTH beta headers. */
  listOutputs(sessionId: string) {
    return this.call(
      `/v1/files?scope_id=${encodeURIComponent(sessionId)}`,
      {},
      [MA_BETA, FILES_BETA],
    );
  }
}

/** Pull the readable text out of an events page. */
export function textFromEvents(events: any[]): string {
  return events
    .filter((e) => e.type === "agent.message")
    .flatMap((e) => (e.content ?? []).filter((b: any) => b.type === "text"))
    .map((b: any) => b.text)
    .join("\n");
}
