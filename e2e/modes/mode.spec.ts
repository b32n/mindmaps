import { request as pwRequest } from "@playwright/test";
import { expect, register, test } from "../fixtures";
import { createBoard, listBoards } from "../support/api";
import { connectMcp } from "../support/mcp";
import { newUser } from "../support/users";
import { MAIN_PORT, MODE_CASES, modeWorkers, type ModeCase } from "../support/hosts";

// MINDMAPS_MODE, read from the environment and shown to the app and to MCP
// clients. These specs pin what is exposed, and the basics every mode shares.
// What personal mode hides is in personal.spec.ts; that the other modes keep
// everything in unchanged.spec.ts; switching an install in switch.spec.ts.
//
// Each case has its own Worker (playwright.config.ts). The main Worker leaves the
// var unset, which must behave as multitenant.

type Mode = "personal" | "org" | "multitenant";

const SETUPS: { name: string; baseURL: string; expects: Mode }[] = [
  { name: "unset", baseURL: `http://127.0.0.1:${MAIN_PORT}`, expects: "multitenant" },
  { name: "personal", baseURL: modeWorkers.personal.baseURL, expects: "personal" },
  { name: "org", baseURL: modeWorkers.org.baseURL, expects: "org" },
  { name: "multitenant", baseURL: modeWorkers.multitenant.baseURL, expects: "multitenant" },
  { name: "empty", baseURL: modeWorkers.empty.baseURL, expects: "multitenant" },
];

for (const setup of SETUPS) {
  test.describe(`MINDMAPS_MODE ${setup.name} is ${setup.expects}`, () => {
    test.use({ baseURL: setup.baseURL });

    test("the session endpoint says so, signed out and signed in", async ({ request, account }) => {
      const out = await (await request.get("/api/auth/me", { headers: { cookie: "" } })).json();
      expect(out.user).toBeNull();
      expect(out.mode).toBe(setup.expects);

      const me = await (await request.get("/api/auth/me")).json();
      expect(me.user.email).toBe(account.email);
      expect(me.mode).toBe(setup.expects);
      expect(me.googleEnabled).toBe(false);
    });

    test("the app has it available, and still works", async ({ page, account }) => {
      void account;
      await page.goto("/app");
      await expect(page.locator("html")).toHaveAttribute("data-mindmaps-mode", setup.expects);
      await expect(page.locator(".boot")).toHaveCount(0);
      expect(page.url()).toContain("/app");
    });

    test("a signed-out visitor sees the mode too, on the sign-in page", async ({ page }) => {
      await page.goto("/login");
      await expect(page.locator("html")).toHaveAttribute("data-mindmaps-mode", setup.expects);
    });

    test("the data model is unchanged: boards are created and listed as before", async ({ request, account }) => {
      void account;
      const board = await createBoard(request, "Mode check");
      expect((await listBoards(request)).map((b) => b.id)).toContain(board.id);
    });

    test("MCP says so in its handshake without changing the tools", async ({ request, account }) => {
      void account;
      const client = await connectMcp(request);
      const post = async (method: string, params: object = {}) => {
        const res = await request.post("/mcp", {
          headers: {
            authorization: `Bearer ${client.credentials.accessToken}`,
            cookie: "",
            accept: "application/json, text/event-stream",
          },
          data: { jsonrpc: "2.0", id: 1, method, params },
        });
        expect(res.status()).toBe(200);
        return (await res.json()).result;
      };

      const init = await post("initialize", { protocolVersion: "2025-06-18" });
      expect(init._meta).toEqual({ "mindmaps/mode": setup.expects });
      expect(init.serverInfo.name).toBeTruthy();
      expect(init.serverInfo).not.toHaveProperty("mode");
      expect((await post("server/discover"))._meta).toEqual({ "mindmaps/mode": setup.expects });

      // tools/list offers the same tools in every mode (personal only drops the
      // `workspace` argument, see personal.spec.ts)
      const tools = (await post("tools/list")).tools as { name: string }[];
      expect(tools.map((t) => t.name).sort()).toEqual(await mainToolNames());
    });
  });
}

/** The tool names the main (unset) Worker offers: the reference every mode must match. */
async function mainToolNames(): Promise<string[]> {
  return (await toolNamesAt(`http://127.0.0.1:${MAIN_PORT}`)).sort();
}

async function toolNamesAt(baseURL: string): Promise<string[]> {
  const ctx = await pwRequest.newContext({ baseURL });
  try {
    await register(ctx, newUser("tools"));
    const client = await connectMcp(ctx);
    const res = await ctx.post("/mcp", {
      headers: {
        authorization: `Bearer ${client.credentials.accessToken}`,
        cookie: "",
        accept: "application/json, text/event-stream",
      },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    return ((await res.json()).result.tools as { name: string }[]).map((t) => t.name);
  } finally {
    await ctx.dispose();
  }
}

test.describe("an invalid MINDMAPS_MODE fails loudly", () => {
  test.use({ baseURL: modeWorkers.invalid.baseURL });
  const message = /MINDMAPS_MODE is "personnal".*personal, org, multitenant.*docs\/MODES\.md/;

  test("every API answer is a 500 naming the variable and the allowed values", async ({ request }) => {
    for (const path of ["/api/auth/me", "/api/boards", "/mcp", "/oauth/authorize", "/.well-known/oauth-authorization-server"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(500);
      const body = await res.json();
      expect(body.code, path).toBe("invalid_mode");
      expect(body.error, path).toMatch(message);
    }
  });

  test("the account export and deletion routes are behind the same gate", async ({ request }) => {
    const exp = await request.get("/api/account/export");
    expect(exp.status()).toBe(500);
    expect((await exp.json()).code).toBe("invalid_mode");
    const del = await request.delete("/api/account", { data: { email: "x@example.test" } });
    expect(del.status()).toBe(500);
    expect((await del.json()).code).toBe("invalid_mode");
  });

  test("sign-up and sign-in are refused, not silently allowed", async ({ request }) => {
    const reg = await request.post("/api/auth/register", {
      data: { email: "x@example.test", password: "Aa1!aaaaaaaaaaaa", name: "x" },
    });
    expect(reg.status()).toBe(500);
    expect((await reg.json()).code).toBe("invalid_mode");
    const login = await request.post("/api/auth/login", { data: { email: "x@example.test", password: "nope" } });
    expect(login.status()).toBe(500);
  });

  test("preflight requests still answer, so a browser can read the error", async ({ request }) => {
    const res = await request.fetch("/api/auth/me", { method: "OPTIONS" });
    expect(res.status()).toBe(200);
    const err = await request.get("/api/auth/me");
    expect(err.headers()["access-control-allow-origin"]).toBe("*");
  });

  test("the page loads and its sign-in form shows the problem", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("x@example.test");
    await page.getByLabel(/password/i).first().fill("Aa1!aaaaaaaaaaaa");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.locator(".auth-error")).toContainText('MINDMAPS_MODE is "personnal"');
  });
});

test("every mode case has a Worker, and the invalid one is not a valid mode", () => {
  expect(MODE_CASES.length).toBe(5);
  const invalid: ModeCase = "invalid";
  expect(["personal", "org", "multitenant"]).not.toContain(modeWorkers[invalid].value);
});
