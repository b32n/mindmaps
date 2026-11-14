import { expect, type Locator, type Page } from "@playwright/test";

/** The Trash dialog (rail → Trash). */
export class TrashDialog {
  readonly root: Locator;
  constructor(readonly page: Page) {
    this.root = page.getByRole("dialog", { name: "Trash" });
  }

  async open() {
    await this.page.getByRole("button", { name: "Trash" }).click();
    await expect(this.root).toBeVisible();
    // the list has loaded: either rows or the empty message
    await expect(this.root.getByText("Loading…")).toHaveCount(0);
    return this;
  }

  rows() {
    return this.root.locator(".trash-row");
  }

  row(label: string) {
    return this.rows().filter({ has: this.page.locator(".trash-label", { hasText: new RegExp(`^${label}$`) }) });
  }
}
