import { expect, test } from "@playwright/test";
import { signInViaForm } from "../support/auth";
import { fakeWidgetScript, solve, widgetState } from "../support/fake-turnstile-script";
import { waitForMail } from "../support/mail";
import { failing, passing } from "../support/turnstile";
import { newUser } from "../support/users";
import { register } from "../fixtures";

// The pages, through the browser: the widget appears where the instance has a site
// key, nothing proceeds without a token, and a refused token asks for a new one.
// Cloudflare's script is replaced by a stand-in the test drives.

test.beforeEach(async ({ page }) => {
  await fakeWidgetScript(page);
});

test.describe("sign-up", () => {
  test("shows the check with the site key; Create account waits for it", async ({ page }) => {
    const u = newUser("ui-register");
    await page.goto("/register");
    await expect(page.locator("[data-fake-widget='register']")).toBeAttached();
    expect((await widgetState(page)).renders).toEqual([{ sitekey: "e2e-turnstile-site", action: "register" }]);
    await page.getByLabel("Name").fill(u.name);
    await page.getByLabel("Email").fill(u.email);
    await page.getByLabel("Password").fill(u.password);
    await expect(page.getByRole("button", { name: "Create account" })).toBeDisabled();
    await solve(page, passing());
    await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText(u.email)).toBeVisible();
  });

  test("a refused token shows the error, asks for a new check, and the next one works", async ({ page }) => {
    const u = newUser("ui-refused");
    await page.goto("/register");
    await page.getByLabel("Email").fill(u.email);
    await page.getByLabel("Password").fill(u.password);
    await solve(page, failing());
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(/security check failed/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeDisabled();
    expect((await widgetState(page)).resets).toBe(1);
    await solve(page, passing());
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });

  test("the answer is the same page for an address that already has an account", async ({ page, playwright, baseURL }) => {
    const owner = await playwright.request.newContext({ baseURL });
    const taken = newUser("ui-taken");
    await register(owner, taken, passing());
    await page.goto("/register");
    await page.getByLabel("Email").fill(taken.email);
    await page.getByLabel("Password").fill(newUser().password);
    await solve(page, passing());
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const msgs = await waitForMail(owner, taken.email, 2);
    expect(msgs.map((m) => m.subject)).toContain("Someone tried to sign up with your email address");
    await owner.dispose();
  });

  test("sign-in has no check", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(await widgetState(page)).toBeNull();
  });
});

test.describe("forgot-password", () => {
  test("shows the check; the button waits for it, and the reset mail follows", async ({ page, playwright, baseURL }) => {
    const owner = await playwright.request.newContext({ baseURL });
    const u = newUser("ui-forgot");
    await register(owner, u, passing());
    await page.goto("/forgot-password");
    await expect(page.locator("[data-fake-widget='forgot-password']")).toBeAttached();
    await page.getByLabel("Email").fill(u.email);
    await expect(page.getByRole("button", { name: "Send reset link" })).toBeDisabled();
    await solve(page, passing());
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("status")).toContainText("If there is an account for that address");
    expect((await waitForMail(owner, u.email, 2)).map((m) => m.subject)).toContain("Reset your password");
    await owner.dispose();
  });
});

test.describe("the verify banner", () => {
  test("Resend email shows the check, and solving it sends the mail", async ({ page, playwright, baseURL }) => {
    const u = newUser("ui-banner");
    const owner = await playwright.request.newContext({ baseURL });
    await register(owner, u, passing());
    await signInViaForm(page, u);
    const banner = page.locator(".verify-banner");
    await expect(banner).toBeVisible();
    expect((await widgetState(page))).toBeNull();
    await page.getByRole("button", { name: "Resend email" }).click();
    await expect(banner.locator("[data-fake-widget='resend-verification']")).toBeAttached();
    await solve(page, passing());
    await expect(banner).toContainText(`We sent a new link to ${u.email}`);
    expect(await waitForMail(owner, u.email, 2)).toHaveLength(2);
    await owner.dispose();
  });
});
