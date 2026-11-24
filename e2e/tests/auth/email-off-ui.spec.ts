import { expect, test } from "../../fixtures";
import { expectSignedInShell, signUpViaForm } from "../../support/auth";
import { newUser } from "../../support/users";

// Email not configured (the main test Worker): the pages that need mail say so,
// and nothing nags about confirming an address nobody can confirm.

test("no banner after sign-up, and no forgot-password link on sign-in", async ({ page }) => {
  const u = newUser("off-ui");
  await signUpViaForm(page, u);
  await expectSignedInShell(page, u.name);
  await expect(page.locator(".verify-banner")).toHaveCount(0);

  await page.request.post("/api/auth/logout");
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot your password?" })).toHaveCount(0);
});

test("the forgot-password page explains that email is not set up", async ({ page }) => {
  await page.goto("/forgot-password");
  await expect(page.getByRole("alert")).toContainText("can't send email");
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
