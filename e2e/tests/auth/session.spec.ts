import { test, expect } from "../../fixtures";
import { createBoard } from "../../support/api";
import { signInViaForm } from "../../support/auth";

test.describe("sign out", () => {
  test("ends the session and returns to the sign-in form", async ({ page, account }) => {
    await page.goto("/app");
    await expect(page.locator(".rail-account .who-name")).toHaveText(account.name);

    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page).toHaveURL(/\/login$/);
    expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
    expect((await page.request.get("/api/boards")).status()).toBe(401);
  });

  test("stays signed out after a reload and on protected pages", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("revokes the session on the server, not just in the browser", async ({ page, account, context }) => {
    void account;
    await page.goto("/app");
    const [cookie] = (await context.cookies()).filter((c) => c.name === "wb_session");
    expect(cookie).toBeTruthy();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // replay the old cookie: the token itself must be dead
    await context.addCookies([cookie]);
    expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
  });

  test("signing back in works", async ({ page, account }) => {
    await page.goto("/app");
    await page.getByRole("button", { name: "Sign out" }).click();
    await signInViaForm(page, account);
    await expect(page.locator(".rail-account .who-name")).toHaveText(account.name);
  });

  test("signing out one browser does not sign out another", async ({ page, browser, account }) => {
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signInViaForm(otherPage, account);
    await expect(otherPage).toHaveURL(/\/app\//);

    await page.goto("/app");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await otherPage.reload();
    await expect(otherPage.locator(".rail-account .who-name")).toHaveText(account.name);
    await other.close();
  });
});

test.describe("session persistence", () => {
  test("survives a reload on the same page", async ({ page, account }) => {
    await page.goto("/app");
    await expect(page.locator(".rail-account .who-name")).toHaveText(account.name);
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(page.locator(".rail-account .who-name")).toHaveText(account.name);
  });

  test("is shared by new tabs of the same browser", async ({ context, account }) => {
    const tab = await context.newPage();
    await tab.goto("/app");
    await expect(tab.locator(".rail-account .who-name")).toHaveText(account.name);
  });

  test("lives in an HttpOnly, SameSite=Lax cookie that scripts cannot read", async ({ page, context, account }) => {
    void account;
    await page.goto("/app");
    const [cookie] = (await context.cookies()).filter((c) => c.name === "wb_session");
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.path).toBe("/");
    // roughly 30 days out
    const days = (cookie.expires - Date.now() / 1000) / 86_400;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
    expect(await page.evaluate(() => document.cookie)).not.toContain("wb_session");
  });

  test("restoring saved cookies in a fresh browser context is still signed in", async ({ browser, context, account }) => {
    const state = await context.storageState();
    const fresh = await browser.newContext({ storageState: state });
    const page = await fresh.newPage();
    await page.goto("/app");
    await expect(page.locator(".rail-account .who-name")).toHaveText(account.name);
    await fresh.close();
  });

  test("a forged or cleared session cookie means signed out", async ({ page, context, account, baseURL }) => {
    void account;
    await context.addCookies([{ name: "wb_session", value: "0".repeat(64), url: baseURL! }]);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login$/);

    await context.clearCookies();
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("sessions are per user: two accounts in two contexts never see each other's data", async ({ page, existing, account }) => {
    void account;
    await createBoard(page.request, "Mine only");
    await page.goto("/app");
    await expect(page.getByRole("button", { name: "Mine only" })).toBeVisible();

    const theirs = await (await existing.request.get("/api/boards")).json();
    expect(theirs.map((b: { name: string }) => b.name)).not.toContain("Mine only");
  });
});
