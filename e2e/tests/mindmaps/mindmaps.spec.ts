import { test, expect } from "../../fixtures";
import { createBoard, createNode, listBoards, deleteBoard } from "../../support/api";
import { Rail } from "../../support/rail";

test.describe("the starter mindmap", () => {
  test("every new account gets exactly one, with the tutorial cards and two labelled links", async ({ page, account, request }) => {
    void account;
    const boards = await listBoards(request);
    expect(boards.map((b) => b.name)).toEqual(["Start here"]);

    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1, name: "Start here" })).toBeVisible();
    await expect(page.locator(".topbar-meta")).toHaveText("3 cards"); // the note is not counted
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    for (const title of [
      "Connect your agent harness",
      "A card is a line of text until you open it",
      "Links carry a verb",
    ]) {
      await expect(page.locator(`input.card-title[value="${title}"]`)).toBeVisible();
    }
    await expect(page.locator(".react-flow__node-note textarea")).toHaveValue(/Delete this mindmap once you're set up/);
    await expect(page.locator(".edge-label")).toHaveText(["then", "explains"]);
    await expect(page.locator(".chip.kids")).toHaveText("0/3 done");
  });

  test("it is personal: two accounts do not share one", async ({ account, request, existing }) => {
    void account;
    const mine = (await listBoards(request))[0];
    const theirs = (await listBoards(existing.request))[0];
    expect(mine.id).not.toBe(theirs.id);
    expect((await existing.request.get(`/api/boards/${mine.id}/contents`)).status()).toBe(404);
  });

  test("it can be deleted, and deleting it is not undone by signing in again", async ({ page, account, request }) => {
    void account;
    const [start] = await listBoards(request);
    await page.goto("/app");
    const rail = new Rail(page);
    const dialog = await rail.openSettings("Start here");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.getByRole("button", { name: "Really delete" }).click();

    await expect(page.getByRole("heading", { name: "No mindmaps yet" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "No mindmaps yet" })).toBeVisible();
    expect(await listBoards(request)).toEqual([]);
    expect((await request.get(`/api/boards/${start.id}/contents`)).status()).toBe(404);
  });
});

test.describe("creating a mindmap", () => {
  test("from the + button: name and description, opens it, appears first in the rail", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    const rail = new Rail(page);

    await rail.create("Quarterly planning", "OKRs and the roadmap");

    await expect(page).toHaveURL(/\/app\/[0-9a-f-]{36}$/);
    await expect(rail.names()).toHaveText(["Quarterly planning", "Start here"]);
    await expect(page.locator(".topbar-meta")).toHaveText("0 cards");
    // the description is what a hover on the rail row shows
    await expect(rail.row("Quarterly planning").locator(".rail-open")).toHaveAttribute("title", "OKRs and the roadmap");
  });

  test("the name is required: Create is disabled until there is one", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    const rail = new Rail(page);
    await rail.openNewDialog();
    const dialog = page.getByRole("dialog", { name: "New mindmap" });
    const create = dialog.getByRole("button", { name: "Create mindmap" });

    await expect(create).toBeDisabled();
    await dialog.getByLabel("Name").fill("   ");
    await expect(create).toBeDisabled();
    await dialog.getByLabel("Name").fill("Real name");
    await expect(create).toBeEnabled();
  });

  test("Enter in the name field submits", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    const rail = new Rail(page);
    await rail.openNewDialog();
    await page.getByLabel("Name").fill("By keyboard");
    await page.getByLabel("Name").press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "By keyboard" })).toBeVisible();
  });

  test("Cancel, Escape and the close button leave nothing behind", async ({ page, account, request }) => {
    void account;
    await page.goto("/app");
    const rail = new Rail(page);
    const dialog = page.getByRole("dialog", { name: "New mindmap" });

    await rail.openNewDialog();
    await dialog.getByLabel("Name").fill("Nope 1");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    await rail.openNewDialog();
    await dialog.getByLabel("Name").fill("Nope 2");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await rail.openNewDialog();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);

    // reopening starts blank
    await rail.openNewDialog();
    await expect(dialog.getByLabel("Name")).toHaveValue("");
    expect((await listBoards(request)).map((b) => b.name)).toEqual(["Start here"]);
  });

  test("a new mindmap is empty, has no links and shows the dock", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await new Rail(page).create("Blank");
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add card" })).toBeVisible();
  });

  test("lands first in the rail even though older ones exist, and survives a reload", async ({ page, account, request }) => {
    void account;
    await createBoard(request, "Older");
    await page.goto("/app");
    const rail = new Rail(page);
    await rail.create("Newest");
    await page.reload();
    await expect(rail.names()).toHaveText(["Newest", "Older", "Start here"]);
    await expect(page.getByRole("heading", { level: 1, name: "Newest" })).toBeVisible();
  });

  test("with every mindmap gone, the empty state offers to create one", async ({ page, account, request }) => {
    void account;
    for (const b of await listBoards(request)) await deleteBoard(request, b.id);
    await page.goto("/app");

    await expect(page.getByRole("heading", { name: "No mindmaps yet" })).toBeVisible();
    await expect(page.getByText("A mindmap is a canvas: cards that hold documents")).toBeVisible();
    await expect(page.locator(".rail-empty")).toHaveText("Nothing here yet.");

    await page.getByRole("button", { name: "New mindmap" }).last().click();
    const dialog = page.getByRole("dialog", { name: "New mindmap" });
    await dialog.getByLabel("Name").fill("First after nothing");
    await dialog.getByRole("button", { name: "Create mindmap" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "First after nothing" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No mindmaps yet" })).toHaveCount(0);
  });
});

test.describe("opening and switching", () => {
  test("clicking a row opens that mindmap, puts its id in the URL and marks the row active", async ({ page, account, request }) => {
    void account;
    const a = await createBoard(request, "Alpha");
    const b = await createBoard(request, "Beta");
    await page.goto("/app");
    const rail = new Rail(page);

    await rail.open("Alpha");
    await expect(page).toHaveURL(new RegExp(`/app/${a.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Alpha" })).toBeVisible();
    await expect(rail.row("Alpha")).toHaveClass(/active/);

    await rail.open("Beta");
    await expect(page).toHaveURL(new RegExp(`/app/${b.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Beta" })).toBeVisible();
    await expect(rail.row("Beta")).toHaveClass(/active/);
    await expect(rail.row("Alpha")).not.toHaveClass(/active/);
  });

  test("each mindmap shows its own cards", async ({ page, account, request }) => {
    void account;
    const a = await createBoard(request, "Has cards");
    const b = await createBoard(request, "Has none");
    await createNode(request, a.id, { title: "Only on Has cards", x: 50, y: 50 });
    await page.goto(`/app/${a.id}`);
    await expect(page.locator('input.card-title[value="Only on Has cards"]')).toBeVisible();

    await new Rail(page).open("Has none");
    await expect(page).toHaveURL(new RegExp(b.id));
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expect(page.locator('input.card-title[value="Only on Has cards"]')).toHaveCount(0);
  });

  test("Back and Forward retrace the mindmaps you visited", async ({ page, account, request }) => {
    void account;
    const a = await createBoard(request, "First stop");
    const b = await createBoard(request, "Second stop");
    await page.goto(`/app/${a.id}`);
    const rail = new Rail(page);
    await rail.open("Second stop");
    await expect(page).toHaveURL(new RegExp(b.id));

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(a.id));
    await expect(page.getByRole("heading", { level: 1, name: "First stop" })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("heading", { level: 1, name: "Second stop" })).toBeVisible();
  });

  test("a reload stays on the same mindmap", async ({ page, account, request }) => {
    void account;
    await createBoard(request, "Top");
    const second = await createBoard(request, "Pick me");
    void second;
    await page.goto("/app");
    const rail = new Rail(page);
    await rail.open("Start here");
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole("heading", { level: 1, name: "Start here" })).toBeVisible();
  });

  test("/app with no id opens the first mindmap in the rail", async ({ page, account, request }) => {
    void account;
    const newest = await createBoard(request, "Newest on top");
    await page.goto("/app");
    await expect(page).toHaveURL(new RegExp(newest.id));
  });
});

test.describe("renaming and editing", () => {
  test("rename updates the rail and the heading, and persists", async ({ page, account, request }) => {
    void account;
    const board = await createBoard(request, "Old name");
    await page.goto(`/app/${board.id}`);
    const rail = new Rail(page);

    const dialog = await rail.openSettings("Old name");
    await expect(dialog.getByLabel("Name")).toHaveValue("Old name");
    await dialog.getByLabel("Name").fill("New name");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);

    await expect(page.getByRole("heading", { level: 1, name: "New name" })).toBeVisible();
    await expect(rail.names()).toContainText(["New name"]);
    await expect(rail.row("Old name")).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "New name" })).toBeVisible();
    expect((await listBoards(request)).map((b) => b.name)).toContain("New name");
  });

  test("an empty name cannot be saved", async ({ page, account, request }) => {
    void account;
    const board = await createBoard(request, "Keep me");
    await page.goto(`/app/${board.id}`);
    const dialog = await new Rail(page).openSettings("Keep me");
    await dialog.getByLabel("Name").fill("");
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  test("description is saved and shown as the row's hover text", async ({ page, account, request }) => {
    void account;
    const board = await createBoard(request, "Described");
    await page.goto(`/app/${board.id}`);
    const rail = new Rail(page);
    const dialog = await rail.openSettings("Described");
    await dialog.getByLabel("What belongs here").fill("Everything about auth");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);

    await expect(rail.row("Described").locator(".rail-open")).toHaveAttribute("title", "Everything about auth");
    expect((await listBoards(request)).find((b) => b.id === board.id)?.description).toBe("Everything about auth");
  });

  test("labels: add with Enter and comma, de-duplicate ignoring case, remove, persist", async ({ page, account, request }) => {
    void account;
    const board = await createBoard(request, "Labelled");
    await page.goto(`/app/${board.id}`);
    const rail = new Rail(page);
    let dialog = await rail.openSettings("Labelled");

    const input = dialog.locator("#mm-label");
    await input.fill("auth");
    await input.press("Enter");
    await input.fill("pci");
    await input.press(",");
    await input.fill("AUTH");
    await input.press("Enter"); // same label, different case
    await expect(dialog.locator(".mm-label")).toHaveText(["auth×", "pci×"]);

    await dialog.getByRole("button", { name: "Remove pci" }).click();
    await expect(dialog.locator(".mm-label")).toHaveText(["auth×"]);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);

    expect((await listBoards(request)).find((b) => b.id === board.id)?.labels).toEqual(["auth"]);
    dialog = await rail.openSettings("Labelled");
    await expect(dialog.locator(".mm-label")).toHaveText(["auth×"]);
  });

  test("Backspace in the empty label box removes the last label", async ({ page, account, request }) => {
    void account;
    const board = await createBoard(request, "Chips", { labels: ["one", "two"] });
    await page.goto(`/app/${board.id}`);
    const dialog = await new Rail(page).openSettings("Chips");
    await expect(dialog.locator(".mm-label")).toHaveText(["one×", "two×"]);
    await dialog.locator("#mm-label").press("Backspace");
    await expect(dialog.locator(".mm-label")).toHaveText(["one×"]);
  });

  test("Cancel discards edits", async ({ page, account, request }) => {
    void account;
    const board = await createBoard(request, "Unchanged");
    await page.goto(`/app/${board.id}`);
    const rail = new Rail(page);
    const dialog = await rail.openSettings("Unchanged");
    await dialog.getByLabel("Name").fill("Changed?");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(rail.row("Unchanged")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Unchanged" })).toBeVisible();
  });
});

test.describe("pinning and ordering", () => {
  test("pinning moves a mindmap to the top, marks it, and persists", async ({ page, account, request }) => {
    void account;
    const old = await createBoard(request, "Pin me");
    await createBoard(request, "Newer 1");
    await createBoard(request, "Newer 2");
    await page.goto("/app");
    const rail = new Rail(page);
    await expect(rail.names()).toHaveText(["Newer 2", "Newer 1", "Pin me", "Start here"]);

    const pin = rail.row("Pin me").getByRole("button", { name: "Pin to top" });
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await pin.click();

    await expect(rail.names()).toHaveText(["Pin me", "Newer 2", "Newer 1", "Start here"]);
    await expect(rail.row("Pin me").getByRole("button", { name: "Unpin" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await listBoards(request)).find((b) => b.id === old.id)?.pinned).toBe(true);

    await page.reload();
    await expect(rail.names()).toHaveText(["Pin me", "Newer 2", "Newer 1", "Start here"]);
  });

  test("unpinning puts it back in its manual place", async ({ page, account, request }) => {
    void account;
    await createBoard(request, "Plain");
    await createBoard(request, "Was pinned", { pinned: true });
    await page.goto("/app");
    const rail = new Rail(page);
    await expect(rail.names().first()).toHaveText("Was pinned");

    await rail.row("Was pinned").getByRole("button", { name: "Unpin" }).click();
    await expect(rail.row("Was pinned").getByRole("button", { name: "Pin to top" })).toBeVisible();
    await expect.poll(async () => (await listBoards(request)).find((b) => b.name === "Was pinned")?.pinned).toBe(false);
  });

  test("dragging a row reorders the rail and the order persists", async ({ page, account, request }) => {
    void account;
    await createBoard(request, "C");
    await createBoard(request, "B");
    await createBoard(request, "A");
    await page.goto("/app");
    const rail = new Rail(page);
    await expect(rail.names()).toHaveText(["A", "B", "C", "Start here"]);

    const reordered = page.waitForResponse((r) => r.url().endsWith("/api/boards/reorder") && r.ok());
    await rail.row("C").dragTo(rail.row("A"));
    await reordered;

    await expect(rail.names()).toHaveText(["C", "A", "B", "Start here"]);
    await page.reload();
    await expect(rail.names()).toHaveText(["C", "A", "B", "Start here"]);
    expect((await listBoards(request)).map((b) => b.name)).toEqual(["C", "A", "B", "Start here"]);
  });
});

test.describe("deleting a mindmap", () => {
  test("asks twice, removes it from the rail and moves to another one", async ({ page, account, request }) => {
    void account;
    const doomed = await createBoard(request, "Doomed");
    await page.goto(`/app/${doomed.id}`);
    const rail = new Rail(page);
    const dialog = await rail.openSettings("Doomed");

    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(dialog.getByText("This removes the mindmap and everything on it")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Really delete" })).toBeVisible();
    await dialog.getByRole("button", { name: "Really delete" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(rail.row("Doomed")).toHaveCount(0);
    await expect(page).not.toHaveURL(new RegExp(doomed.id));
    await expect(page.getByRole("heading", { level: 1, name: "Start here" })).toBeVisible();
    expect((await listBoards(request)).map((b) => b.name)).toEqual(["Start here"]);
  });

  test("the first click alone does not delete anything", async ({ page, account, request }) => {
    void account;
    const keep = await createBoard(request, "Survivor");
    await page.goto(`/app/${keep.id}`);
    const dialog = await new Rail(page).openSettings("Survivor");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect((await listBoards(request)).map((b) => b.name)).toContain("Survivor");
  });

  test("its URL no longer resolves after deletion", async ({ page, account, request }) => {
    void account;
    const gone = await createBoard(request, "Gone");
    await deleteBoard(request, gone.id);
    await page.goto(`/app/${gone.id}`);
    await expect(page).not.toHaveURL(new RegExp(gone.id));
    expect((await request.get(`/api/boards/${gone.id}/contents`)).status()).toBe(404);
  });
});
