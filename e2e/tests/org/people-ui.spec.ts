import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures";
import { addMember, createWorkspace, listWorkspaces } from "../../support/api";
import { PeopleRow, openWorkspacePeople } from "../../support/members";
import { makeOrg, transferOwnership } from "../../support/org";
import { meId } from "../../support/account";
import { query } from "../../support/versions";

// The workspace People dialog for owners and admins, and the delete-account
// warning in Settings for an owner of a shared workspace.

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });

test.describe("People dialog", () => {
  test("the owner changes a role from the row, including promoting to admin", async ({ page, account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Ops team");
    await page.goto("/app");
    const { panel } = await openWorkspacePeople(page, "Ops team");

    const editor = new PeopleRow(panel.row(org.editor.user.email));
    await expect(editor.roleSelect()).toHaveValue("editor");
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/members\//.test(r.url()));
    await editor.roleSelect().selectOption("admin");
    expect((await saved).status()).toBe(200);
    expect((await listWorkspaces(org.editor.request)).find((w) => w.id === org.ws.id)?.role).toBe("admin");

    const viewer = new PeopleRow(panel.row(org.viewer.user.email));
    await expect(viewer.roleSelect()).toHaveValue("viewer");
    // the owner row has no controls
    const ownerRow = panel.root.getByTestId("owner-row");
    await expect(ownerRow).toContainText("You");
    await expect(ownerRow.getByRole("combobox")).toHaveCount(0);
    await expect(ownerRow.getByRole("button")).toHaveCount(0);
  });

  test("Make owner asks for confirmation; cancelling changes nothing, confirming transfers", async ({ page, account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Transfer team");
    await page.goto("/app");
    const { panel } = await openWorkspacePeople(page, "Transfer team");
    const target = new PeopleRow(panel.row(org.editor.user.email));

    await target.makeOwner().click();
    await expect(target.row).toContainText("You will become an admin");
    await target.cancelTransfer().click();
    await expect(target.row).not.toContainText("You will become an admin");
    expect((await query<any>(`SELECT owner_id FROM workspaces WHERE id = ?`, [org.ws.id]))[0].owner_id).toBe(org.ownerId);

    await target.makeOwner().click();
    const done = page.waitForResponse((r) => r.request().method() === "POST" && /\/transfer$/.test(r.url()));
    await target.confirmTransfer().click();
    expect((await done).status()).toBe(200);

    expect((await query<any>(`SELECT owner_id FROM workspaces WHERE id = ?`, [org.ws.id]))[0].owner_id).toBe(org.editor.id);
    // the dialog now shows the new owner and the old owner as an admin
    await expect(panel.row(org.editor.user.email)).toContainText("Owner");
    await expect(panel.row(account.email)).toContainText("Admin");
    await expect(panel.root.getByRole("button", { name: "Make owner" })).toHaveCount(0);
  });

  test("an admin manages editors and viewers but sees no ownership or admin controls", async ({ account, request, makePerson, openAs }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Admin view");
    const peer = await makePerson("peer");
    await addMember(request, "workspaces", org.ws.id, peer.user.email, "editor");
    const peerId = await meId(peer.request);
    await request.patch(`/api/workspaces/${org.ws.id}/members/${peerId}`, { data: { role: "admin" } });

    const page = await openAs(org.admin);
    await page.goto("/app");
    const { panel } = await openWorkspacePeople(page, "Admin view");

    await expect(panel.rows().first()).toBeVisible();
    await expect(panel.root.getByRole("button", { name: "Make owner" })).toHaveCount(0);
    const editor = new PeopleRow(panel.row(org.editor.user.email));
    await expect(editor.roleSelect()).toBeEnabled();
    await expect(editor.roleSelect().locator("option[value=admin]")).toHaveCount(0);
    await expect(editor.remove()).toBeVisible();
    // a fellow admin and the owner are read-only
    const fellow = new PeopleRow(panel.row(peer.user.email));
    await expect(fellow.row).toContainText("Admin");
    await expect(fellow.roleSelect()).toHaveCount(0);
    await expect(fellow.remove()).toHaveCount(0);
    const owner = new PeopleRow(panel.root.getByTestId("owner-row"));
    await expect(owner.roleSelect()).toHaveCount(0);
    await expect(owner.remove()).toHaveCount(0);

    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/members\//.test(r.url()));
    await editor.roleSelect().selectOption("viewer");
    expect((await saved).status()).toBe(200);
    expect((await listWorkspaces(org.editor.request)).find((w) => w.id === org.ws.id)?.role).toBe("viewer");
  });

  test("editors do not get the People button; admins do", async ({ account, request, makePerson, openAs }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Button team");
    const people = (p: Page) =>
      p.locator(".ws-trigger").click().then(() =>
        p.getByRole("menuitem", { name: /Button team/ }).locator(".ws-item-people"));
    const adminPage = await openAs(org.admin);
    await adminPage.goto("/app");
    await expect(await people(adminPage)).toHaveCount(1);
    await expect(adminPage.getByRole("menuitem", { name: /Button team/ })).toContainText("Admin");
    const editorPage = await openAs(org.editor);
    await editorPage.goto("/app");
    await expect(await people(editorPage)).toHaveCount(0);
  });
});

test.describe("deleting the account from Settings", () => {
  const openSettings = async (page: Page) => {
    await page.goto("/app");
    // the dialog asks what blocks deletion as it opens; wait for the answer so
    // what follows is not racing it
    const asked = page.waitForResponse((r) => /\/api\/account\/delete-blockers$/.test(r.url()));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings(page)).toBeVisible();
    await asked;
  };

  test("warns up front which workspaces block it, and disables the button", async ({ page, account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Blocking org");
    await openSettings(page);
    const warn = settings(page).getByTestId("delete-blockers");
    await expect(warn).toContainText("Blocking org");
    await expect(warn).toContainText(/transfer ownership/i);
    await expect(settings(page).getByRole("button", { name: "Delete account…" })).toBeDisabled();
    void org;
  });

  test("after ownership is transferred the warning is gone and deletion works", async ({ page, account, request, makePerson }) => {
    const org = await makeOrg(request, makePerson, "Handed over");
    expect((await transferOwnership(request, org.ws.id, org.editor.id)).status()).toBe(200);
    await openSettings(page);
    await expect(settings(page).getByTestId("delete-blockers")).toHaveCount(0);
    await settings(page).getByRole("button", { name: "Delete account…" }).click();
    await settings(page).getByLabel(/Type your email address/).fill(account.email);
    await settings(page).getByRole("button", { name: "Delete my account" }).click();
    await page.waitForURL(/\/login\?notice=deleted/);
  });

  test("if someone is added after the page loaded, the refusal names the workspace in the dialog", async ({ page, account, request, makePerson }) => {
    const ws = await createWorkspace(request, "Late arrival");
    await openSettings(page);
    await expect(settings(page).getByTestId("delete-blockers")).toHaveCount(0);
    const late = await makePerson("late");
    await addMember(request, "workspaces", ws.id, late.user.email, "editor");

    await settings(page).getByRole("button", { name: "Delete account…" }).click();
    await settings(page).getByLabel(/Type your email address/).fill(account.email);
    await settings(page).getByRole("button", { name: "Delete my account" }).click();
    const warn = settings(page).getByTestId("delete-blockers");
    await expect(warn).toContainText("Late arrival");
    await expect(settings(page).getByLabel(/Type your email address/)).toHaveCount(0);
    await expect(settings(page).getByRole("button", { name: "Delete account…" })).toBeDisabled();
    expect((await request.get("/api/auth/me")).status()).toBe(200);
  });

  test("a user with no shared workspace sees no warning", async ({ page, account }) => {
    void account;
    await openSettings(page);
    await expect(settings(page).getByTestId("delete-blockers")).toHaveCount(0);
    await expect(settings(page).getByRole("button", { name: "Delete account…" })).toBeEnabled();
  });
});
