import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The sheet editor draws its grid on one <canvas>, so cells are not elements.
 * What the DOM does expose is the formula bar, which shows the selected cell's
 * content. These helpers select a cell by clicking where Spindle draws it and
 * then use the formula bar as the thing to wait on.
 *
 * Geometry is the library's defaults, measured from the canvas's own box (not
 * from fixed screen positions): a 20px column-header row, 100px row-header
 * column, 110px wide and 24px tall cells.
 */
const HEADER_H = 20;
const ROW_HEADER_W = 100;
const COL_W = 110;
const ROW_H = 24;

export function formulaBar(page: Page): Locator {
  return page.getByPlaceholder("Enter formula or value");
}

/** `"B4"` -> zero-based column and row. Single-letter columns only. */
function parse(ref: string) {
  const m = /^([A-Z])(\d+)$/.exec(ref);
  if (!m) throw new Error(`unsupported cell reference ${ref}`);
  return { col: m[1].charCodeAt(0) - 65, row: Number(m[2]) - 1 };
}

/** Click a cell so it becomes the selection. Resolves once the formula bar reflects it. */
export async function selectCell(page: Page, ref: string, expected?: string | RegExp) {
  const { col, row } = parse(ref);
  const box = await page.locator("canvas").first().boundingBox();
  expect(box, "the sheet canvas is on screen").not.toBeNull();
  await page.mouse.click(
    box!.x + ROW_HEADER_W + col * COL_W + COL_W / 2,
    box!.y + HEADER_H + row * ROW_H + ROW_H / 2,
  );
  if (expected !== undefined) await expect(formulaBar(page)).toHaveValue(expected);
}

/** Type into a cell and commit with Enter; resolves when the editor's autosave has been answered. */
export async function typeInCell(page: Page, nodeId: string, ref: string, text: string) {
  await selectCell(page, ref);
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/artefacts/${nodeId}`) && r.ok(),
  );
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await saved;
}

/**
 * A cell as stored, found by its position. The seeded payload keys cells
 * "row:col"; once the editor has saved, keys are "<rowId>:<colId>" and
 * `rowOrder` / `colOrder` list `[index, id]` pairs.
 */
export function storedCell(workbook: any, sheet: number, ref: string): { value: unknown; formula?: string } | undefined {
  const { col, row } = parse(ref);
  const s = workbook.sheets[sheet];
  const plain = s.cells.find((c: any) => c.key === `${row}:${col}`);
  if (plain) return plain.cell;
  const idAt = (order: [number, string][], i: number) => order.find(([n]) => n === i)?.[1];
  const key = `${idAt(s.rowOrder, row)}:${idAt(s.colOrder, col)}`;
  return s.cells.find((c: any) => c.key === key)?.cell;
}
