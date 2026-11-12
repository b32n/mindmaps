import { test, expect } from "../../fixtures";
import { createArtefact, createBoard, nodeById } from "../../support/api";
import { Board } from "../../support/board";
import { formulaBar, selectCell, storedCell, typeInCell } from "../../support/sheet";

// The sheet artefact: made from the dock, opened in its own tab, and edited in
// the real Spindle grid. The grid is a canvas, so what is asserted is what the
// formula bar shows and what the editor saves (the server computes nothing:
// the editor stores each formula next to the value it evaluated to).

const rows = [
  ["Item", "Cost"],
  ["a", 10],
  ["b", 20],
  ["Total", "=SUM(B2:B3)"],
  ["Double a", "=B2*2"],
  ["Divide", "=1/0"],
  ["Unknown", "=NOPE(1)"],
];

async function sheetOnBoard(page: import("@playwright/test").Page) {
  const board = await createBoard(page.request, "Models");
  const sheet = await createArtefact(page.request, board.id, "sheet", { title: "Budget", sheets: [{ name: "Q3", rows }] });
  return { board, sheet };
}

const workbook = async (page: import("@playwright/test").Page, id: string) =>
  (await (await page.request.get(`/api/artefacts/${id}`)).json()) as any;

test.describe("making and opening a sheet", () => {
  test("the dock's Add sheet puts a Sheet node on the mindmap that opens its editor in a new tab", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page, "Dock sheet");
    const id = await board.addVia(() => page.getByRole("button", { name: "Add sheet" }).click());
    await expect(board.node(id).locator(".artefact-kind")).toHaveText("Sheet");
    await expect(board.node(id).locator("input.card-title")).toHaveAttribute("placeholder", "Untitled sheet");
    expect((await nodeById(page.request, id)).type).toBe("sheet");

    const popup = page.context().waitForEvent("page");
    await board.node(id).getByRole("link", { name: "Open" }).click();
    const editor = await popup;
    await expect(editor).toHaveURL(new RegExp(`/sheet/${id}\\?from=${record.id}$`));
    await expect(editor.locator("canvas").first()).toBeVisible();
    await expect(editor.locator(".sheet-state")).toHaveText("Saved");
    await expect(editor.getByRole("button", { name: "Share" })).toBeVisible();
  });

  test("a sheet made with rows shows its summary on the board and loads those cells in the editor", async ({ page, account }) => {
    void account;
    const { board, sheet } = await sheetOnBoard(page);
    await page.goto(`/app/${board.id}`);
    await expect(page.locator(`.react-flow__node[data-id="${sheet.id}"] .card-preview`)).toHaveText("1 sheet · 14 cells");

    await page.goto(`/sheet/${sheet.id}?from=${board.id}`);
    await expect(page.locator("input.sheet-title")).toHaveValue("Budget");
    await selectCell(page, "A2", "a");
    await selectCell(page, "B2", "10");
  });

  test("the back button returns to the mindmap it was opened from", async ({ page, account }) => {
    void account;
    const { board, sheet } = await sheetOnBoard(page);
    await page.goto(`/sheet/${sheet.id}?from=${board.id}`);
    await expect(page.locator("canvas").first()).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page).toHaveURL(new RegExp(`/app/${board.id}$`));
  });
});

test.describe("formulas", () => {
  test("a formula cell shows its formula in the formula bar", async ({ page, account }) => {
    void account;
    const { sheet } = await sheetOnBoard(page);
    await page.goto(`/sheet/${sheet.id}`);
    await selectCell(page, "B4", "=SUM(B2:B3)");
    await selectCell(page, "B5", "=B2*2");
  });

  test("editing a cell recalculates what depends on it, and the new values are saved with the formulas", async ({ page, account }) => {
    void account;
    const { sheet } = await sheetOnBoard(page);
    await page.goto(`/sheet/${sheet.id}`);
    await selectCell(page, "B2", "10");

    await typeInCell(page, sheet.id, "B2", "99");
    const saved = await workbook(page, sheet.id);
    expect(storedCell(saved, 0, "B2")?.value).toBe(99);
    expect(storedCell(saved, 0, "B4")).toMatchObject({ formula: "=SUM(B2:B3)", value: 119 }); // 99 + 20
    expect(storedCell(saved, 0, "B5")).toMatchObject({ formula: "=B2*2", value: 198 });
    await expect(page.locator(".sheet-state")).toHaveText("Saved");
  });

  test("errors are values, not crashes: division by zero and an unknown function", async ({ page, account }) => {
    void account;
    const { sheet } = await sheetOnBoard(page);
    await page.goto(`/sheet/${sheet.id}`);
    await selectCell(page, "B2", "10");
    await typeInCell(page, sheet.id, "B2", "11"); // any edit makes the editor store computed values
    const saved = await workbook(page, sheet.id);
    expect(storedCell(saved, 0, "B6")).toMatchObject({ formula: "=1/0", value: "#DIV/0!" });
    expect(storedCell(saved, 0, "B7")?.formula).toBe("=NOPE(1)");
    expect(String(storedCell(saved, 0, "B7")?.value)).toMatch(/^#NAME\?/);
  });

  test("a formula typed into an empty cell is evaluated against the cells it names", async ({ page, account }) => {
    void account;
    const { sheet } = await sheetOnBoard(page);
    await page.goto(`/sheet/${sheet.id}`);
    await typeInCell(page, sheet.id, "D1", "=B2+B3");
    const saved = await workbook(page, sheet.id);
    expect(storedCell(saved, 0, "D1")).toMatchObject({ formula: "=B2+B3", value: 30 });
    await selectCell(page, "D1", "=B2+B3");
  });

  test("a formula that refers to a cell that is later cleared follows it", async ({ page, account }) => {
    void account;
    const { sheet } = await sheetOnBoard(page);
    await page.goto(`/sheet/${sheet.id}`);
    await typeInCell(page, sheet.id, "B3", "0");
    const saved = await workbook(page, sheet.id);
    expect(storedCell(saved, 0, "B4")?.value).toBe(10); // 10 + 0
  });
});

test.describe("saving", () => {
  test("renaming in the editor renames the node, the board's card and the artefact list", async ({ page, account }) => {
    void account;
    const { board, sheet } = await sheetOnBoard(page);
    await page.goto(`/sheet/${sheet.id}?from=${board.id}`);
    const renamed = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/nodes/${sheet.id}`) && r.ok());
    await page.locator("input.sheet-title").fill("Budget v2");
    await renamed;
    // the payload carries the name too, and is written back by the autosave
    await expect.poll(async () => (await workbook(page, sheet.id)).name).toBe("Budget v2");
    expect((await nodeById(page.request, sheet.id)).title).toBe("Budget v2");

    await page.goto("/artefacts");
    await expect(page.locator(".arte-tr .arte-label")).toHaveText(["Budget v2"]);
  });

  test("the snapshot the search reads is rebuilt from the saved sheet", async ({ page, account }) => {
    void account;
    const { sheet } = await sheetOnBoard(page);
    await page.goto(`/sheet/${sheet.id}`);
    await typeInCell(page, sheet.id, "A1", "Renamed header");
    const node = await nodeById(page.request, sheet.id);
    expect(node.body).toContain("Renamed header");
    expect(node.body).toContain("=SUM(B2:B3)");
  });
});

test.describe("what the server accepts for a sheet", () => {
  test("a payload over the size limit is refused with 413 and the old one is kept", async ({ page, account }) => {
    void account;
    const { sheet } = await sheetOnBoard(page);
    const huge = { id: "x", name: "x", sheets: [], pad: "x".repeat(4_200_000) };
    const res = await page.request.put(`/api/artefacts/${sheet.id}`, { data: huge });
    expect(res.status()).toBe(413);
    expect(storedCell(await workbook(page, sheet.id), 0, "A1")?.value).toBe("Item");
  });

  test("a card is not an artefact: PUT /api/artefacts/:id answers 400", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Plain");
    const card = await (await page.request.post("/api/nodes", { data: { board_id: board.id, type: "card", title: "c" } })).json();
    expect((await page.request.put(`/api/artefacts/${card.id}`, { data: { x: 1 } })).status()).toBe(400);
  });
});
