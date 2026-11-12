import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The people list used by the Share dialog (mindmap), the workspace "People"
 * dialog and an artefact's Share popover: the same MembersPanel component in
 * three places. Pass the element that contains it.
 */
export class MembersPanel {
  constructor(readonly root: Locator) {}

  email() {
    return this.root.getByPlaceholder("Email address");
  }

  role() {
    return this.root.getByRole("combobox");
  }

  rows() {
    return this.root.locator(".members-row");
  }

  /** The row for a member or pending invite, by (part of) its text. */
  row(text: string | RegExp) {
    return this.rows().filter({ hasText: text });
  }

  /**
   * Invite `email` and wait for the server to answer, so what follows (the
   * list, the note) reflects the stored state. Resolves with the response body.
   */
  async invite(email: string, role: "Can edit" | "Can view" = "Can edit") {
    await this.role().selectOption({ label: role });
    await this.email().fill(email);
    const answered = this.root.page().waitForResponse(
      (r) => r.request().method() === "POST" && /\/members$/.test(r.url()),
    );
    await this.root.getByRole("button", { name: "Invite" }).click();
    const res = await answered;
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
  }

  /**
   * The note under the form ("x now has access." / "Invited x. …"). Filtered,
   * because the "Only you can see this…" hint is the same element until the
   * list has reloaded.
   */
  note() {
    return this.root.locator(".members-note").filter({ hasText: /now has access|^Invited / });
  }
}

/** The mindmap's Share dialog, opened from the topbar. */
export async function openBoardShare(page: Page, boardName: string) {
  await page.getByTitle("Share this mindmap").click();
  const dialog = page.getByRole("dialog", { name: `Share ${boardName}` });
  await expect(dialog).toBeVisible();
  return { dialog, panel: new MembersPanel(dialog) };
}

/** A workspace's People dialog, opened from the workspace menu. */
export async function openWorkspacePeople(page: Page, workspaceName: string) {
  await page.locator(".ws-trigger").click();
  await page
    .getByRole("menuitem", { name: new RegExp(workspaceName) })
    .locator(".ws-item-people")
    .click();
  const dialog = page.getByRole("dialog", { name: workspaceName });
  await expect(dialog).toBeVisible();
  return { dialog, panel: new MembersPanel(dialog) };
}

/** Switch workspace from the menu. */
export async function switchWorkspace(page: Page, name: string | RegExp) {
  await page.locator(".ws-trigger").click();
  await page.getByRole("menuitem", { name }).click();
}
