import type { Page } from "@playwright/test";
import { test, expect, register } from "../../fixtures";
import { newUser } from "../../support/users";
import { createBoard, inviteRaw, listBoards, listWorkspaces } from "../../support/api";
import { closeWorkspace, pendingInvites } from "../../support/lifecycle";
import { openWorkspacePeople, switchWorkspace } from "../../support/members";
import { makeOrg } from "../../support/org";
import { Rail } from "../../support/rail";
import { query } from "../../support/versions";

// The organisation lifecycle in the app: renaming and closing from the People
// dialog, reopening and leaving from the workspace menu, pending invitations
// with Accept and Decline, and moving a mindmap from its settings.

const trigger = (page: Page) => page.locator(".ws-trigger");
const menu = (page: Page) => page.getByRole("menu");
const open = async (page: Page) => {
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
};
const roleOf = async (request: any, id: string) => (await listWorkspaces(request)).find((w) => w.id === id)?.role;

test.describe("renaming", () => {
  test("the owner renames from the People dialog; the title, the menu and the server follow", async ({ page, account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Old name");
    await page.goto("/app");
    const { dialog } = await openWorkspacePeople(page, "Old name");
    const rename = dialog.getByLabel("Workspace name");
    await expect(rename).toHaveValue("Old name");
    await expect(dialog.getByRole("button", { name: "Rename" })).toBeDisabled();
    await rename.fill("  Brand new  ");
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/workspaces/${org.ws.id}`));
    await dialog.getByRole("button", { name: "Rename" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole("dialog", { name: "Brand new" })).toBeVisible();
    await page.keyboard.press("Escape");
    await open(page);
    await expect(menu(page).getByRole("menuitem", { name: /Brand new/ })).toBeVisible();
    expect((await listWorkspaces(request)).find((w) => w.id === org.ws.id)?.name).toBe("Brand new");
  });

  test("an invalid name is refused with the reason and nothing changes", async ({ page, account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Keeps");
    await page.goto("/app");
    const { dialog } = await openWorkspacePeople(page, "Keeps");
    await dialog.getByLabel("Workspace name").fill("x".repeat(81));
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(dialog.locator(".trash-error")).toContainText(/80/);
    expect((await listWorkspaces(request)).find((w) => w.id === org.ws.id)?.name).toBe("Keeps");
  });

  test("an admin sees the rename field; closing is the owner's alone", async ({ account, request, makePerson, openAs }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Admin view");
    const page = await openAs(org.admin);
    await page.goto("/app");
    const { dialog } = await openWorkspacePeople(page, "Admin view");
    await expect(dialog.getByLabel("Workspace name")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close workspace" })).toHaveCount(0);
    await dialog.getByLabel("Workspace name").fill("By the admin");
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByRole("dialog", { name: "By the admin" })).toBeVisible();
  });
});

test.describe("closing and reopening", () => {
  test("the owner closes after confirming: it leaves the menu, the app falls back to Personal, and it can be reopened from the menu", async ({ page, account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Sunset");
    await createBoard(request, "Plan", { workspace_id: org.ws.id });
    await page.goto("/app");
    await switchWorkspace(page, /Sunset/);
    await expect(trigger(page)).toContainText("Sunset");
    const { dialog } = await openWorkspacePeople(page, "Sunset");

    await dialog.getByRole("button", { name: "Close workspace" }).click();
    await expect(dialog).toContainText("30 days");
    // cancelling changes nothing
    await dialog.getByRole("button", { name: "Keep it open" }).click();
    expect(await roleOf(request, org.ws.id)).toBe("owner");

    await dialog.getByRole("button", { name: "Close workspace" }).click();
    const done = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/close"));
    await dialog.getByRole("button", { name: "Yes, close it" }).click();
    expect((await done).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    await expect(trigger(page)).toHaveText("Personal");
    expect(await roleOf(request, org.ws.id)).toBeUndefined();
    expect(await roleOf(org.editor.request, org.ws.id)).toBeUndefined();

    await open(page);
    await expect(menu(page).getByRole("menuitem", { name: /Sunset/ })).toHaveCount(0);
    const closed = page.locator(".ws-closed-row").filter({ hasText: "Sunset" });
    await expect(closed).toBeVisible();
    await expect(closed).toContainText(/Reopen until/);
    const reopened = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/reopen"));
    await closed.getByRole("button", { name: "Reopen" }).click();
    expect((await reopened).status()).toBe(200);
    await expect(menu(page).getByRole("menuitem", { name: /Sunset/ })).toBeVisible();
    await expect(page.locator(".ws-closed-row")).toHaveCount(0);
    expect(await roleOf(org.editor.request, org.ws.id)).toBe("editor");
  });

  test("a member who has the workspace open sees it disappear on the next load, and the closed section is the owner's only", async ({ page, account, request, makePerson, openAs }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Vanishing");
    await closeWorkspace(request, org.ws.id);
    const member = await openAs(org.editor);
    await member.goto("/app");
    await open(member);
    await expect(member.getByRole("menuitem", { name: /Vanishing/ })).toHaveCount(0);
    await expect(member.locator(".ws-closed-row")).toHaveCount(0);
    await page.goto("/app");
    await open(page);
    await expect(page.locator(".ws-closed-row")).toContainText("Vanishing");
  });

  test("with nothing closed the menu has no closed section", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await open(page);
    await expect(page.locator(".ws-closed-row")).toHaveCount(0);
    await expect(menu(page).getByText("Closed workspaces")).toHaveCount(0);
  });
});

test.describe("leaving", () => {
  for (const role of ["admin", "editor", "viewer"] as const) {
    test(`a ${role} leaves from the menu after confirming`, async ({ account, request, makePerson, openAs }) => {
      void account;
      const org = await makeOrg(request, makePerson, "Crew");
      const who = org[role];
      const page = await openAs(who);
      await page.goto("/app");
      await switchWorkspace(page, /Crew/);
      await open(page);
      await menu(page).getByRole("menuitem", { name: /Crew/ }).locator(".ws-item-leave").click();
      const dialog = page.getByRole("dialog", { name: "Leave Crew" });
      await expect(dialog).toContainText("lose access");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      expect(await roleOf(who.request, org.ws.id)).toBeTruthy();

      await open(page);
      await menu(page).getByRole("menuitem", { name: /Crew/ }).locator(".ws-item-leave").click();
      const gone = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/members/${who.id}`));
      await page.getByRole("dialog", { name: "Leave Crew" }).getByRole("button", { name: "Leave workspace" }).click();
      expect((await gone).status()).toBe(200);
      await expect(trigger(page)).toHaveText("Personal");
      expect(await roleOf(who.request, org.ws.id)).toBeUndefined();
      expect(await roleOf(request, org.ws.id)).toBe("owner");
    });
  }

  test("the owner and Personal have no Leave: the owner transfers first", async ({ page, account, request, makePerson }) => {
    void account;
    await makeOrg(request, makePerson, "Mine");
    await page.goto("/app");
    await open(page);
    await expect(menu(page).locator(".ws-item-leave")).toHaveCount(0);
  });

  test("after a transfer the former owner can leave", async ({ page, account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Handover");
    await request.post(`/api/workspaces/${org.ws.id}/transfer`, { data: { user_id: org.editor.id } });
    await page.goto("/app");
    await open(page);
    await expect(menu(page).getByRole("menuitem", { name: /Handover/ }).locator(".ws-item-leave")).toBeVisible();
  });
});

test.describe("invitations", () => {
  test("a pending invitation shows on the menu; Accept joins and switches nothing by itself", async ({ page, account, existing, request }) => {
    const owner = existing;
    const ws = (await owner.request.post("/api/workspaces", { data: { name: "Acme" } }).then((r) => r.json())) as { id: string };
    await createBoard(owner.request, "Acme plan", { workspace_id: ws.id });
    await inviteRaw(owner.request, "workspaces", ws.id, account.email, "editor");

    await page.goto("/app");
    await expect(trigger(page).locator(".ws-badge")).toHaveText("1");
    await open(page);
    const invite = page.locator(".ws-invite").filter({ hasText: "Acme" });
    await expect(invite).toContainText(owner.user.name);
    await expect(invite).toContainText("Can edit");
    await expect(menu(page).getByRole("menuitem", { name: /Acme/ })).toHaveCount(0);

    const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/accept"));
    await invite.getByRole("button", { name: "Accept" }).click();
    expect((await answered).status()).toBe(200);
    await expect(menu(page).getByRole("menuitem", { name: /Acme/ })).toContainText("Can edit");
    await expect(page.locator(".ws-invite")).toHaveCount(0);
    await expect(trigger(page).locator(".ws-badge")).toHaveCount(0);
    expect(await roleOf(request, ws.id)).toBe("editor");
  });

  test("Decline ends it: nothing joined, nothing left to answer", async ({ page, account, existing, request }) => {
    const ws = (await existing.request.post("/api/workspaces", { data: { name: "Nope Inc" } }).then((r) => r.json())) as { id: string };
    const sent = await inviteRaw(existing.request, "workspaces", ws.id, account.email, "viewer");
    await page.goto("/app");
    await open(page);
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/decline"));
    await page.locator(".ws-invite").filter({ hasText: "Nope Inc" }).getByRole("button", { name: "Decline" }).click();
    expect((await answered).status()).toBe(200);
    await expect(page.locator(".ws-invite")).toHaveCount(0);
    expect(await roleOf(request, ws.id)).toBeUndefined();
    expect((await query<any>(`SELECT status FROM invites WHERE token = ?`, [sent.invited!.token]))[0].status).toBe("declined");
    expect(await pendingInvites(request)).toEqual([]);
  });

  test("a mindmap invitation for a new sign-up is described as one", async ({ account, request, playwright, baseURL, openAs }) => {
    void account;
    const board = await createBoard(request, "Roadmap");
    const who = newUser("guest");
    await inviteRaw(request, "boards", board.id, who.email, "viewer");
    const ctx = await playwright.request.newContext({ baseURL });
    await register(ctx, who);
    const page = await openAs({ user: who, request: ctx });
    await page.goto("/app");
    await expect(trigger(page).locator(".ws-badge")).toHaveText("1");
    await open(page);
    const invite = page.locator(".ws-invite");
    await expect(invite).toContainText("the mindmap Roadmap");
    await invite.getByRole("button", { name: "Accept" }).click();
    await expect(invite).toHaveCount(0);
    expect((await listBoards(ctx)).map((b) => b.id)).toContain(board.id);
    await ctx.dispose();
  });

  test("inviting from the People dialog says the person must accept", async ({ page, account, request, existing }) => {
    void account;
    await page.goto("/app");
    await trigger(page).click();
    await menu(page).getByRole("menuitem", { name: "New workspace" }).click();
    const dlg = page.getByRole("dialog", { name: "New workspace" });
    await dlg.getByLabel("Name").fill("Fresh");
    await dlg.getByRole("button", { name: "Create" }).click();
    await expect(trigger(page)).toContainText("Fresh");
    const { panel } = await openWorkspacePeople(page, "Fresh");
    const { body } = await panel.invite(existing.user.email, "Can view");
    expect(body.invited).toBeTruthy();
    await expect(panel.root.locator(".members-note").filter({ hasText: /^Invited / })).toHaveText(
      `Invited ${existing.user.email}. They become a member when they accept.`,
    );
    await expect(panel.row(existing.user.email)).toContainText("waiting for them to accept");
    await expect(panel.row(existing.user.email).getByRole("button", { name: "Cancel" })).toBeVisible();
  });
});

test.describe("moving a mindmap", () => {
  test("from its settings, into a workspace the person can write to; it leaves the rail here and appears there", async ({ page, account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Team space");
    await createBoard(request, "Mover");
    await page.goto("/app");
    const rail = new Rail(page);
    const dialog = await rail.openSettings("Mover");
    const select = dialog.getByLabel("Workspace");
    await expect(select).toHaveValue(/.+/);
    // only workspaces they can write to are offered, by name
    await expect(select.locator("option")).toHaveText(["Personal", "Team space"]);
    await expect(dialog.getByRole("button", { name: "Move" })).toBeDisabled();
    await select.selectOption({ label: "Team space" });
    const moved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/move"));
    await dialog.getByRole("button", { name: "Move" }).click();
    expect((await moved).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    await expect(rail.row("Mover")).toHaveCount(0);

    await switchWorkspace(page, /Team space/);
    await expect(rail.row("Mover")).toBeVisible();
    expect((await listBoards(request)).find((b) => b.name === "Mover")?.workspace_id).toBe(org.ws.id);
  });

  test("a viewer is not offered the workspace they can only read", async ({ account, request, makePerson, openAs }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Read only");
    await createBoard(org.viewer.request, "Mine to move");
    const page = await openAs(org.viewer);
    await page.goto("/app");
    const dialog = await new Rail(page).openSettings("Mine to move");
    await expect(dialog.getByLabel("Workspace").locator("option")).toHaveText(["Personal"]);
  });

  test("a mindmap in a shared workspace can be moved to Personal by someone who can write there", async ({ page, account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Source");
    await createBoard(request, "Back home", { workspace_id: org.ws.id });
    await page.goto("/app");
    await switchWorkspace(page, /Source/);
    const rail = new Rail(page);
    const dialog = await rail.openSettings("Back home");
    await dialog.getByLabel("Workspace").selectOption({ label: "Personal" });
    await dialog.getByRole("button", { name: "Move" }).click();
    await expect(rail.row("Back home")).toHaveCount(0);
    await switchWorkspace(page, "Personal");
    await expect(rail.row("Back home")).toBeVisible();
  });
});
