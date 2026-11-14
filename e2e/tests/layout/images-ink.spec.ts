import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import { createNode } from "../../support/api";
import { dropImage, pasteImage, PIXEL_PNG } from "../../support/files";
import type { Page } from "@playwright/test";

const created = (page: Page, type: string) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/api/nodes") &&
      (r.request().postDataJSON() as { type: string }).type === type,
  );

test.describe("images on the board", () => {
  test("pasting an image puts it on the canvas, stored in the app, with its file name", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await board.canvas.click({ position: { x: 20, y: 20 } });

    const made = created(page, "image");
    await pasteImage(page, "screenshot.png");
    const node = await (await made).json();

    await expect(board.node(node.id).locator("img")).toHaveAttribute("src", /\/api\/images\/[\w-]+\.png$/);
    await expect(board.node(node.id).locator("img")).toHaveAttribute("alt", "screenshot.png");
    await expect.poll(() => board.node(node.id).locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1);
    const saved = await board.savedNode(node.id);
    expect(saved).toMatchObject({ type: "image", title: "screenshot.png" });
    expect(String(saved.data.url)).toContain("/api/images/");

    // a 1x1 image is not scaled up: the node is as big as the picture
    expect([saved.w, saved.h]).toEqual([1, 1]);
  });

  test("the pasted image is served back byte for byte", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const made = created(page, "image");
    await pasteImage(page);
    const node = await (await made).json();
    const res = await page.request.get(String(node.data.url));
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(Buffer.compare(await res.body(), PIXEL_PNG)).toBe(0);
    void board;
  });

  test("it survives a reload", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const made = created(page, "image");
    await pasteImage(page);
    const node = await (await made).json();
    await page.reload();
    await board.ready();
    // (a 1x1 picture has no visible area, so check it is there and loaded)
    await expect(board.node(node.id).locator("img")).toBeAttached();
    await expect.poll(() => board.node(node.id).locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1);
  });

  test("dropping an image file on the canvas puts it under the pointer", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const pane = (await board.pane.boundingBox())!;
    const made = created(page, "image");
    await dropImage(page, { x: pane.x + 400, y: pane.y + 300 }, "dropped.png");
    const node = await (await made).json();
    // empty board: origin at the pane's corner, zoom 100%
    expect(node).toMatchObject({ type: "image", title: "dropped.png", x: 400, y: 300 });
    await expect(board.node(node.id)).toBeVisible();
  });

  test("a file that is not an image is ignored", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await board.canvas.click({ position: { x: 20, y: 20 } });
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    // barrier: the next real action is observable, by which time a stray upload would have happened
    await board.addCard();
    expect((await board.saved()).nodes.map((n) => n.type)).toEqual(["card"]);
  });

  test("pasting while a text field has focus leaves the board alone", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const id = await board.addCard();
    await board.title(id).click();
    await pasteImage(page);
    await board.addNote(); // barrier
    expect((await board.saved()).nodes.map((n) => n.type).sort()).toEqual(["card", "note"]);
  });

  test("an image can be resized with its corner handle and the size is saved", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page);
    const up = await page.request.post("/api/images", { data: PIXEL_PNG, headers: { "content-type": "image/png" } });
    const { url } = await up.json();
    const img = await createNode(page.request, record.id, { type: "image", title: "pic", x: 100, y: 100, w: 200, h: 200, data: { url } });
    await board.open();

    await board.node(img.id).click({ position: { x: 20, y: 20 } });
    const handle = board.node(img.id).locator(".react-flow__resize-control.handle.bottom.right");
    await expect(handle).toBeVisible();
    const h = (await handle.boundingBox())!;
    const { zoom } = await board.viewport();

    const saved = board.savedField(img.id, "w");
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 5, h.y + h.height / 2 + 5);
    await page.mouse.move(h.x + h.width / 2 + 100, h.y + h.height / 2 + 100, { steps: 10 });
    await page.mouse.up();
    await saved;

    const after = await board.savedNode(img.id);
    expect(after.w).toBeGreaterThan(200 + 60 / zoom);
    expect(after.w / after.h).toBeCloseTo(1, 1); // aspect ratio is kept
    await page.reload();
    await board.ready();
    const box = await board.box(img.id);
    const z = (await board.viewport()).zoom;
    expect(box.width / z).toBeCloseTo(after.w, 0);
  });

  test("an image can be deleted with its ×", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const made = created(page, "image");
    await pasteImage(page);
    const node = await (await made).json();
    await board.node(node.id).hover();
    await board.deleteButton(node.id).click();
    await expect(board.node(node.id)).toHaveCount(0);
    await expect.poll(async () => (await board.saved()).nodes.length).toBe(0);
  });

  test("pasting an image is undoable", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const made = created(page, "image");
    await pasteImage(page);
    const node = await (await made).json();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(board.node(node.id)).toHaveCount(0);
  });
});

test.describe("drawing", () => {
  async function stroke(page: Page, board: Board, from: { x: number; y: number }, to: { x: number; y: number }) {
    const made = created(page, "stroke");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, from.y + 30, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    return (await (await made).json()) as { id: string; x: number; y: number; w: number; h: number; data: { points: unknown[]; color: string; size: number } };
  }

  test("the Pen tool turns drags into stroke nodes stored with their points", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const select = page.getByRole("button", { name: "Select", exact: true });
    const pen = page.getByRole("button", { name: "Pen", exact: true });
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await pen.click();
    await expect(pen).toHaveAttribute("aria-pressed", "true");
    await expect(select).toHaveAttribute("aria-pressed", "false");

    const pane = (await board.pane.boundingBox())!;
    const s = await stroke(page, board, { x: pane.x + 200, y: pane.y + 200 }, { x: pane.x + 420, y: pane.y + 260 });
    expect(s.data.points.length).toBeGreaterThan(2);
    expect(s.w).toBeGreaterThan(150);
    await expect(board.node(s.id).locator("svg path").first()).toBeAttached();
    expect((await board.savedNode(s.id)).type).toBe("stroke");

    await page.reload();
    await board.ready();
    await expect(board.node(s.id).locator("svg path").first()).toBeAttached();
  });

  test("colour and size chosen in the pen's popover (by keyboard) are stored on the stroke", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await page.getByRole("button", { name: "Pen", exact: true }).click();
    // Activated from the keyboard: a mouse press on the popover closes it, see the fixme below.
    await page.getByRole("button", { name: "Colour #b3261e" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Size 14" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Colour #b3261e" })).toHaveClass(/on/);
    await expect(page.getByRole("button", { name: "Size 14" })).toHaveClass(/on/);

    const pane = (await board.pane.boundingBox())!;
    const s = await stroke(page, board, { x: pane.x + 200, y: pane.y + 150 }, { x: pane.x + 400, y: pane.y + 150 });
    expect(s.data).toMatchObject({ color: "#b3261e", size: 14 });
  });

  // BUG: with a mouse, a swatch or size in the pen popover cannot be picked.
  // Toolbar closes the popover on any `pointerdown` that lands outside `.dock`,
  // but the popover is a sibling of `.dock`, not inside it, so pressing a swatch
  // closes the popover before the click completes and the choice is never made.
  // Observed: Pen, click "Colour #b3261e" -> the popover is gone (.dock-pop count
  // 0) and, reopened, no swatch is marked on; same for sizes (Size 4 stays on).
  test.fixme("clicking a colour in the pen popover applies it", async ({ page, account }) => {
    void account;
    await Board.create(page);
    await page.getByRole("button", { name: "Pen", exact: true }).click();
    await page.getByRole("button", { name: "Colour #b3261e" }).click();
    await expect(page.getByRole("button", { name: "Colour #b3261e" })).toHaveClass(/on/);
  });

  test("keyboard: P selects the pen, E the eraser, V goes back to select", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await board.canvas.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("p");
    await expect(page.getByRole("button", { name: "Pen", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("e");
    await expect(page.getByRole("button", { name: "Eraser", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("v");
    await expect(page.getByRole("button", { name: "Select", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("while the pen is active, dragging over a card draws instead of moving it", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page);
    const card = await createNode(page.request, record.id, { title: "Still", x: 300, y: 300 });
    await board.open();
    const before = await board.savedNode(card.id);
    await page.getByRole("button", { name: "Pen", exact: true }).click();

    const box = await board.box(card.id);
    await stroke(page, board, { x: box.x + 20, y: box.y + 20 }, { x: box.x + 120, y: box.y + 60 });
    expect(await board.savedNode(card.id)).toMatchObject({ x: before.x, y: before.y });
    expect((await board.saved()).nodes.map((n) => n.type).sort()).toEqual(["card", "stroke"]);
  });

  test("while the pen is active a double-click does not create a card", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await page.getByRole("button", { name: "Pen", exact: true }).click();
    const pane = (await board.pane.boundingBox())!;
    await page.mouse.dblclick(pane.x + 80, pane.y + 80);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await board.addNote(); // barrier: a card made by the double-click would have been saved by now
    expect((await board.saved()).nodes.map((n) => n.type)).toEqual(["note"]);
  });

  test("the Eraser deletes the stroke it passes over, and undo brings it back", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await page.getByRole("button", { name: "Pen", exact: true }).click();
    const pane = (await board.pane.boundingBox())!;
    const s = await stroke(page, board, { x: pane.x + 200, y: pane.y + 200 }, { x: pane.x + 420, y: pane.y + 200 });

    await page.getByRole("button", { name: "Eraser", exact: true }).click();
    // The first node on a board makes the canvas re-fit, so aim at where the stroke is now.
    const at = await board.box(s.id);
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    await page.mouse.move(at.x + at.width / 2 + 5, at.y + at.height / 2, { steps: 3 });
    await page.mouse.up();
    await expect(board.node(s.id)).toHaveCount(0);
    await expect.poll(async () => (await board.saved()).nodes.length).toBe(0);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(board.node(s.id)).toHaveCount(1);
    await expect.poll(async () => (await board.saved()).nodes.length).toBe(1);
  });

  test("a stroke can be undone straight after drawing it", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await page.getByRole("button", { name: "Pen", exact: true }).click();
    const pane = (await board.pane.boundingBox())!;
    const s = await stroke(page, board, { x: pane.x + 200, y: pane.y + 200 }, { x: pane.x + 420, y: pane.y + 200 });
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(board.node(s.id)).toHaveCount(0);
  });
});
