import { test, expect } from "../../fixtures";
import { createBoard, createNode } from "../../support/api";
import type { Page } from "@playwright/test";

// The cross-mindmap Artefacts list. Opening and editing an artefact (sheet,
// document, deck, page) and files/folders are covered in a later PR.

async function seed(page: Page) {
  const a = await createBoard(page.request, "Alpha board");
  const b = await createBoard(page.request, "Beta board");
  const mk = (board: string, type: string, title: string) => createNode(page.request, board, { type, title, x: 0, y: 0 });
  const sheet = await mk(a.id, "sheet", "Budget model");
  const doc = await mk(a.id, "doc", "Design notes");
  const deck = await mk(b.id, "deck", "Quarterly review");
  await mk(b.id, "card", "A plain card"); // not an artefact
  return { a, b, sheet, doc, deck };
}

test.describe("the Artefacts list", () => {
  test("with none, says how to make one", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await page.getByRole("button", { name: "Artefacts" }).click();
    await expect(page).toHaveURL(/\/artefacts$/);
    await expect(page.getByRole("heading", { level: 1, name: "Artefacts" })).toBeVisible();
    await expect(page.getByText("No artefacts yet. Add one from the dock on any mindmap")).toBeVisible();
    await expect(page.locator(".rail-trash.active")).toHaveText(/Artefacts/);
  });

  test("lists every artefact across mindmaps (and only artefacts) with kind, mindmap and details", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.goto("/artefacts");

    await expect(page.locator(".arte-tr")).toHaveCount(3);
    await expect(page.locator(".arte-tr .arte-label")).not.toContainText(["A plain card"]);
    const budget = page.locator(".arte-tr", { hasText: "Budget model" });
    await expect(budget).toHaveClass(/sheet/);
    await expect(budget.locator(".arte-where")).toHaveText("Alpha board");
    await expect(budget.locator(".arte-detail")).toContainText("sheet");
    await expect(page.locator(".arte-tr", { hasText: "Quarterly review" }).locator(".arte-where")).toHaveText("Beta board");
  });

  test("filter chips narrow by kind and show counts", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.goto("/artefacts");
    await expect(page.locator(".arte-filter", { hasText: "All" }).locator(".arte-count")).toHaveText("3");
    await page.locator(".arte-filter", { hasText: "Decks" }).click();
    await expect(page.locator(".arte-tr .arte-label")).toHaveText(["Quarterly review"]);
    await page.locator(".arte-filter", { hasText: "All" }).click();
    await expect(page.locator(".arte-tr")).toHaveCount(3);
  });

  test("the filter box matches names and mindmap names, and reports no match", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.goto("/artefacts");
    const box = page.getByPlaceholder("Filter by name or mindmap");
    await box.fill("budget");
    await expect(page.locator(".arte-tr .arte-label")).toHaveText(["Budget model"]);
    await box.fill("beta");
    await expect(page.locator(".arte-tr .arte-label")).toHaveText(["Quarterly review"]);
    await box.fill("zzz");
    await expect(page.getByText("Nothing matches that.")).toBeVisible();
  });

  test("columns sort, and clicking again reverses", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.goto("/artefacts");
    await page.locator(".arte-col", { hasText: /^Name/ }).click();
    await expect(page.locator(".arte-tr .arte-label")).toHaveText(["Budget model", "Design notes", "Quarterly review"]);
    await page.locator(".arte-col", { hasText: /^Name/ }).click();
    await expect(page.locator(".arte-tr .arte-label")).toHaveText(["Quarterly review", "Design notes", "Budget model"]);
    await page.locator(".arte-col", { hasText: /^Mindmap/ }).click();
    await expect(page.locator(".arte-tr .arte-where")).toHaveText(["Alpha board", "Alpha board", "Beta board"]);
  });

  test("each row links to its editor (in a new tab) and its mindmap name jumps to the mindmap", async ({ page, account }) => {
    void account;
    const { a, sheet } = await seed(page);
    await page.goto("/artefacts");
    const row = page.locator(".arte-tr", { hasText: "Budget model" });
    await expect(row.locator("a.arte-name")).toHaveAttribute("href", `/sheet/${sheet.id}?from=${a.id}`);
    await expect(row.locator("a.arte-name")).toHaveAttribute("target", "_blank");

    await row.locator(".arte-where").click();
    await expect(page).toHaveURL(new RegExp(`/app/${a.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Alpha board" })).toBeVisible();
  });

  test("an artefact node on a board shows its kind and opens its editor in a new tab", async ({ page, account }) => {
    void account;
    const { a, doc } = await seed(page);
    await page.goto(`/app/${a.id}`);
    const node = page.locator(`.react-flow__node[data-id="${doc.id}"]`);
    await expect(node.locator(".artefact-kind")).toHaveText("Doc");
    await expect(node.locator("input.card-title")).toHaveValue("Design notes");
    await expect(node.getByRole("link", { name: "Open" })).toHaveAttribute("href", `/doc/${doc.id}?from=${a.id}`);
    await expect(node.getByRole("link", { name: "Open" })).toHaveAttribute("target", "_blank");
  });

  test("another account's artefacts are not listed", async ({ page, account, existing }) => {
    void account;
    const theirs = await createBoard(existing.request, "Theirs");
    await createNode(existing.request, theirs.id, { type: "sheet", title: "Secret sheet", x: 0, y: 0 });
    await page.goto("/artefacts");
    await expect(page.getByText("No artefacts yet.")).toBeVisible();
  });
});
