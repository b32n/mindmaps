import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, register } from "../../fixtures";
import { addMember, createBoard, createNode, createWorkspace } from "../../support/api";
import { signInViaForm } from "../../support/auth";
import { jsonEntry, readZip } from "../../support/zip";

// The two account controls in the settings dialog: download everything, and
// delete the account behind a typed confirmation.

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const openSettings = async (page: Page) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings(page)).toBeVisible();
};

test.describe("download my data", () => {
  test("the button saves a zip holding the user's own mindmaps and cards", async ({ page, account, request }) => {
    void account;
    const board = await createBoard(request, "Downloadable");
    await createNode(request, board.id, { title: "UI-EXPORT-CARD-3321", body: "ui export body" });
    await openSettings(page);
    await expect(settings(page).getByRole("heading", { name: "Your data" })).toBeVisible();

    const download = page.waitForEvent("download");
    await settings(page).getByRole("link", { name: "Download my data" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^mindmaps-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const zip = readZip(readFileSync((await file.path())!));
    expect(jsonEntry(zip, "cards.json").some((c: any) => c.title === "UI-EXPORT-CARD-3321")).toBe(true);
    expect(jsonEntry(zip, "manifest.json").account.email).toBe(account.email);
  });
});

test.describe("delete account", () => {
  test("starts closed, and Cancel closes it again without touching anything", async ({ page, account }) => {
    void account;
    await openSettings(page);
    const s = settings(page);
    await expect(s.getByRole("heading", { name: "Delete account" })).toBeVisible();
    await expect(s.getByLabel(/Type your email address/)).toHaveCount(0);
    await s.getByRole("button", { name: "Delete account…" }).click();
    await expect(s.getByLabel(/Type your email address/)).toBeVisible();
    await s.getByRole("button", { name: "Cancel" }).click();
    await expect(s.getByLabel(/Type your email address/)).toHaveCount(0);
    expect((await page.request.get("/api/auth/me")).status()).toBe(200);
  });

  test("the final button stays disabled until the email matches exactly", async ({ page, account }) => {
    await openSettings(page);
    const s = settings(page);
    await s.getByRole("button", { name: "Delete account…" }).click();
    const confirm = s.getByRole("button", { name: "Delete my account" });
    const field = s.getByLabel(/Type your email address/);
    await expect(confirm).toBeDisabled();
    await field.fill("not-my-address@example.test");
    await expect(confirm).toBeDisabled();
    await field.fill(account.email.slice(0, -1));
    await expect(confirm).toBeDisabled();
    await field.fill(account.email);
    await expect(confirm).toBeEnabled();
  });

  test("confirming signs out, lands on the sign-in page, and the account is gone", async ({ page, account, request }) => {
    const board = await createBoard(request, "Going away");
    await openSettings(page);
    const s = settings(page);
    await s.getByRole("button", { name: "Delete account…" }).click();
    await s.getByLabel(/Type your email address/).fill(account.email);
    const done = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith("/api/account"));
    await s.getByRole("button", { name: "Delete my account" }).click();
    expect((await done).status()).toBe(200);

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("Your account and everything in it have been deleted.")).toBeVisible();
    expect((await page.request.get("/api/auth/me").then((r) => r.json())).user).toBeNull();
    expect((await page.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(401);

    // signing in with the old credentials is refused
    await signInViaForm(page, account);
    await expect(page.locator(".auth-error")).toHaveText("Email or password is incorrect.");
    await expect(page).toHaveURL(/\/login/);
  });

  test("the same address can sign up again straight afterwards", async ({ page, account, request, playwright, baseURL }) => {
    await openSettings(page);
    const s = settings(page);
    await s.getByRole("button", { name: "Delete account…" }).click();
    await s.getByLabel(/Type your email address/).fill(account.email);
    await s.getByRole("button", { name: "Delete my account" }).click();
    await expect(page).toHaveURL(/\/login/);

    const fresh = await playwright.request.newContext({ baseURL });
    await register(fresh, account);
    expect((await fresh.get("/api/auth/me").then((r) => r.json())).user.email).toBe(account.email);
    await fresh.dispose();
    void request;
  });

  test("a workspace with members blocks it: the dialog shows the reason and the account stays", async ({ page, account, request, makePerson }) => {
    const member = await makePerson("member");
    const ws = await createWorkspace(request, "Team room");
    await addMember(request, "workspaces", ws.id, member.user.email, "editor");

    await openSettings(page);
    const s = settings(page);
    await s.getByRole("button", { name: "Delete account…" }).click();
    await s.getByLabel(/Type your email address/).fill(account.email);
    await s.getByRole("button", { name: "Delete my account" }).click();

    await expect(s.locator(".modal-warn")).toContainText("Team room");
    await expect(s.locator(".modal-warn")).toContainText(/transfer|remove/i);
    await expect(page).toHaveURL(/\/app/);
    expect((await page.request.get("/api/auth/me").then((r) => r.json())).user.email).toBe(account.email);
  });
});
