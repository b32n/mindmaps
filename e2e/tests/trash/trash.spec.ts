import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import { TrashDialog } from "../../support/trash";
import { Rail } from "../../support/rail";
import {
  contents, createBoard, createEdge, createNode, deleteBoard, deleteNode, listBoards, shareBoard, trash,
} from "../../support/api";

test.describe("an empty trash", () => {
  test("says nothing was deleted recently, and offers no Empty button", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    const dialog = await new TrashDialog(page).open();
    await expect(dialog.root.getByText("Nothing deleted recently. Anything you remove shows up here for 7 days.")).toBeVisible();
    await expect(dialog.root.getByRole("button", { name: "Empty trash" })).toHaveCount(0);
    await expect(dialog.root.getByText("Deleted in the last 7 days.")).toBeVisible();
  });

  test("closes with Escape and with ×", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    const dialog = await new TrashDialog(page).open();
    await page.keyboard.press("Escape");
    await expect(dialog.root).toHaveCount(0);
    await dialog.open();
    await dialog.root.getByRole("button", { name: "Close" }).click();
    await expect(dialog.root).toHaveCount(0);
  });
});

test.describe("a deleted card", () => {
  async function deletedCard(page: import("@playwright/test").Page) {
    const { board, record } = await Board.create(page, "Source board");
    const keep = await createNode(page.request, record.id, { title: "Neighbour", x: 500, y: 0 });
    const card = await createNode(page.request, record.id, { title: "Findings", body: "# Findings\n\nThe cache is stale.", x: 0, y: 0 });
    const edge = await createEdge(page.request, {
      source_id: card.id, target_id: keep.id, label: "explains", source_handle: "right", target_handle: "left",
    });
    await board.open();
    await board.node(card.id).hover();
    await board.deleteButton(card.id).click();
    await expect(board.node(card.id)).toHaveCount(0);
    return { board, record, card, keep, edge };
  }

  test("appears in the trash with its title, type, source mindmap and time left", async ({ page, account }) => {
    void account;
    await deletedCard(page);
    const dialog = await new TrashDialog(page).open();

    const row = dialog.row("Findings");
    await expect(row).toHaveCount(1);
    await expect(row.locator(".trash-kind")).toHaveText("card");
    await expect(row.locator(".trash-meta")).toContainText("Source board");
    await expect(row.locator(".trash-meta")).toContainText("just now");
    await expect(row.locator(".trash-meta")).toContainText("7 days left");
    await expect(dialog.root.getByRole("button", { name: "Empty trash" })).toBeVisible();
  });

  test("Restore puts it back on its mindmap with its text, position and link", async ({ page, account }) => {
    void account;
    const { board, card, keep, edge } = await deletedCard(page);
    const dialog = await new TrashDialog(page).open();
    await dialog.row("Findings").getByRole("button", { name: "Restore" }).click();

    await expect(dialog.row("Findings")).toHaveCount(0);
    await expect(dialog.root.getByText("Nothing deleted recently.")).toBeVisible();
    await dialog.root.getByRole("button", { name: "Close" }).click();

    await expect(board.node(card.id)).toBeVisible();
    await expect(board.title(card.id)).toHaveValue("Findings");
    await expect(board.node(card.id).locator(".card-preview")).toHaveText("Findings The cache is stale.");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(board.edgeLabels()).toHaveText("explains");

    const saved = await board.saved();
    expect(saved.nodes.map((n) => n.id).sort()).toEqual([card.id, keep.id].sort());
    expect(saved.edges.map((e) => [e.id, e.label])).toEqual([[edge.id, "explains"]]);
    expect(await trash(page.request)).toEqual([]);
  });

  test("a restored card is searchable again", async ({ page, account }) => {
    void account;
    await deletedCard(page);
    const dialog = await new TrashDialog(page).open();
    await dialog.row("Findings").getByRole("button", { name: "Restore" }).click();
    await expect(dialog.rows()).toHaveCount(0);
    await dialog.root.getByRole("button", { name: "Close" }).click();

    await page.keyboard.press("Control+k");
    await page.getByPlaceholder("What do you already know about…").fill("stale");
    await expect(page.getByRole("dialog", { name: "Recall" }).locator(".rc-hit-title")).toHaveText(["Findings"]);
  });

  test("restoring from another mindmap takes you to the card's own mindmap", async ({ page, account }) => {
    void account;
    const { record } = await deletedCard(page);
    const elsewhere = await createBoard(page.request, "Somewhere else");
    await page.goto(`/app/${elsewhere.id}`);
    const dialog = await new TrashDialog(page).open();
    await dialog.row("Findings").getByRole("button", { name: "Restore" }).click();
    await expect(page).toHaveURL(new RegExp(`/app/${record.id}$`));
  });

  test("cannot be restored while its mindmap is itself in the trash", async ({ page, account }) => {
    void account;
    const { record } = await deletedCard(page);
    await deleteBoard(page.request, record.id);
    await page.goto("/app");
    const dialog = await new TrashDialog(page).open();
    await dialog.row("Findings").getByRole("button", { name: "Restore" }).click();
    await expect(dialog.root.locator(".trash-error")).toHaveText("The mindmap this came from was deleted too. Restore that first.");
    await expect(dialog.row("Findings")).toHaveCount(1);
  });

  test("shows the newest deletion first", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page, "Order");
    const first = await createNode(page.request, record.id, { title: "Deleted first", x: 0, y: 0 });
    const second = await createNode(page.request, record.id, { title: "Deleted second", x: 400, y: 0 });
    await deleteNode(page.request, first.id);
    await expect.poll(async () => (await trash(page.request)).length).toBe(1);
    await deleteNode(page.request, second.id);
    await board.open();
    const dialog = await new TrashDialog(page).open();
    await expect(dialog.root.locator(".trash-label")).toHaveText(["Deleted second", "Deleted first"]);
  });

  test("an untitled card is listed as “Untitled”", async ({ page, account }) => {
    void account;
    const { record } = await Board.create(page, "Blank");
    const card = await createNode(page.request, record.id, { title: "", x: 0, y: 0 });
    await deleteNode(page.request, card.id);
    const dialog = await new TrashDialog(page).open();
    await expect(dialog.root.locator(".trash-label")).toHaveText(["Untitled"]);
  });
});

test.describe("a deleted mindmap", () => {
  async function deletedMap(page: import("@playwright/test").Page) {
    const record = await createBoard(page.request, "Retired plan", { description: "old" });
    const a = await createNode(page.request, record.id, { title: "Step one", body: "first", x: 0, y: 0 });
    const b = await createNode(page.request, record.id, { title: "Step two", x: 450, y: 0 });
    await createNode(page.request, record.id, { type: "note", title: "remember", x: 0, y: 300 });
    await createEdge(page.request, { source_id: a.id, target_id: b.id, label: "then", source_handle: "right", target_handle: "left" });
    await page.goto(`/app/${record.id}`);
    const rail = new Rail(page);
    const dialog = await rail.openSettings("Retired plan");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.getByRole("button", { name: "Really delete" }).click();
    await expect(rail.row("Retired plan")).toHaveCount(0);
    return { record, a, b };
  }

  test("is listed as a Mindmap with a summary of what it held", async ({ page, account }) => {
    void account;
    await deletedMap(page);
    const dialog = await new TrashDialog(page).open();
    const row = dialog.row("Retired plan");
    await expect(row.locator(".trash-kind")).toHaveText("Mindmap");
    await expect(row.locator(".trash-meta")).toContainText("2 cards, 1 note");
  });

  test("Restore brings back the mindmap with all its cards and links, and opens it", async ({ page, account }) => {
    void account;
    const { record, a, b } = await deletedMap(page);
    const dialog = await new TrashDialog(page).open();
    await dialog.row("Retired plan").getByRole("button", { name: "Restore" }).click();

    await expect(page).toHaveURL(new RegExp(`/app/${record.id}$`));
    await dialog.root.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Retired plan" })).toBeVisible();
    await expect(new Rail(page).row("Retired plan")).toHaveCount(1);
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await expect(page.locator(".edge-label .edge-text")).toHaveText("then");

    const saved = await contents(page.request, record.id);
    expect(saved.nodes.map((n) => n.id).sort()).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(saved.board).toMatchObject({ name: "Retired plan", description: "old" });
    expect(await trash(page.request)).toEqual([]);
  });

  test("restoring a card that was deleted from it first, then the mindmap, is not required: each is its own entry", async ({ page, account }) => {
    void account;
    const record = await createBoard(page.request, "Two entries");
    const c = await createNode(page.request, record.id, { title: "Loose card", x: 0, y: 0 });
    await deleteNode(page.request, c.id);
    await createNode(page.request, record.id, { title: "Stays", x: 0, y: 0 });
    await deleteBoard(page.request, record.id);
    await page.goto("/app");
    const dialog = await new TrashDialog(page).open();
    await expect(dialog.rows()).toHaveCount(2);
  });
});

test.describe("deleting for good", () => {
  test("the × on a row removes that entry only, and it can no longer be restored", async ({ page, account }) => {
    void account;
    const { record } = await Board.create(page, "Purge");
    const a = await createNode(page.request, record.id, { title: "Purge me", x: 0, y: 0 });
    const b = await createNode(page.request, record.id, { title: "Keep me", x: 300, y: 0 });
    await deleteNode(page.request, a.id);
    await deleteNode(page.request, b.id);
    const dialog = await new TrashDialog(page).open();
    await expect(dialog.rows()).toHaveCount(2);

    await dialog.row("Purge me").getByTitle("Delete for good").click();
    await expect(dialog.rows()).toHaveCount(1);
    await expect(dialog.row("Keep me")).toHaveCount(1);
    expect((await trash(page.request)).map((t) => t.label)).toEqual(["Keep me"]);
    expect((await page.request.post(`/api/trash/${a.id}/restore`)).status()).toBe(404);
  });

  test("Empty trash asks first; Cancel keeps everything", async ({ page, account }) => {
    void account;
    const { record } = await Board.create(page, "Bin");
    for (const t of ["One", "Two", "Three"]) await deleteNode(page.request, (await createNode(page.request, record.id, { title: t, x: 0, y: 0 })).id);
    const dialog = await new TrashDialog(page).open();
    await expect(dialog.rows()).toHaveCount(3);

    await dialog.root.getByRole("button", { name: "Empty trash" }).click();
    await expect(dialog.root.getByText("Delete all 3 for good? This cannot be undone.")).toBeVisible();
    await dialog.root.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog.root.getByRole("button", { name: "Empty trash" })).toBeVisible();
    await expect(dialog.rows()).toHaveCount(3);
  });

  test("confirming Empty trash clears it for good", async ({ page, account }) => {
    void account;
    const { record } = await Board.create(page, "Bin");
    for (const t of ["One", "Two"]) await deleteNode(page.request, (await createNode(page.request, record.id, { title: t, x: 0, y: 0 })).id);
    const dialog = await new TrashDialog(page).open();
    await dialog.root.getByRole("button", { name: "Empty trash" }).click();
    await dialog.root.getByRole("button", { name: "Delete all" }).click();

    await expect(dialog.rows()).toHaveCount(0);
    await expect(dialog.root.getByText("Nothing deleted recently.")).toBeVisible();
    expect(await trash(page.request)).toEqual([]);
  });

  test("reopening the dialog shows the current state, not a stale list", async ({ page, account }) => {
    void account;
    const { record } = await Board.create(page, "Fresh");
    const dialog = await new TrashDialog(page).open();
    await expect(dialog.rows()).toHaveCount(0);
    await page.keyboard.press("Escape");
    await deleteNode(page.request, (await createNode(page.request, record.id, { title: "Late", x: 0, y: 0 })).id);
    await dialog.open();
    await expect(dialog.row("Late")).toHaveCount(1);
  });
});

test.describe("whose trash it is", () => {
  test("is private to the account that deleted", async ({ page, account, existing }) => {
    void account;
    const { record } = await Board.create(page, "Mine");
    await deleteNode(page.request, (await createNode(page.request, record.id, { title: "Mine alone", x: 0, y: 0 })).id);
    expect((await trash(existing.request)).map((t) => t.label)).not.toContain("Mine alone");
    expect((await existing.request.post(`/api/trash/${(await trash(page.request))[0].id}/restore`)).status()).toBe(404);
  });

  // BUG: items deleted from a SHARED mindmap are filed under whoever deleted
  // them, so the mindmap's owner can neither see nor restore a card a
  // collaborator removed from it.
  //
  // Why: archiveNode()/archiveBoard() (worker/src/trash.ts) write the trash row
  // with `user_id = <the deleter>`, and listTrash(), restoreTrash(), purgeTrash()
  // and emptyTrash() all filter on `user_id = <the caller>`. The owner's
  // GET /api/trash therefore never contains the entry (nor can POST
  // /api/trash/:id/restore find it: 404), while the card has left their
  // mindmap for good once the retention window passes.
  //
  // Expected: the owner of the mindmap (who can see and edit everything on it)
  // finds the collaborator's deletion in their Trash and can restore it.
  // Actual: the owner's Trash is empty; only the collaborator's is not.
  test.fixme("the owner of a shared mindmap can see and restore a card a collaborator deleted", async ({ page, account, existing }) => {
    void account;
    // The owner (the page's account) shares a mindmap with a collaborator, over the real API.
    const { board, record } = await Board.create(page, "Shared board");
    const card = await createNode(page.request, record.id, { title: "Collaborator will delete me", body: "important", x: 0, y: 0 });
    await shareBoard(page.request, record.id, existing.user.email, "editor");
    // The collaborator can really edit it: they delete the card.
    expect((await listBoards(existing.request)).map((b) => b.id)).toContain(record.id);
    const del = await existing.request.delete(`/api/nodes/${card.id}`);
    expect(del.ok()).toBe(true);

    // The owner opens their Trash...
    await board.open();
    await expect(board.node(card.id)).toHaveCount(0);
    const dialog = await new TrashDialog(page).open();

    // ...and finds it there, and can put it back.
    await expect(dialog.row("Collaborator will delete me")).toHaveCount(1);
    await dialog.row("Collaborator will delete me").getByRole("button", { name: "Restore" }).click();
    await dialog.root.getByRole("button", { name: "Close" }).click();
    await expect(board.node(card.id)).toBeVisible();
    expect((await board.saved()).nodes.map((n) => n.id)).toEqual([card.id]);
  });

  // Same defect, per-mindmap view: the API the owner calls.
  test.fixme("the owner's GET /api/trash lists items collaborators deleted from the owner's mindmap", async ({ page, account, existing }) => {
    void account;
    const { record } = await Board.create(page, "Shared board 2");
    const card = await createNode(page.request, record.id, { title: "Gone by collaborator", x: 0, y: 0 });
    await shareBoard(page.request, record.id, existing.user.email, "editor");
    expect((await existing.request.delete(`/api/nodes/${card.id}`)).ok()).toBe(true);

    expect((await trash(page.request)).map((t) => t.id)).toContain(card.id);
    expect((await page.request.post(`/api/trash/${card.id}/restore`)).status()).toBe(200);
  });
});
