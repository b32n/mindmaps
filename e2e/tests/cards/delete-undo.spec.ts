import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import { createBoard, createEdge, createNode, trash } from "../../support/api";

async function twoLinkedCards(page: import("@playwright/test").Page) {
  const { board, record } = await Board.create(page);
  const a = await createNode(page.request, record.id, { title: "Alpha", x: 0, y: 0 });
  const b = await createNode(page.request, record.id, { title: "Beta", x: 450, y: 0 });
  const edge = await createEdge(page.request, {
    source_id: a.id,
    target_id: b.id,
    label: "blocks",
    source_handle: "right",
    target_handle: "left",
  });
  await board.open();
  return { board, a, b, edge };
}

const undo = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Undo" });
const redo = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Redo" });

test.describe("deleting", () => {
  test("the × on a card removes it from the board and from the server", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page);
    const keep = await createNode(page.request, record.id, { title: "Keep", x: 0, y: 0 });
    const doomed = await createNode(page.request, record.id, { title: "Doomed", x: 400, y: 0 });
    await board.open();

    await board.node(doomed.id).hover();
    const gone = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/api/nodes/${doomed.id}`));
    await board.deleteButton(doomed.id).click();
    await gone;

    await expect(board.node(doomed.id)).toHaveCount(0);
    await expect(board.node(keep.id)).toBeVisible();
    await expect(page.locator(".topbar-meta")).toHaveText("1 card");
    expect((await board.saved()).nodes.map((n) => n.id)).toEqual([keep.id]);
    await page.reload();
    await expect(board.nodes()).toHaveCount(1);
  });

  test("a note has its own ×", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page);
    const note = await createNode(page.request, record.id, { type: "note", title: "scrap", x: 0, y: 0 });
    await board.open();
    await board.node(note.id).hover();
    await board.deleteButton(note.id).click();
    await expect(board.node(note.id)).toHaveCount(0);
    await expect.poll(async () => (await board.saved()).nodes.length).toBe(0);
  });

  test("selecting a card and pressing Backspace deletes it", async ({ page, account }) => {
    void account;
    const { board, a, b } = await twoLinkedCards(page);
    // click the card's padding: not the title field, not a button
    await board.node(a.id).click({ position: { x: 6, y: 6 } });
    await expect(board.node(a.id)).toHaveClass(/selected/);
    await page.keyboard.press("Backspace");

    await expect(board.node(a.id)).toHaveCount(0);
    await expect(board.node(b.id)).toBeVisible();
    await expect.poll(async () => (await board.saved()).nodes.map((n) => n.id)).toEqual([b.id]);
  });

  test("Backspace while typing in a title edits the text and deletes nothing", async ({ page, account }) => {
    void account;
    const { board, a } = await twoLinkedCards(page);
    await board.title(a.id).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await expect(board.title(a.id)).toHaveValue("Alph");
    await expect(board.nodes()).toHaveCount(2);
  });

  test("deleting a card takes its links with it", async ({ page, account }) => {
    void account;
    const { board, a, edge } = await twoLinkedCards(page);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    await board.node(a.id).hover();
    await board.deleteButton(a.id).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await expect.poll(async () => (await board.saved()).edges.some((e) => e.id === edge.id)).toBe(false);
  });

  test("a deleted card lands in the trash with where it came from", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page, "Source board");
    const card = await createNode(page.request, record.id, { title: "Short-lived", x: 0, y: 0 });
    await board.open();
    await board.node(card.id).hover();
    await board.deleteButton(card.id).click();
    await expect(board.node(card.id)).toHaveCount(0);

    await expect.poll(async () => (await trash(page.request)).map((t) => t.label)).toContain("Short-lived");
    const entry = (await trash(page.request)).find((t) => t.id === card.id)!;
    expect(entry).toMatchObject({ kind: "node", node_type: "card", context: "Source board" });
  });

  test("deleting the open card closes it", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page);
    const card = await createNode(page.request, record.id, { title: "Open and doomed", x: 0, y: 0 });
    await board.open();
    await board.openCard(card.id);
    await page.keyboard.press("Escape");
    await board.node(card.id).hover();
    await board.deleteButton(card.id).click();
    await expect(board.node(card.id)).toHaveCount(0);
    await expect(page).not.toHaveURL(/card=/);
  });
});

test.describe("undo and redo", () => {
  test("both buttons start disabled on a fresh board", async ({ page, account }) => {
    void account;
    await Board.create(page);
    await expect(undo(page)).toBeDisabled();
    await expect(redo(page)).toBeDisabled();
  });

  test("undoing an added card removes it; redo brings back the same card", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const id = await board.addCard();
    await expect(undo(page)).toBeEnabled();
    await expect(redo(page)).toBeDisabled();

    await undo(page).click();
    await expect(board.node(id)).toHaveCount(0);
    await expect.poll(async () => (await board.saved()).nodes.length).toBe(0);
    await expect(redo(page)).toBeEnabled();

    await redo(page).click();
    await expect(board.node(id)).toBeVisible();
    expect((await board.savedNode(id)).id).toBe(id);
  });

  test("keyboard: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const id = await board.addCard();
    await board.canvas.click({ position: { x: 10, y: 10 } });

    // Undo sends its DELETE without waiting for it, so a redo pressed at once can
    // overtake it on the server. Wait for each request to land before the next key
    // (what a person's keystroke gap does); see Observations in the PR.
    const request = (method: string) =>
      page.waitForResponse((r) => r.request().method() === method && r.url().includes("/api/nodes") && r.ok());

    let sent = request("DELETE");
    await page.keyboard.press("Control+z");
    await expect(board.node(id)).toHaveCount(0);
    await sent;

    sent = request("POST");
    await page.keyboard.press("Control+Shift+z");
    await expect(board.node(id)).toBeVisible();
    await sent;

    sent = request("DELETE");
    await page.keyboard.press("Control+z");
    await expect(board.node(id)).toHaveCount(0);
    await sent;

    sent = request("POST");
    await page.keyboard.press("Control+y");
    await expect(board.node(id)).toBeVisible();
    await sent;
    expect((await board.savedNode(id)).id).toBe(id);
  });

  test("undoing a delete restores the card, its text and its links", async ({ page, account }) => {
    void account;
    const { board, a, edge } = await twoLinkedCards(page);
    await board.node(a.id).hover();
    await board.deleteButton(a.id).click();
    await expect(board.node(a.id)).toHaveCount(0);
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);

    await undo(page).click();
    await expect(board.node(a.id)).toBeVisible();
    await expect(board.title(a.id)).toHaveValue("Alpha");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(page.locator(".edge-label")).toHaveText("blocks");

    // and on the server, under the same ids
    await expect.poll(async () => (await board.saved()).edges.map((e) => e.id)).toEqual([edge.id]);
    await page.reload();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  });

  // BUG: undoing the delete of a card re-creates its links without their labels.
  // Board.removeNode's undo calls api.createEdge with id/source/target/handles
  // only (removeEdge's undo does pass `label`). The restored link shows its
  // label until the page is reloaded, then the server's copy has none.
  // Observed: link "blocks" between two cards, delete card, Undo, reload ->
  // the link is there but its label is empty (edge-label text "+").
  test.fixme("undoing a card delete keeps the labels of its links after a reload", async ({ page, account }) => {
    void account;
    const { board, a, edge } = await twoLinkedCards(page);
    await board.node(a.id).hover();
    await board.deleteButton(a.id).click();
    await expect(board.node(a.id)).toHaveCount(0);
    await undo(page).click();
    await expect(board.node(a.id)).toBeVisible();
    await expect.poll(async () => (await board.saved()).edges.map((e) => e.id)).toEqual([edge.id]);

    await page.reload();
    await expect(page.locator(".edge-label")).toHaveText("blocks");
    expect((await board.saved()).edges[0].label).toBe("blocks");
  });

  test("undoing a move puts the card back; redo moves it again", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page);
    const card = await createNode(page.request, record.id, { title: "Mover", x: 100, y: 100 });
    await board.open();

    const { before, after } = await board.drag(card.id, 160, 90);
    expect(after.x).not.toBe(before.x);

    await undo(page).click();
    await expect.poll(async () => (await board.savedNode(card.id)).x).toBe(before.x);
    expect((await board.savedNode(card.id)).y).toBe(before.y);

    await redo(page).click();
    await expect.poll(async () => (await board.savedNode(card.id)).x).toBe(after.x);
    expect((await board.savedNode(card.id)).y).toBe(after.y);
  });

  test("a new action after an undo discards the redo branch", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await board.addCard();
    await undo(page).click();
    await expect(redo(page)).toBeEnabled();
    await board.addNote();
    await expect(redo(page)).toBeDisabled();
  });

  test("Ctrl+Z inside a title field is the field's own undo, not the board's", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    const id = await board.addCard();
    await board.title(id).click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+z");
    // the board still has its card: the add was not undone
    await expect(board.node(id)).toBeVisible();
    await expect(board.nodes()).toHaveCount(1);
  });

  test("undo does not cross mindmaps: a different board starts with an empty history", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page, "First");
    await board.addCard();
    await expect(undo(page)).toBeEnabled();

    const other = await createBoard(page.request, "Second");
    await page.goto(`/app/${other.id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Second" })).toBeVisible();
    await expect(undo(page)).toBeDisabled();
  });

  test("the history is dropped on reload (it lives in the page)", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page);
    await board.addCard();
    await page.reload();
    await board.ready();
    await expect(undo(page)).toBeDisabled();
  });
});
