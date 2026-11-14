import { expect, type Page } from "@playwright/test";
import type { TestUser } from "./users";

/** Fill and submit the sign-in form at /login. */
export async function signInViaForm(page: Page, user: Pick<TestUser, "email" | "password">) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Fill and submit the sign-up form at /register. */
export async function signUpViaForm(page: Page, user: TestUser) {
  await page.goto("/register");
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
}

/** The signed-in shell is up: the rail shows the account and the starter map. */
export async function expectSignedInShell(page: Page, who: string) {
  await expect(page).toHaveURL(/\/app\//);
  await expect(page.locator(".rail-account .who-name")).toHaveText(who);
}
