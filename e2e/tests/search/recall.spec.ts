import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import { createBoard, createEdge, createNode, deleteNode } from "../../support/api";
import type { Page } from "@playwright/test";

// Recall (⌘K / Ctrl+K) is the app's search. The production Worker ranks by
// wording AND meaning; the test runtime has no Workers AI / Vectorize bindings,
// so only the keyword ("wording") path runs here. Semantic ranking is NOT
// covered by this suite (see e2e/README.md). The Worker reports that as
// `degraded`, and the dialog shows its note about it.

const dialog = (page: Page) => page.getByRole("dialog", { name: "Recall" });
const box = (page: Page) => page.getByPlaceholder("What do you already know about…");

async function seed(page: Page) {
  const board = await createBoard(page.request, "Infra notes");
  const zebra = await createNode(page.request, board.id, {
    title: "Zebra migration",
    body: "We move the quagga cluster on Friday.\n\nOwner: nobody has picked it up.",
    x: 0, y: 0,
  });
  const other = await createNode(page.request, board.id, { title: "Unrelated", body: "grocery list: oat milk", x: 400, y: 0 });
  await page.goto(`/app/${board.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Infra notes" })).toBeVisible();
  return { board, zebra, other };
}

test.describe("opening and closing", () => {
  test("Ctrl+K opens it focused with a hint, and Ctrl+K again closes it", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.keyboard.press("Control+k");
    await expect(dialog(page)).toBeVisible();
    await expect(box(page)).toBeFocused();
    await expect(dialog(page).getByText(/Search by meaning, not just wording/)).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(dialog(page)).toHaveCount(0);
  });

  test("the Recall button in the rail opens it too", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.locator(".rail-search").click();
    await expect(dialog(page)).toBeVisible();
  });

  test("Escape and a click on the backdrop close it", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);

    await page.keyboard.press("Control+k");
    await expect(dialog(page)).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("works from inside a card's editor, and reopening starts blank", async ({ page, account }) => {
    void account;
    const { zebra } = await seed(page);
    const board = new Board(page, page.request, (await page.url().split("/app/")[1]).split("?")[0]);
    await board.openCard(zebra.id);
    await board.editor.click();
    await page.keyboard.press("Control+k");
    await box(page).fill("quagga");
    await expect(dialog(page).locator(".rc-hit")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await expect(box(page)).toHaveValue("");
    await expect(dialog(page).locator(".rc-hit")).toHaveCount(0);
  });
});

test.describe("keyword search", () => {
  test("finds a card by a word in its title, shows where it lives and why it matched", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.keyboard.press("Control+k");
    await box(page).fill("zebra");

    const hits = dialog(page).locator(".rc-hit");
    await expect(hits).toHaveCount(1);
    await expect(hits.first().locator(".rc-hit-title")).toHaveText("Zebra migration");
    await expect(hits.first().locator(".rc-hit-meta")).toContainText("Infra notes");
    await expect(hits.first().locator(".rc-tag")).toHaveText("wording");
    await expect(hits.first().locator(".rc-hit-passage")).toContainText("quagga cluster");
    await expect(dialog(page).locator(".rc-foot")).toContainText("1 of 1 matches");
  });

  test("finds a card by a word only in its body, case-insensitively", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.keyboard.press("Control+k");
    await box(page).fill("QUAGGA");
    await expect(dialog(page).locator(".rc-hit-title")).toHaveText(["Zebra migration"]);
  });

  test("matches word stems and prefixes", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.keyboard.press("Control+k");
    await box(page).fill("migrat");
    await expect(dialog(page).locator(".rc-hit-title")).toHaveText(["Zebra migration"]);
    await box(page).fill("clusters");
    await expect(dialog(page).locator(".rc-hit-title")).toHaveText(["Zebra migration"]);
  });

  test("several words narrow the results", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.keyboard.press("Control+k");
    await box(page).fill("quagga friday");
    await expect(dialog(page).locator(".rc-hit")).toHaveCount(1);
  });

  test("a query nothing matches says so", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.keyboard.press("Control+k");
    await box(page).fill("pterodactyl");
    await expect(dialog(page).getByText("Nothing recorded about “pterodactyl”. That is worth writing down.")).toBeVisible();
    await expect(dialog(page).locator(".rc-hit")).toHaveCount(0);
  });

  test("without a semantic index the dialog says results are by wording", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.keyboard.press("Control+k");
    await box(page).fill("zebra");
    await expect(dialog(page).locator(".rc-hit")).toHaveCount(1);
    await expect(dialog(page).locator(".rc-note")).toContainText("semantic index is unavailable");
  });

  test("results follow the last thing typed", async ({ page, account }) => {
    void account;
    await seed(page);
    await page.keyboard.press("Control+k");
    await box(page).pressSequentially("grocery", { delay: 10 });
    await box(page).fill("");
    await box(page).pressSequentially("zebra", { delay: 10 });
    await expect(dialog(page).locator(".rc-hit-title")).toHaveText(["Zebra migration"]);
    await box(page).fill("");
    await expect(dialog(page).locator(".rc-hit")).toHaveCount(0);
    await expect(dialog(page).getByText(/Search by meaning/)).toBeVisible();
  });

  test("edits are searchable straight away: a renamed card is found under its new name only", async ({ page, account }) => {
    void account;
    const { zebra } = await seed(page);
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/nodes/${zebra.id}`));
    await page.locator(`.react-flow__node[data-id="${zebra.id}"] input.card-title`).fill("Okapi migration");
    await saved;

    await page.keyboard.press("Control+k");
    await box(page).fill("okapi");
    await expect(dialog(page).locator(".rc-hit-title")).toHaveText(["Okapi migration"]);
    await box(page).fill("zebra");
    await expect(dialog(page).getByText(/Nothing recorded about/)).toBeVisible();
  });

  test("a deleted card is no longer found", async ({ page, account }) => {
    void account;
    const { zebra } = await seed(page);
    await deleteNode(page.request, zebra.id);
    await page.keyboard.press("Control+k");
    await box(page).fill("zebra");
    await expect(dialog(page).getByText(/Nothing recorded about/)).toBeVisible();
  });

  test("linked cards are listed under a hit, with the link's label", async ({ page, account }) => {
    void account;
    const { zebra, other } = await seed(page);
    await createEdge(page.request, { source_id: zebra.id, target_id: other.id, label: "blocks", source_handle: "right", target_handle: "left" });
    await page.keyboard.press("Control+k");
    await box(page).fill("zebra");
    await expect(dialog(page).locator(".rc-hit-links")).toContainText("blocks · Unrelated");
  });

  test("finds cards on every mindmap of the account", async ({ page, account }) => {
    void account;
    await seed(page);
    const second = await createBoard(page.request, "Second map");
    await createNode(page.request, second.id, { title: "Okapi plan", body: "zebra stripes comparison", x: 0, y: 0 });
    await page.keyboard.press("Control+k");
    await box(page).fill("zebra");
    await expect(dialog(page).locator(".rc-hit")).toHaveCount(2);
    await expect(dialog(page).locator(".rc-hit-meta").filter({ hasText: "Second map" })).toHaveCount(1);
    await expect(dialog(page).locator(".rc-hit-meta").filter({ hasText: "Infra notes" })).toHaveCount(1);
  });

  test("never returns another account's cards", async ({ page, account, existing }) => {
    void account;
    await seed(page);
    const theirs = await createBoard(existing.request, "Their secrets");
    await createNode(existing.request, theirs.id, { title: "Zebra of theirs", body: "zebra zebra zebra", x: 0, y: 0 });
    await page.keyboard.press("Control+k");
    await box(page).fill("zebra");
    await expect(dialog(page).locator(".rc-hit-title")).toHaveText(["Zebra migration"]);
  });
});

test.describe("choosing a result", () => {
  test("clicking a hit opens its mindmap with the card open", async ({ page, account }) => {
    void account;
    const { board, zebra } = await seed(page);
    const elsewhere = await createBoard(page.request, "Elsewhere");
    await page.goto(`/app/${elsewhere.id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Elsewhere" })).toBeVisible();

    await page.keyboard.press("Control+k");
    await box(page).fill("zebra");
    await dialog(page).locator(".rc-hit").first().click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/app/${board.id}\\?card=${zebra.id}`));
    await expect(page.locator(".card-doc .ProseMirror")).toContainText("quagga cluster");
  });

  test("a hit on the mindmap you are already looking at opens its card in place", async ({ page, account }) => {
    void account;
    const { zebra } = await seed(page);
    await page.keyboard.press("Control+k");
    await box(page).fill("quagga");
    await dialog(page).locator(".rc-hit").first().click();
    await expect(page.locator(`.react-flow__node[data-id="${zebra.id}"] .card-doc`)).toBeVisible();
  });

  test("arrow keys move the highlight and Enter opens the highlighted hit", async ({ page, account }) => {
    void account;
    const { board } = await seed(page);
    const third = await createNode(page.request, board.id, { title: "Zebra crossing", body: "zebra", x: 800, y: 0 });
    await page.keyboard.press("Control+k");
    await box(page).fill("zebra");
    const hits = dialog(page).locator(".rc-hit");
    await expect(hits).toHaveCount(2);
    await expect(hits.nth(0)).toHaveClass(/on/);

    await page.keyboard.press("ArrowDown");
    await expect(hits.nth(1)).toHaveClass(/on/);
    await expect(hits.nth(0)).not.toHaveClass(/on/);
    const chosen = (await hits.nth(1).locator(".rc-hit-title").textContent())!;
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/card=/);
    const opened = await page.locator(".card-doc .doc-title").inputValue();
    expect(opened).toBe(chosen);
    void third;

    // and Up goes back
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await box(page).fill("zebra");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await expect(dialog(page).locator(".rc-hit").nth(0)).toHaveClass(/on/);
  });
});
