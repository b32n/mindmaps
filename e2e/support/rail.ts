import { expect, type Locator, type Page } from "@playwright/test";

/** The left rail of the signed-in shell: mindmaps, workspace menu, Trash, account. */
export class Rail {
  readonly list: Locator;
  constructor(readonly page: Page) {
    this.list = page.locator(".rail-list");
  }

  /** Mindmap names, top to bottom. */
  names() {
    return this.page.locator(".rail-row .rail-name");
  }

  row(name: string) {
    return this.page.locator(".rail-row").filter({ has: this.page.locator(".rail-name", { hasText: new RegExp(`^${escapeRe(name)}$`) }) });
  }

  open(name: string) {
    return this.row(name).locator(".rail-open").click();
  }

  /** Open the "New mindmap" dialog from the rail's + button. */
  async openNewDialog() {
    await this.page.getByRole("button", { name: "New mindmap" }).first().click();
    await expect(this.page.getByRole("dialog", { name: "New mindmap" })).toBeVisible();
  }

  /** Create a mindmap through the dialog; resolves once it is open. */
  async create(name: string, description = "") {
    await this.openNewDialog();
    const dialog = this.page.getByRole("dialog", { name: "New mindmap" });
    await dialog.getByLabel("Name").fill(name);
    if (description) await dialog.getByLabel("What belongs here").fill(description);
    await dialog.getByRole("button", { name: "Create mindmap" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(this.page.getByRole("heading", { level: 1, name })).toBeVisible();
  }

  /** Open a mindmap's settings dialog (the ••• button on its row). */
  async openSettings(name: string) {
    await this.row(name).hover();
    await this.row(name).getByRole("button", { name: "Mindmap settings" }).click();
    const dialog = this.page.getByRole("dialog", { name: "Mindmap settings" });
    await expect(dialog).toBeVisible();
    return dialog;
  }
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
