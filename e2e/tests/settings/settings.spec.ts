import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import type { Page } from "@playwright/test";

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });

test.describe("settings dialog", () => {
  test("shows the account's name and email", async ({ page, account }) => {
    await page.goto("/app");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings(page)).toBeVisible();
    await expect(settings(page).getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(settings(page).locator("dd")).toHaveText([account.name, account.email]);
  });

  test("an account with no name shows “Not set”", async ({ page, request }) => {
    const email = `e2e-noname-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const res = await request.post("/api/auth/register", { data: { email, password: "Aa1!zzyyxxwwvvu9" } });
    expect(res.ok()).toBe(true);
    await page.goto("/app");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings(page).locator("dd")).toHaveText(["Not set", email]);
  });

  test("with no connected apps it explains how to connect one, with this server's address", async ({ page, account, baseURL }) => {
    void account;
    await page.goto("/app");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings(page).getByRole("heading", { name: "Connected apps" })).toBeVisible();
    await expect(settings(page).getByText("Nothing connected yet.")).toBeVisible();
    await expect(settings(page).locator("code")).toHaveText(`claude mcp add --transport http mindmaps ${baseURL}/mcp`);
  });

  test("closes with ×, Escape and a click outside, and reopens fresh", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    const open = () => page.getByRole("button", { name: "Settings", exact: true }).click();

    await open();
    await settings(page).getByRole("button", { name: "Close" }).click();
    await expect(settings(page)).toHaveCount(0);

    await open();
    await page.keyboard.press("Escape");
    await expect(settings(page)).toHaveCount(0);

    await open();
    await page.mouse.click(10, 10);
    await expect(settings(page)).toHaveCount(0);

    await open();
    await expect(settings(page)).toBeVisible();
  });

  test("there is no password change or account deletion in the app", async ({ page, account }) => {
    // Deliberately recorded: the suite covers every control the UI has, and these
    // are not among them (see e2e/README.md, "not covered").
    void account;
    await page.goto("/app");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings(page).getByText(/password|delete account/i)).toHaveCount(0);
  });
});

test.describe("share dialog on a mindmap", () => {
  // Inviting people, roles and removal are covered with sharing (a later PR);
  // here only that the dialog is reachable and describes the mindmap.
  test("opens from the topbar, names the mindmap, shows you as owner, and closes", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page, "Roadmap");
    await expect(page.getByRole("button", { name: "Share" })).toHaveText("Share");
    await page.getByRole("button", { name: "Share" }).click();

    const dialog = page.getByRole("dialog", { name: "Share Roadmap" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("People you add here can open this mindmap and everything on it.")).toBeVisible();
    await expect(dialog.getByPlaceholder("Email address")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Invite" })).toBeDisabled();
    await expect(dialog.locator(".members-row")).toHaveText(["YouOwner"]);
    await expect(dialog.getByText("Only you can see this mindmap.")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(board.canvas).toBeVisible();
  });

  test("also reachable from a mindmap's settings, under People", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    const row = page.locator(".rail-row").first();
    await row.hover();
    await row.getByRole("button", { name: "Mindmap settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Mindmap settings" });
    await expect(dialog.getByText("People", { exact: true })).toBeVisible();
    await expect(dialog.getByPlaceholder("Email address")).toBeVisible();
  });
});
