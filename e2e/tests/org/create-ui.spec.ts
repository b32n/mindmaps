import { test, expect } from "../../fixtures";
import { MembersPanel } from "../../support/members";
import { listWorkspaces } from "../../support/api";
import { newUser } from "../../support/users";
import { MAIN_PORT, modeWorkers } from "../../support/hosts";

// Creating an organisation from the app: offered in multitenant (and unset),
// never in personal.

for (const [name, baseURL] of [
  ["unset", `http://127.0.0.1:${MAIN_PORT}`],
  ["multitenant", modeWorkers.multitenant.baseURL],
] as const) {
  test.describe(`${name}: Create organisation`, () => {
    test.use({ baseURL });

    test("a short onboarding: name it, invite people, you are in", async ({ page, account, request }) => {
      void account;
      await page.goto("/app");
      await page.locator(".ws-trigger").click();
      await page.getByRole("menuitem", { name: "Create organisation" }).click();

      const dialog = page.getByRole("dialog", { name: "Create organisation" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Organisation name").fill("Globex");
      await dialog.getByRole("button", { name: "Create organisation" }).click();

      const invite = page.getByRole("dialog", { name: "Invite your team" });
      await expect(invite).toBeVisible();
      const mate = newUser("mate");
      const panel = new MembersPanel(invite);
      expect((await panel.invite(mate.email)).status).toBe(201);
      await expect(panel.row(mate.email)).toBeVisible();
      await invite.getByRole("button", { name: "Done" }).click();

      await expect(page.locator(".ws-trigger")).toContainText("Globex");
      expect((await listWorkspaces(request)).find((w) => w.name === "Globex")).toMatchObject({ role: "owner", personal: 0 });
    });

    test("skipping the invitations is fine, and so is cancelling at the first step", async ({ page, account, request }) => {
      void account;
      await page.goto("/app");
      await page.locator(".ws-trigger").click();
      await page.getByRole("menuitem", { name: "Create organisation" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect((await listWorkspaces(request)).filter((w) => !w.personal)).toEqual([]);

      await page.locator(".ws-trigger").click();
      await page.getByRole("menuitem", { name: "Create organisation" }).click();
      await page.getByLabel("Organisation name").fill("Initech");
      await page.getByRole("button", { name: "Create organisation" }).last().click();
      await page.getByRole("button", { name: "Done" }).click();
      await expect(page.locator(".ws-trigger")).toContainText("Initech");
    });

    test("the existing New workspace entry is still there and unchanged", async ({ page, account }) => {
      void account;
      await page.goto("/app");
      await page.locator(".ws-trigger").click();
      await page.getByRole("menuitem", { name: "New workspace" }).click();
      const dialog = page.getByRole("dialog", { name: "New workspace" });
      await dialog.getByLabel("Name").fill("Plain");
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(page.locator(".ws-trigger")).toContainText("Plain");
    });
  });
}

test.describe("personal: nothing to create", () => {
  test.use({ baseURL: modeWorkers.personal.baseURL });

  test("the workspace menu offers neither entry", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await expect(page.locator(".rail")).toBeVisible();
    // personal mode has no workspace menu at all, so neither entry can be offered
    await expect(page.locator(".ws-trigger")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "New workspace" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Create organisation" })).toHaveCount(0);
  });
});
