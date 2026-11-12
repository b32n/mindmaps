import { readFileSync } from "node:fs";
import { expect, test } from "../fixtures";
import { createBoard, shareBoard } from "../support/api";
import { expectSignedInShell, signInViaForm, signUpViaForm } from "../support/auth";
import { CLOSED_OWNER_CREDS, CLOSED_OWNER_STATE } from "../support/state";
import { newUser, type TestUser } from "../support/users";

// Runs against the second Worker (sign-up closed). See playwright.config.ts and
// wrangler.test-closed.toml. The instance owner was created by closed.setup.ts.

const CLOSED_MESSAGE =
  "Sign-up is closed on this mindmaps. Ask its owner to invite you, or set ALLOW_SIGNUPS=true to open it.";

const owner = (): TestUser => JSON.parse(readFileSync(CLOSED_OWNER_CREDS, "utf8"));

/** An API client signed in as the instance owner. */
async function ownerRequest(playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"], baseURL: string) {
  return playwright.request.newContext({ baseURL, storageState: CLOSED_OWNER_STATE });
}

test.describe("sign-up is closed once the owner exists", () => {
  test("the owner can still sign in through the form", async ({ page }) => {
    const o = owner();
    await signInViaForm(page, o);
    await expectSignedInShell(page, o.name);
  });

  test("a second person is turned away on the sign-up form with the closed message", async ({ page }) => {
    const stranger = newUser("stranger");
    await signUpViaForm(page, stranger);

    await expect(page.locator(".auth-error")).toHaveText(CLOSED_MESSAGE);
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
    expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
  });

  test("the refused person has no account: they cannot sign in either", async ({ page }) => {
    const stranger = newUser("ghost");
    await signUpViaForm(page, stranger);
    await expect(page.locator(".auth-error")).toHaveText(CLOSED_MESSAGE);

    await signInViaForm(page, stranger);
    await expect(page.locator(".auth-error")).toHaveText("Email or password is incorrect.");
  });

  test("the API answers 403 and does not start a session", async ({ request }) => {
    const stranger = newUser("api");
    const res = await request.post("/api/auth/register", {
      data: { email: stranger.email, password: stranger.password, name: stranger.name },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(CLOSED_MESSAGE);
    expect((await (await request.get("/api/auth/me")).json()).user).toBeNull();
  });

  test("password policy and email checks still come first", async ({ request }) => {
    const bad = await request.post("/api/auth/register", {
      data: { email: newUser("x").email, password: "weak", name: "x" },
    });
    expect(bad.status()).toBe(400);
  });

  test("the owner stays signed in on a reload", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: CLOSED_OWNER_STATE });
    const page = await ctx.newPage();
    await page.goto("/app");
    await expect(page.locator(".rail-account .who-name")).toHaveText(owner().name);
    await page.reload();
    await expect(page.locator(".rail-account .who-name")).toHaveText(owner().name);
    await ctx.close();
  });
});

test.describe("an invitation opens the door for that address only", () => {
  test("an invited address can sign up through the form and sees what it was given", async ({ page, playwright, baseURL }) => {
    const guest = newUser("guest");
    const host = await ownerRequest(playwright, baseURL!);
    const board = await createBoard(host, `For ${guest.name}`);
    const invite = await shareBoard(host, board.id, guest.email);
    expect(invite.invited, "an address with no account yet waits as an invite").toBeTruthy();

    await signUpViaForm(page, guest);
    await expectSignedInShell(page, guest.name);
    await expect(page.getByRole("button", { name: `For ${guest.name}` })).toBeVisible();
    await host.dispose();
  });

  test("the invite is matched case-insensitively", async ({ page, playwright, baseURL }) => {
    const guest = newUser("case");
    const host = await ownerRequest(playwright, baseURL!);
    const board = await createBoard(host, "Case board");
    await shareBoard(host, board.id, guest.email.toUpperCase());

    await signUpViaForm(page, guest);
    await expectSignedInShell(page, guest.name);
    await host.dispose();
  });

  test("someone else is still refused while a different address is invited", async ({ page, playwright, baseURL }) => {
    const invited = newUser("invited");
    const host = await ownerRequest(playwright, baseURL!);
    await shareBoard(host, (await createBoard(host, "Only for the other one")).id, invited.email);

    await signUpViaForm(page, newUser("bystander"));
    await expect(page.locator(".auth-error")).toHaveText(CLOSED_MESSAGE);
    await host.dispose();
  });

  test("a revoked invitation no longer works", async ({ page, playwright, baseURL }) => {
    const guest = newUser("revoked");
    const host = await ownerRequest(playwright, baseURL!);
    const invite = await shareBoard(host, (await createBoard(host, "Revoked")).id, guest.email);
    const token = (invite.invited as { token: string }).token;
    expect((await host.delete(`/api/invites/${token}`)).ok()).toBe(true);

    await signUpViaForm(page, guest);
    await expect(page.locator(".auth-error")).toHaveText(CLOSED_MESSAGE);
    await host.dispose();
  });

  test("an invited person who signs up can sign in again later", async ({ page, playwright, baseURL, browser }) => {
    const guest = newUser("returning");
    const host = await ownerRequest(playwright, baseURL!);
    await shareBoard(host, (await createBoard(host, "Return")).id, guest.email);
    await signUpViaForm(page, guest);
    await expectSignedInShell(page, guest.name);

    const again = await browser.newContext();
    const second = await again.newPage();
    await signInViaForm(second, guest);
    await expectSignedInShell(second, guest.name);
    await again.close();
    await host.dispose();
  });
});
