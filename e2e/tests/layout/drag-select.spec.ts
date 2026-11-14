import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import { createEdge, createNode } from "../../support/api";
import type { Page } from "@playwright/test";

/** Within a few screen pixels (converted to board units): the first mouse move of a drag is not counted. */
const near = (got: number, want: number, zoom: number) => expect(Math.abs(got - want)).toBeLessThan(6 / zoom);

// Dragging on a React Flow canvas needs a real mouse with intermediate moves.
// Assertions read the position the server saved (what a reload would show), so
// they do not depend on animation timing.

async function cards(page: Page, n: number, extra: Partial<Parameters<typeof createNode>[2]> = {}) {
  const { board, record } = await Board.create(page);
  const nodes = [];
  for (let i = 0; i < n; i++)
    nodes.push(await createNode(page.request, record.id, { title: `Card ${i + 1}`, x: i * 400, y: 100, ...extra }));
  await board.open();
  return { board, nodes };
}

test.describe("dragging cards", () => {
  test("moves the card by the distance dragged and saves the new position", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 1);
    const { zoom } = await board.viewport();

    const { before, after } = await board.drag(nodes[0].id, 150, 80);
    near(after.x - before.x, 150 / zoom, zoom);
    near(after.y - before.y, 80 / zoom, zoom);
  });

  test("the position is the same after a reload, on screen and on the server", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 2);
    const { after } = await board.drag(nodes[0].id, -60, 120);
    const other = await board.savedNode(nodes[1].id);

    await page.reload();
    await board.ready();
    expect(await board.savedNode(nodes[0].id)).toMatchObject({ x: after.x, y: after.y });
    expect(await board.savedNode(nodes[1].id)).toMatchObject({ x: other.x, y: other.y }); // untouched

    // on screen, relative to its neighbour: the same offset as in the saved data
    const [a, b] = await Promise.all([board.box(nodes[0].id), board.box(nodes[1].id)]);
    const { zoom } = await board.viewport();
    near((a.x - b.x) / zoom, after.x - other.x, zoom);
    near((a.y - b.y) / zoom, after.y - other.y, zoom);
  });

  test("a note can be dragged too", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page);
    const note = await createNode(page.request, record.id, { type: "note", title: "n", x: 100, y: 100 });
    await board.open();
    const { before, after } = await board.drag(note.id, 100, 100);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
  });

  test("dragging back to where it started saves that position again", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 1);
    const start = await board.savedNode(nodes[0].id);
    await board.drag(nodes[0].id, 200, 0);
    const back = await board.drag(nodes[0].id, -200, 0);
    expect(Math.abs(back.after.x - start.x)).toBeLessThan(8);
  });

  test("a click without movement saves no position", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 1);
    const moves: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "PATCH" && /"x":/.test(r.postData() ?? "")) moves.push(r.url());
    });
    await board.node(nodes[0].id).click({ position: { x: 6, y: 6 } });
    await expect(board.node(nodes[0].id)).toHaveClass(/selected/);
    // a later, observable save acts as the barrier: by now any move would have been sent
    const saved = board.savedField(nodes[0].id, "title", "barrier");
    await board.title(nodes[0].id).fill("barrier");
    await saved;
    expect(moves).toEqual([]);
  });

  test("the title field is not a drag handle: dragging in it selects text instead", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 1);
    const before = await board.savedNode(nodes[0].id);
    const title = board.title(nodes[0].id);
    const box = (await title.boundingBox())!;
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    expect(await board.savedNode(nodes[0].id)).toMatchObject({ x: before.x, y: before.y });
  });

  test("a dragged card keeps its links attached", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 2);
    await createEdge(page.request, { source_id: nodes[0].id, target_id: nodes[1].id, source_handle: "right", target_handle: "left" });
    await board.open();
    const edge = page.locator(".react-flow__edge-labelled path.react-flow__edge-path");
    const before = await edge.getAttribute("d");
    await board.drag(nodes[1].id, 0, 200);
    await expect.poll(() => edge.getAttribute("d")).not.toBe(before);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  });
});

test.describe("selection", () => {
  test("clicking a card selects it; clicking empty canvas clears the selection", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 2);
    await board.node(nodes[0].id).click({ position: { x: 6, y: 6 } });
    await expect(board.node(nodes[0].id)).toHaveClass(/selected/);
    await expect(board.node(nodes[1].id)).not.toHaveClass(/selected/);

    await board.node(nodes[1].id).click({ position: { x: 6, y: 6 } });
    await expect(board.node(nodes[1].id)).toHaveClass(/selected/);
    await expect(board.node(nodes[0].id)).not.toHaveClass(/selected/);

    const pane = (await board.pane.boundingBox())!;
    await page.mouse.click(pane.x + 20, pane.y + 20);
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  });

  test("Ctrl+click adds to the selection", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 3);
    await board.node(nodes[0].id).click({ position: { x: 6, y: 6 } });
    await board.node(nodes[2].id).click({ position: { x: 6, y: 6 }, modifiers: ["Control"] });
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
    await expect(board.node(nodes[1].id)).not.toHaveClass(/selected/);
  });

  test("Shift+drag on empty canvas draws a selection box around what it touches", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 3);
    const a = await board.box(nodes[0].id);
    const b = await board.box(nodes[1].id);
    const pane = (await board.pane.boundingBox())!;
    const from = { x: Math.max(pane.x + 4, a.x - 20), y: Math.max(pane.y + 4, a.y - 30) };

    await page.keyboard.down("Shift");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width + 20, b.y + b.height + 20, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Shift");

    await expect(board.node(nodes[0].id)).toHaveClass(/selected/);
    await expect(board.node(nodes[1].id)).toHaveClass(/selected/);
    await expect(board.node(nodes[2].id)).not.toHaveClass(/selected/);
  });

  test("dragging one of several selected cards moves them all, and each position is saved", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 3);
    const before = await Promise.all(nodes.map((n) => board.savedNode(n.id)));
    await board.node(nodes[0].id).click({ position: { x: 6, y: 6 } });
    await board.node(nodes[1].id).click({ position: { x: 6, y: 6 }, modifiers: ["Control"] });

    const savedBoth = Promise.all(
      [nodes[0], nodes[1]].map((n) => board.savedField(n.id, "x")),
    );
    const { zoom } = await board.viewport();
    const box = await board.box(nodes[0].id);
    await page.mouse.move(box.x + 6, box.y + 6);
    await page.mouse.down();
    await page.mouse.move(box.x + 9, box.y + 9);
    await page.mouse.move(box.x + 70, box.y + 60, { steps: 10 });
    await page.mouse.move(box.x + 6 + 120, box.y + 6 + 90, { steps: 6 });
    await page.mouse.up();
    await savedBoth;

    const after = await Promise.all(nodes.map((n) => board.savedNode(n.id)));
    for (const i of [0, 1]) {
      near(after[i].x - before[i].x, 120 / zoom, zoom);
      near(after[i].y - before[i].y, 90 / zoom, zoom);
    }
    expect(after[2]).toMatchObject({ x: before[2].x, y: before[2].y });
  });

  test("Backspace deletes every selected card", async ({ page, account }) => {
    void account;
    const { board, nodes } = await cards(page, 3);
    await board.node(nodes[0].id).click({ position: { x: 6, y: 6 } });
    await board.node(nodes[1].id).click({ position: { x: 6, y: 6 }, modifiers: ["Control"] });
    await page.keyboard.press("Backspace");

    await expect(board.nodes()).toHaveCount(1);
    await expect.poll(async () => (await board.saved()).nodes.map((n) => n.id)).toEqual([nodes[2].id]);
  });
});
