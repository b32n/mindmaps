// An MCP client for tests: the real OAuth flow (register, authorize, token with
// PKCE) and JSON-RPC over POST /mcp, against the same Worker as everything else.
// The person approving is whoever `request` is signed in as; there is no
// test-only path, the "Approve" press is the POST the consent page makes.
import { createHash, randomBytes } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";

const REDIRECT = "http://127.0.0.1:9/callback";

export interface McpClient {
  /** Calls a tool; resolves with the text the agent would read and whether it was an error. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Trade the refresh token in, as a harness does when the access token runs out; the old pair stops working. */
  refresh(): Promise<McpClient>;
  /** The pair this client holds, for tests that restart the Worker and carry on. */
  credentials: { clientId: string; accessToken: string; refreshToken: string };
}

export interface ConnectOptions {
  /** The name the client registers under; shown as the author of what it writes. */
  clientName?: string;
  /** The workspace picked on the consent page. Omitted: the page's default, as pressing Approve unchanged. */
  workspace?: string;
}

/** The consent page a signed-in person is shown, as the browser would get it. */
export async function consentPage(request: APIRequestContext): Promise<string> {
  const { query } = await startAuthorize(request);
  const res = await request.get(`/oauth/authorize?${query}`, { maxRedirects: 0 });
  expect(res.status(), "consent page").toBe(200);
  return await res.text();
}

async function startAuthorize(request: APIRequestContext, clientName = "e2e") {
  const reg = await request.post("/oauth/register", { data: { client_name: clientName, redirect_uris: [REDIRECT] } });
  expect(reg.status(), "register client").toBe(201);
  const clientId = (await reg.json()).client_id as string;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
  });
  return { clientId, verifier, query };
}

/** Connect an MCP client on behalf of the person `request` is signed in as. */
export async function connectMcp(request: APIRequestContext, opts: ConnectOptions = {}): Promise<McpClient> {
  const { clientId, verifier, query } = await startAuthorize(request, opts.clientName);
  // The consent form's one field is the workspace select, posted urlencoded.
  const approved = await request.post(`/oauth/authorize?${query}`, {
    maxRedirects: 0,
    ...(opts.workspace ? { form: { workspace: opts.workspace } } : {}),
  });
  expect(approved.status(), `approve: ${await approved.text()}`).toBe(302);
  const code = new URL(approved.headers()["location"]!).searchParams.get("code")!;

  const tokenRes = await request.post("/oauth/token", {
    form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT },
  });
  expect(tokenRes.status(), `token: ${await tokenRes.text()}`).toBe(200);
  const tokens = await tokenRes.json();
  return clientFor(request, clientId, tokens.access_token, tokens.refresh_token);
}

/** A client for tokens that already exist, e.g. after the Worker was restarted. */
export function clientFor(request: APIRequestContext, clientId: string, accessToken: string, refreshToken: string): McpClient {
  let n = 0;
  return {
    credentials: { clientId, accessToken, refreshToken },
    async call(name, args) {
      // `request` carries a session cookie; the MCP endpoint must be reached on the
      // bearer token alone, as a real harness would.
      const res = await request.post("/mcp", {
        headers: { authorization: `Bearer ${accessToken}`, cookie: "", accept: "application/json, text/event-stream" },
        data: { jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } },
      });
      expect(res.status(), `mcp ${name}: ${await res.text()}`).toBe(200);
      const result = (await res.json()).result;
      return { text: String(result?.content?.[0]?.text ?? ""), isError: !!result?.isError };
    },
    async refresh() {
      const r = await request.post("/oauth/token", {
        form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId },
      });
      expect(r.status(), `refresh: ${await r.text()}`).toBe(200);
      const t = await r.json();
      return clientFor(request, clientId, t.access_token, t.refresh_token);
    },
  };
}
