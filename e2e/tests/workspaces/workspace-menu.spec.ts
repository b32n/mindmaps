import { test, expect } from "../../fixtures";
import { Rail } from "../../support/rail";
import type { Page } from "@playwright/test";

// Basics of the workspace switcher only. Inviting members, roles and what a
// member can see are covered with sharing in a later PR.

const trigger = (page: Page) => page.locator(".ws-trigger");
const menu = (page: Page) => page.getByRole("menu");

async function newWorkspace(page: Page, name: string) {
  await trigger(page).click();
  await menu(page).getByRole("menuitem", { name: "New workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger(page)).toContainText(name);
}

test.describe("the workspace menu", () => {
  test("starts on Personal, lists it as the current one, and has a New workspace entry", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await expect(trigger(page)).toHaveText("Personal");
    await trigger(page).click();
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
    await expect(menu(page).getByRole("menuitem")).toHaveText(["Personal", "New workspace"]);
    await expect(menu(page).locator(".ws-item.on")).toHaveText("Personal");
  });

  test("closes with Escape and with a click elsewhere", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await trigger(page).click();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await trigger(page).click();
    await page.getByRole("heading", { level: 1 }).click();
    await expect(menu(page)).toHaveCount(0);
  });

  test("New workspace: needs a name, Cancel leaves nothing, Create switches to it as Owner", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await trigger(page).click();
    await menu(page).getByRole("menuitem", { name: "New workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "New workspace" });
    await expect(dialog.getByText("A shared space. Everyone you invite sees every mindmap in it.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();
    await dialog.getByLabel("Name").fill("Platform team");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger(page)).toHaveText("Personal");

    await newWorkspace(page, "Platform team");
    await trigger(page).click();
    await expect(menu(page).getByRole("menuitem", { name: /Platform team/ })).toContainText("Owner");
    await expect(menu(page).locator(".ws-item.on")).toContainText("Platform team");
  });

  test("Enter in the name field creates it", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await trigger(page).click();
    await menu(page).getByRole("menuitem", { name: "New workspace" }).click();
    await page.getByRole("dialog", { name: "New workspace" }).getByLabel("Name").fill("By keyboard");
    await page.keyboard.press("Enter");
    await expect(trigger(page)).toContainText("By keyboard");
  });

  test("a new workspace is empty; mindmaps made in it stay in it; Personal still has its own", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    const rail = new Rail(page);
    await expect(rail.names()).toHaveText(["Start here"]);

    await newWorkspace(page, "Team space");
    await expect(rail.names()).toHaveCount(0);
    await expect(page.locator(".rail-empty")).toHaveText("Nothing here yet.");

    await rail.create("Team plan");
    await expect(rail.names()).toHaveText(["Team plan"]);

    await trigger(page).click();
    await menu(page).getByRole("menuitem", { name: "Personal" }).click();
    await expect(trigger(page)).toHaveText("Personal");
    await expect(rail.names()).toHaveText(["Start here"]);

    await trigger(page).click();
    await menu(page).getByRole("menuitem", { name: /Team space/ }).click();
    await expect(rail.names()).toHaveText(["Team plan"]);
  });

  test("the chosen workspace is remembered across a reload", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await newWorkspace(page, "Remembered");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("mindmaps.workspace"))).not.toBeNull();
    await page.reload();
    await expect(trigger(page)).toContainText("Remembered");
  });

  test("a workspace the account no longer belongs to falls back to Personal", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await page.evaluate(() => localStorage.setItem("mindmaps.workspace", "00000000-0000-0000-0000-000000000000"));
    await page.reload();
    await expect(trigger(page)).toHaveText("Personal");
  });

  test("an owned workspace has a People button that opens its members dialog", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await newWorkspace(page, "Crew");
    await trigger(page).click();
    await menu(page).getByRole("menuitem", { name: /Crew/ }).locator(".ws-item-people").click();

    const dialog = page.getByRole("dialog", { name: "Crew" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Everyone here can see every mindmap in this workspace.")).toBeVisible();
    await expect(dialog.locator(".members-row")).toHaveText(["YouOwner"]);
    // personal has no People button: it is only ever you
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await trigger(page).click();
    await expect(menu(page).getByRole("menuitem", { name: "Personal" }).locator(".ws-item-people")).toHaveCount(0);
  });

  test("workspaces are per account", async ({ page, account, existing }) => {
    void account;
    await page.goto("/app");
    await newWorkspace(page, "Only mine");
    const theirs = await (await existing.request.get("/api/workspaces")).json();
    expect(theirs.map((w: { name: string }) => w.name)).not.toContain("Only mine");
  });
});
