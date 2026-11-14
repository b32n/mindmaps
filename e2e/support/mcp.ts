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
}

/** Connect an MCP client on behalf of the person `request` is signed in as. */
export async function connectMcp(request: APIRequestContext): Promise<McpClient> {
  const reg = await request.post("/oauth/register", { data: { client_name: "e2e", redirect_uris: [REDIRECT] } });
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
  const approved = await request.post(`/oauth/authorize?${query}`, { maxRedirects: 0 });
  expect(approved.status(), "approve").toBe(302);
  const code = new URL(approved.headers()["location"]!).searchParams.get("code")!;

  const tokenRes = await request.post("/oauth/token", {
    form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT },
  });
  expect(tokenRes.status(), `token: ${await tokenRes.text()}`).toBe(200);
  const accessToken = (await tokenRes.json()).access_token as string;

  let n = 0;
  return {
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
  };
}
