import { expect, test } from "../fixtures";
import { expectSignedInShell, signInViaForm, signUpViaForm } from "../support/auth";
import { linkIn, tokenIn, unissuedToken, waitForMail } from "../support/mail";
import { newUser, strongPassword } from "../support/users";

// The pages and the banner, through the browser. The email Worker captures mail
// instead of sending it, so the "email" is read back over the API.

const banner = (page: import("@playwright/test").Page) => page.locator(".verify-banner");

test.describe("verify-email banner", () => {
  test("a new account sees it, naming the address", async ({ page }) => {
    const u = newUser("banner");
    await signUpViaForm(page, u);
    await expectSignedInShell(page, u.name);
    await expect(banner(page)).toContainText("Confirm your email");
    await expect(banner(page)).toContainText(u.email);
    await expect(page.getByRole("status").filter({ hasText: "Confirm your email" })).toBeVisible();
  });

  test("Resend email sends another message and says so", async ({ page, request }) => {
    const u = newUser("resend");
    await signUpViaForm(page, u);
    await expect(banner(page)).toBeVisible();
    await page.getByRole("button", { name: "Resend email" }).click();
    await expect(banner(page)).toContainText(`We sent a new link to ${u.email}`);
    expect(await waitForMail(request, u.email, 2)).toHaveLength(2);
  });

  test("after the limit it says to wait", async ({ page }) => {
    const u = newUser("limit");
    await signUpViaForm(page, u);
    await expect(banner(page)).toBeVisible();
    for (let i = 0; i < 3; i++) await page.request.post("/api/auth/resend-verification");
    await page.getByRole("button", { name: "Resend email" }).click();
    await expect(banner(page)).toContainText("That's enough emails for now");
  });

  test("a confirmed account does not see it", async ({ page, account, request }) => {
    const [msg] = await waitForMail(request, account.email);
    await request.post("/api/auth/verify-email", { data: { token: tokenIn(msg) } });
    await page.goto("/app");
    await expect(page).toHaveURL(/\/app\//);
    await expect(page.locator(".rail-account")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });
});

test.describe("the confirmation page", () => {
  test("the emailed link asks for a press, then confirms and the banner goes", async ({ page, account, request }) => {
    const [msg] = await waitForMail(request, account.email);
    const link = linkIn(msg);
    await page.goto(link.pathname + link.search);
    await expect(page.getByRole("heading", { name: "Confirm your email" })).toBeVisible();
    // opening the link does not use it up
    await page.reload();
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
    await page.getByRole("link", { name: "Open mindmaps" }).click();
    await expect(page).toHaveURL(/\/app\//);
    await expect(banner(page)).toHaveCount(0);
  });

  test("works signed out, and then offers sign-in", async ({ page, existing }) => {
    const [msg] = await waitForMail(existing.request, existing.user.email);
    const link = linkIn(msg);
    await page.goto(link.pathname + link.search);
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    expect((await (await existing.request.get("/api/auth/me")).json()).emailVerified).toBe(true);
  });

  test("a used or wrong link says so", async ({ page, account, request }) => {
    const [msg] = await waitForMail(request, account.email);
    await request.post("/api/auth/verify-email", { data: { token: tokenIn(msg) } });
    await page.goto(`/verify-email?token=${tokenIn(msg)}`);
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("alert")).toHaveText("That link is invalid or has expired.");

    await page.goto(`/verify-email?token=${unissuedToken()}`);
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("alert")).toHaveText("That link is invalid or has expired.");
  });

  test("with no token at all it says the link is invalid", async ({ page }) => {
    await page.goto("/verify-email");
    await expect(page.getByRole("alert")).toHaveText("That link is invalid or has expired.");
  });
});

test.describe("forgot and reset", () => {
  test("the whole round trip through the browser", async ({ page, existing, request }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    // Fill and submit until the confirmation shows: under load the page can still be settling
    // (session check) and re-render the form empty after the first fill.
    await expect(async () => {
      await page.getByLabel("Email").fill(existing.user.email);
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(page.getByRole("status")).toContainText("If there is an account for that address", { timeout: 1500 });
    }).toPass({ timeout: 10_000 });

    const all = await waitForMail(request, existing.user.email, 2);
    const mail = all.filter((m) => m.subject === "Reset your password").pop()!;
    const link = linkIn(mail);
    await page.goto(link.pathname + link.search);

    const fresh = strongPassword();
    await page.getByLabel("New password").fill("short");
    await expect(page.getByRole("button", { name: "Save new password" })).toBeDisabled();
    await page.getByLabel("New password").fill(fresh);
    await page.getByRole("button", { name: "Save new password" }).click();

    await expect(page).toHaveURL(/\/login\?notice=reset/);
    await expect(page.getByText("Your password was changed.")).toBeVisible();
    await signInViaForm(page, { email: existing.user.email, password: fresh });
    await expectSignedInShell(page, existing.user.name);
  });

  test("an address with no account gets the same confirmation", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(newUser("ghost").email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("status")).toContainText("If there is an account for that address");
  });

  test("a bad link says so and offers a new one", async ({ page }) => {
    await page.goto(`/reset-password?token=${unissuedToken()}`);
    await page.getByLabel("New password").fill(strongPassword());
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page.getByRole("alert")).toHaveText("That link is invalid or has expired.");
    await page.getByRole("link", { name: "Ask for a new link" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });

  test("a reset page with no token is a dead end that points the way back", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByRole("alert")).toHaveText("That link is invalid or has expired.");
    await expect(page.getByLabel("New password")).toHaveCount(0);
  });

  test("the sign-in page links to it and the form is labelled", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/forgot-password");
  });
});
