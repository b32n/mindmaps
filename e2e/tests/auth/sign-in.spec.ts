import { test, expect } from "../../fixtures";
import { expectSignedInShell, signInViaForm } from "../../support/auth";
import { createBoard } from "../../support/api";
import { newUser } from "../../support/users";

test.describe("sign in", () => {
  test("signs in with the right credentials and lands on the first mindmap", async ({ page, existing }) => {
    await signInViaForm(page, existing.user);
    await expectSignedInShell(page, existing.user.name);
    await expect(page.getByRole("heading", { level: 1, name: "Start here" })).toBeVisible();
  });

  test("the email is matched case-insensitively", async ({ page, existing }) => {
    await signInViaForm(page, { ...existing.user, email: existing.user.email.toUpperCase() });
    await expectSignedInShell(page, existing.user.name);
  });

  test("a wrong password shows one generic message and keeps you on the form", async ({ page, existing }) => {
    await signInViaForm(page, { ...existing.user, password: existing.user.password + "x" });

    await expect(page.locator(".auth-error")).toHaveText("Email or password is incorrect.");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Email")).toHaveValue(existing.user.email);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
  });

  test("an unknown email gets the same message as a wrong password", async ({ page }) => {
    await signInViaForm(page, newUser("ghost"));
    await expect(page.locator(".auth-error")).toHaveText("Email or password is incorrect.");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("after a failure the correct password still works and the error clears", async ({ page, existing }) => {
    await signInViaForm(page, { ...existing.user, password: "Wrong-password-1!" });
    await expect(page.locator(".auth-error")).toBeVisible();

    await page.getByLabel("Password").fill(existing.user.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedInShell(page, existing.user.name);
  });

  test("both fields are required by the form", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByLabel("Email")).toHaveJSProperty("validity.valueMissing", true);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("shows the error handed over in ?error= (e.g. a failed Google sign-in)", async ({ page }) => {
    await page.goto("/login?error=Google%20sign-in%20was%20cancelled");
    await expect(page.locator(".auth-error")).toHaveText("Google sign-in was cancelled");
  });

  test("names the app when a connecting app sent you here to sign in", async ({ page }) => {
    await page.goto("/login?connect=Claude%20Code");
    await expect(page.getByText("Sign in to connect Claude Code to your mindmaps.")).toBeVisible();
  });

  test("Google sign-in is not offered when it is not configured", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByText("Continue with Google")).toHaveCount(0);
  });

  test("links between the two forms and back to the landing page", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Create one" }).click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByRole("link", { name: "mindmaps" }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe("where sign-in sends you", () => {
  test("back to the page you were turned away from", async ({ page, existing }) => {
    const board = await createBoard(existing.request, "Deep link target");

    await page.goto(`/app/${board.id}`);
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Email").fill(existing.user.email);
    await page.getByLabel("Password").fill(existing.user.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(new RegExp(`/app/${board.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Deep link target" })).toBeVisible();
  });

  test("never to another origin named in ?next=", async ({ page, existing }) => {
    await page.goto("/login?next=" + encodeURIComponent("https://evil.example/steal"));
    await page.getByLabel("Email").fill(existing.user.email);
    await page.getByLabel("Password").fill(existing.user.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/app\//);
  });

  test("a relative ?next= is honoured", async ({ page, existing }) => {
    await page.goto("/login?next=/artefacts");
    await page.getByLabel("Email").fill(existing.user.email);
    await page.getByLabel("Password").fill(existing.user.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/artefacts$/);
  });

  test("signed-in visitors are bounced off /login and /register", async ({ page, account }) => {
    void account;
    for (const path of ["/login", "/register"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/app\//);
    }
  });
});
