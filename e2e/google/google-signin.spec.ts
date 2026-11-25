import { test, expect, register } from "../fixtures";
import { googleWorker } from "../support/hosts";
import { expectSignedInShell } from "../support/auth";
import { newUser } from "../support/users";

// Runs against the Worker whose Google endpoints are faked
// (wrangler.test-google.toml, e2e/support/google-entry.ts).

test.use({ baseURL: googleWorker.baseURL });

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Walk the real start -> callback flow; `code` carries the Google identity. */
async function googleSignIn(page: import("@playwright/test").Page, who: { sub: string; email: string; name: string }) {
  const start = await page.request.get("/api/auth/google", { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  const state = new URL(start.headers()["location"]).searchParams.get("state")!;
  await page.goto(`/api/auth/google/callback?code=${b64url(who)}&state=${state}`);
}

const boards = async (page: import("@playwright/test").Page) =>
  (await (await page.request.get("/api/boards")).json()) as { id: string; name: string }[];

test.describe("Google sign-in", () => {
  test("a first sign-in gets the same starter board as a password sign-up", async ({ page }) => {
    const who = newUser("google");
    await googleSignIn(page, { sub: `sub-${who.email}`, email: who.email, name: who.name });

    await expectSignedInShell(page, who.name);
    await expect(page.getByRole("heading", { level: 1, name: "Start here" })).toBeVisible();
    await expect(page.locator(".rail-row .rail-name")).toHaveText(["Start here"]);

    // same content as a password account's starter board
    const pw = newUser("pw");
    const other = await page.context().browser()!.newContext({ baseURL: googleWorker.baseURL });
    try {
      await register(other.request, pw);
      const mine = await boards(page);
      const theirs = (await (await other.request.get("/api/boards")).json()) as { id: string; name: string }[];
      expect(mine.map((b) => b.name)).toEqual(theirs.map((b) => b.name));
      const count = async (r: typeof page.request, id: string) =>
        ((await (await r.get(`/api/boards/${id}/contents`)).json()) as any).nodes?.length;
      expect(await count(page.request, mine[0].id)).toBe(await count(other.request, theirs[0].id));
      expect(await count(page.request, mine[0].id)).toBeGreaterThan(0);
    } finally {
      await other.close();
    }
  });

  test("a returning Google user is unchanged: same board, no second starter", async ({ page, context }) => {
    const who = newUser("google-again");
    const identity = { sub: `sub-${who.email}`, email: who.email, name: who.name };
    await googleSignIn(page, identity);
    const first = await boards(page);
    expect(first.map((b) => b.name)).toEqual(["Start here"]);

    await context.clearCookies();
    await googleSignIn(page, identity);
    await expectSignedInShell(page, who.name);
    expect(await boards(page)).toEqual(first);
  });

  test("a password account that signs in with Google keeps its single starter board", async ({ page }) => {
    const who = newUser("linked");
    await register(page.request, who);
    const before = await boards(page);
    await page.context().clearCookies();

    await googleSignIn(page, { sub: `sub-${who.email}`, email: who.email, name: who.name });
    await expectSignedInShell(page, who.name);
    expect(await boards(page)).toEqual(before);
  });
});
