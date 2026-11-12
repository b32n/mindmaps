import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import { createNode } from "../../support/api";

test.describe("creating cards and notes", () => {
  test("the Add card button puts a titled-later card in view and stores it", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const id = await board.addCard();

    await expect(board.nodes()).toHaveCount(1);
    await expect(board.node(id)).toHaveClass(/react-flow__node-card/);
    await expect(board.title(id)).toHaveValue("");
    await expect(board.title(id)).toHaveAttribute("placeholder", "Untitled");
    await expect(page.locator(".topbar-meta")).toHaveText("1 card");

    const saved = await board.savedNode(id);
    expect(saved.type).toBe("card");
    // it landed inside the visible canvas, not off in space
    const pane = (await board.pane.boundingBox())!;
    const box = await board.box(id);
    expect(box.x).toBeGreaterThanOrEqual(pane.x);
    expect(box.y).toBeGreaterThanOrEqual(pane.y);
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
  });

  test("the Add note button makes a sticky note, which does not count as a card", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const id = await board.addNote();

    await expect(board.node(id)).toHaveClass(/react-flow__node-note/);
    await expect(board.noteText(id)).toHaveAttribute("placeholder", "Note…");
    await expect(page.locator(".topbar-meta")).toHaveText("0 cards");
    expect((await board.savedNode(id)).type).toBe("note");
  });

  test("repeated clicks do not stack new cards on top of each other", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const ids = [await board.addCard(), await board.addCard(), await board.addCard()];

    const boxes = await Promise.all(ids.map((id) => board.box(id)));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `card ${i} overlaps card ${j}`).toBe(false);
      }
  });

  test("keyboard: C adds a card and N adds a note", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await board.canvas.click({ position: { x: 20, y: 20 } }); // focus the page body, not an input

    const card = await board.addVia(() => page.keyboard.press("c"));
    expect(await board.savedNode(card)).toMatchObject({ type: "card" });
    const note = await board.addVia(() => page.keyboard.press("n"));
    expect(await board.savedNode(note)).toMatchObject({ type: "note" });
    await expect(board.nodes()).toHaveCount(2);
  });

  test("keyboard shortcuts are ignored while typing in a field", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const id = await board.addCard();

    await board.title(id).click();
    await page.keyboard.type("cnc cards need coffee");
    await expect(board.title(id)).toHaveValue("cnc cards need coffee");
    await expect(board.nodes()).toHaveCount(1);
  });

  test("keyboard shortcuts with a modifier do nothing", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await board.canvas.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+n");
    await expect(board.nodes()).toHaveCount(0);
    expect((await board.saved()).nodes).toHaveLength(0);
  });

  test("double-clicking empty canvas creates a card under the pointer", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const pane = (await board.pane.boundingBox())!;
    const at = { x: pane.x + 300, y: pane.y + 250 };

    const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/nodes"));
    await page.mouse.dblclick(at.x, at.y);
    const node = await (await created).json();

    await expect(board.node(node.id)).toBeVisible();
    // An empty board opens at the origin at 100%, so board coordinates are the
    // click's offset within the pane; the card is centred on it (130,70 is half
    // a card). Read the server's copy: the first card on a board also makes the
    // canvas re-fit, so screen positions move afterwards.
    const saved = await board.savedNode(node.id);
    expect(saved).toMatchObject({ type: "card", x: at.x - pane.x - 130, y: at.y - pane.y - 70 });
  });

  test("double-clicking a card opens it instead of creating another", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const id = await board.addCard();
    await board.node(id).dblclick({ position: { x: 130, y: 100 } });
    await expect(board.editor).toBeVisible();
    await expect(board.nodes()).toHaveCount(1);
  });

  test("double-clicking text inside a card does not spawn a card either", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const id = await board.addCard();
    await board.title(id).fill("select me");
    await board.title(id).dblclick();
    await expect(board.nodes()).toHaveCount(1);
  });

  test("created cards survive a reload, in the same place", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const card = await board.addCard();
    const note = await board.addNote();
    const before = await Promise.all([card, note].map((id) => board.savedNode(id)));

    await page.reload();
    await board.ready();
    await expect(board.nodes()).toHaveCount(2);
    for (const n of before) {
      const after = await board.savedNode(n.id);
      expect([after.x, after.y, after.type]).toEqual([n.x, n.y, n.type]);
      await expect(board.node(n.id)).toBeVisible();
    }
  });

  test("the card counter counts cards, not notes or ink", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page);
    await createNode(page.request, record.id, { type: "card", title: "A", x: 0, y: 0 });
    await createNode(page.request, record.id, { type: "card", title: "B", x: 300, y: 0 });
    await createNode(page.request, record.id, { type: "note", title: "N", x: 600, y: 0 });
    await board.open();
    await expect(page.locator(".topbar-meta")).toHaveText("2 cards");
  });
});

test.describe("other things the dock can add", () => {
  const kinds: Array<[label: string, type: string, key: string]> = [
    ["Add sheet", "sheet", "s"],
    ["Add document", "doc", "d"],
    ["Add deck", "deck", "k"],
    ["Add page", "html", "h"],
    ["Add file", "file", "f"],
    ["Add folder", "folder", "o"],
  ];
  for (const [label, type, key] of kinds) {
    test(`${label}: button and “${key.toUpperCase()}” both create a ${type} node`, async ({ page, account }) => {
      void account;
      const { board } = await Board.create(page);
      const viaButton = await board.addVia(() => page.getByRole("button", { name: label }).click());
      expect((await board.savedNode(viaButton)).type).toBe(type);

      await board.canvas.click({ position: { x: 20, y: 20 } });
      const viaKey = await board.addVia(() => page.keyboard.press(key));
      expect((await board.savedNode(viaKey)).type).toBe(type);
      await expect(board.nodes()).toHaveCount(2);
    });
  }
});
