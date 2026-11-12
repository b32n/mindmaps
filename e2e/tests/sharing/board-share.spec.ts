import { test, expect } from "../../fixtures";
import { addMember, contents, createBoard, createNode, listBoards, membersOf, nodeById } from "../../support/api";
import { Board } from "../../support/board";
import { openBoardShare } from "../../support/members";
import { Rail } from "../../support/rail";
import { expectSignedInShell, signUpViaForm } from "../../support/auth";
import { newUser } from "../../support/users";

// Sharing one mindmap with one person (Share button in the mindmap's topbar).
// The sharer is the signed-in `account`; the other person has their own
// browser context via `openAs`.

test.describe("the Share dialog on a mindmap", () => {
  test("inviting an existing account adds them, and the mindmap says who it is shared with", async ({
    page,
    account,
    existing,
    openAs,
  }) => {
    void account;
    const { board, record } = await Board.create(page, "Quarterly plan");
    await expect(page.getByTitle("Share this mindmap")).toHaveText("Share");
    const { dialog, panel } = await openBoardShare(page, "Quarterly plan");

    const { status, body } = await panel.invite(existing.user.email, "Can view");
    expect(status).toBe(201);
    expect(body.added).toMatchObject({ email: existing.user.email, role: "viewer" });
    await expect(panel.note()).toHaveText(`${existing.user.email} now has access.`);
    await expect(panel.row(existing.user.email)).toContainText("Can view");
    expect((await membersOf(page.request, "boards", record.id)).members.map((m) => m.email)).toEqual([existing.user.email]);

    // closing the dialog re-reads the board, so the topbar shows the count at once;
    // the rail's badge comes with the mindmap list, so it shows after a reload
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTitle("Share this mindmap")).toHaveText("Shared with 1");
    await page.reload();
    await board.ready();
    await expect(new Rail(page).row("Quarterly plan").locator(".rail-shared")).toHaveAttribute("title", "Shared with 1 person");

    // the invitee finds it in their own rail, opens it, and it carries the same name
    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await expect(new Rail(theirs).names()).toContainText(["Quarterly plan"]);
    await new Rail(theirs).open("Quarterly plan");
    await expect(theirs.getByRole("heading", { level: 1, name: "Quarterly plan" })).toBeVisible();
  });

  test("an address with no account waits as a pending invite until that person signs up", async ({
    page,
    account,
    browser,
  }) => {
    void account;
    const { record } = await Board.create(page, "For a newcomer");
    const who = newUser("fresh");
    const { panel } = await openBoardShare(page, "For a newcomer");
    const { body } = await panel.invite(who.email);
    expect(body.invited).toMatchObject({ email: who.email, role: "editor" });
    await expect(panel.row(who.email)).toContainText("waiting for them to sign up");

    const context = await browser.newContext();
    const theirs = await context.newPage();
    await signUpViaForm(theirs, who);
    await expectSignedInShell(theirs, who.name);
    await expect(new Rail(theirs).names()).toContainText(["For a newcomer"]);
    expect((await membersOf(page.request, "boards", record.id)).pending).toEqual([]);
    await context.close();
  });

  test("Remove ends their access: the mindmap leaves their rail and the API answers 404", async ({
    page,
    account,
    existing,
    openAs,
  }) => {
    void account;
    const { record } = await Board.create(page, "Briefly shared");
    await addMember(page.request, "boards", record.id, existing.user.email);
    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await expect(new Rail(theirs).names()).toContainText(["Briefly shared"]);

    const { panel } = await openBoardShare(page, "Briefly shared");
    const removed = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/members/"));
    await panel.row(existing.user.email).getByRole("button", { name: "Remove" }).click();
    expect((await removed).ok()).toBe(true);
    await expect(panel.row(existing.user.email)).toHaveCount(0);

    expect((await existing.request.get(`/api/boards/${record.id}/contents`)).status()).toBe(404);
    expect((await listBoards(existing.request)).map((b) => b.name)).not.toContain("Briefly shared");
    await theirs.reload();
    await expect(new Rail(theirs).names()).not.toContainText(["Briefly shared"]);
  });

  test("Cancel on a pending invite stops it working at sign-up", async ({ page, account }) => {
    void account;
    const { record } = await Board.create(page, "Withdrawn");
    const who = newUser("withdrawn");
    const { panel } = await openBoardShare(page, "Withdrawn");
    await panel.invite(who.email);
    await panel.row(who.email).getByRole("button", { name: "Cancel" }).click();
    await expect(panel.row(who.email)).toHaveCount(0);
    expect((await membersOf(page.request, "boards", record.id)).pending).toEqual([]);
  });

  test("a person can leave a mindmap shared with them (API); the owner keeps it", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Leave me");
    await addMember(request, "boards", board.id, existing.user.email);
    const me = ((await (await existing.request.get("/api/auth/me")).json()) as { user: { id: string } }).user.id;
    expect((await existing.request.delete(`/api/boards/${board.id}/members/${me}`)).ok()).toBe(true);
    expect((await existing.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
    expect((await request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
  });

  test("sharing again with another role replaces the first", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Re-share");
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    await addMember(request, "boards", board.id, existing.user.email, "editor");
    const { members } = await membersOf(request, "boards", board.id);
    expect(members.map((m) => m.role)).toEqual(["editor"]);
    expect((await existing.request.post("/api/nodes", { data: { board_id: board.id, title: "now allowed" } })).status()).toBe(201);
  });
});

test.describe("two people on one mindmap", () => {
  test("each adds a card in their own browser; after a reload both see both", async ({ page, account, existing, openAs }) => {
    void account;
    const { board, record } = await Board.create(page, "Together");
    await addMember(page.request, "boards", record.id, existing.user.email, "editor");
    const theirsPage = await openAs(existing);
    const theirs = new Board(theirsPage, theirsPage.request, record.id);
    await theirs.open();

    const mine = await board.addCard();
    const hers = await theirs.addCard();
    expect(new Set([mine, hers]).size).toBe(2);

    await page.reload();
    await theirsPage.reload();
    for (const [b, p] of [
      [board, page],
      [theirs, theirsPage],
    ] as const) {
      await b.ready();
      await expect(p.locator(".react-flow__node")).toHaveCount(2);
      await expect(b.node(mine)).toBeVisible();
      await expect(b.node(hers)).toBeVisible();
    }
    expect((await contents(page.request, record.id)).nodes).toHaveLength(2);
  });

  test("both edit titles of different cards and both edits persist for both", async ({ page, account, existing, openAs }) => {
    void account;
    const { board, record } = await Board.create(page, "Two editors");
    const a = await createNode(page.request, record.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(page.request, record.id, { title: "B", x: 400, y: 0 });
    await addMember(page.request, "boards", record.id, existing.user.email, "editor");
    const theirsPage = await openAs(existing);
    const theirs = new Board(theirsPage, theirsPage.request, record.id);
    await theirs.open();
    await board.open();

    const mineSaved = board.savedField(a.id, "title", "A by owner");
    await board.title(a.id).fill("A by owner");
    await mineSaved;
    const theirSaved = theirs.savedField(b.id, "title", "B by editor");
    await theirs.title(b.id).fill("B by editor");
    await theirSaved;

    expect((await nodeById(page.request, a.id)).title).toBe("A by owner");
    expect((await nodeById(existing.request, b.id)).title).toBe("B by editor");
    await page.reload();
    await theirsPage.reload();
    for (const [bd, p] of [
      [board, page],
      [theirs, theirsPage],
    ] as const) {
      await bd.ready();
      await expect(bd.title(a.id)).toHaveValue("A by owner", { timeout: 10_000 });
      await expect(bd.title(b.id)).toHaveValue("B by editor");
      void p;
    }
  });

  test("a card the editor deletes is gone for the owner too", async ({ page, account, existing, openAs }) => {
    void account;
    const { board, record } = await Board.create(page, "Shared deletes");
    const card = await createNode(page.request, record.id, { title: "Doomed", x: 0, y: 0 });
    await addMember(page.request, "boards", record.id, existing.user.email, "editor");
    const theirsPage = await openAs(existing);
    const theirs = new Board(theirsPage, theirsPage.request, record.id);
    await theirs.open();
    await theirs.node(card.id).hover();
    const gone = theirsPage.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/api/nodes/${card.id}`));
    await theirs.deleteButton(card.id).click();
    expect((await gone).ok()).toBe(true);

    await page.reload();
    await board.ready();
    await expect(board.node(card.id)).toHaveCount(0);
    expect((await contents(page.request, record.id)).nodes).toEqual([]);
  });
});

test.describe("roles on a mindmap shared on its own", () => {
  test("a viewer reads everything and can change nothing; the owner's data is untouched", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "View only");
    const card = await createNode(request, board.id, { title: "Original", x: 0, y: 0 });
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const v = existing.request;

    expect((await v.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    expect((await v.post("/api/nodes", { data: { board_id: board.id, title: "x" } })).status()).toBe(403);
    expect((await v.patch(`/api/nodes/${card.id}`, { data: { title: "x" } })).status()).toBe(403);
    expect((await v.delete(`/api/nodes/${card.id}`)).status()).toBe(403);
    expect((await v.patch(`/api/boards/${board.id}`, { data: { name: "x" } })).status()).toBe(403);
    expect((await v.delete(`/api/boards/${board.id}`)).status()).toBe(403);
    expect((await v.post(`/api/boards/${board.id}/members`, { data: { email: "x@example.test" } })).status()).toBe(403);
    expect((await nodeById(request, card.id)).title).toBe("Original");
  });

  test("an editor changes cards but cannot rename, delete or share the mindmap", async ({ account, request, existing, makePerson }) => {
    void account;
    const board = await createBoard(request, "Edit only");
    const card = await createNode(request, board.id, { title: "Original", x: 0, y: 0 });
    await addMember(request, "boards", board.id, existing.user.email, "editor");
    const third = await makePerson("third");
    const e = existing.request;

    expect((await e.patch(`/api/nodes/${card.id}`, { data: { title: "Edited" } })).ok()).toBe(true);
    expect((await e.post("/api/nodes", { data: { board_id: board.id, title: "Added" } })).status()).toBe(201);
    expect((await e.delete(`/api/nodes/${card.id}`)).ok()).toBe(true);
    expect((await e.patch(`/api/boards/${board.id}`, { data: { name: "x" } })).status()).toBe(403);
    expect((await e.patch(`/api/boards/${board.id}`, { data: { pinned: true } })).status()).toBe(403);
    expect((await e.delete(`/api/boards/${board.id}`)).status()).toBe(403);
    expect((await e.post(`/api/boards/${board.id}/members`, { data: { email: third.user.email } })).status()).toBe(403);
    expect((await e.get(`/api/boards/${board.id}/members`)).status()).toBe(404);
    expect((await request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
  });

  test("a viewer's edit in the UI is not stored: after a reload the owner's text is back", async ({
    page,
    account,
    existing,
    openAs,
  }) => {
    void account;
    const { record } = await Board.create(page, "Viewer UI");
    const card = await createNode(page.request, record.id, { title: "Owner's words", x: 0, y: 0 });
    await addMember(page.request, "boards", record.id, existing.user.email, "viewer");
    const theirsPage = await openAs(existing);
    const theirs = new Board(theirsPage, theirsPage.request, record.id);
    await theirs.open();

    // The UI does not switch editing off for a viewer, so the save is attempted and refused.
    const refused = theirsPage.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/nodes/${card.id}`));
    await theirs.title(card.id).fill("Viewer's words");
    expect((await refused).status()).toBe(403);

    expect((await nodeById(page.request, card.id)).title).toBe("Owner's words");
    await theirsPage.reload();
    await theirs.ready();
    await expect(theirs.title(card.id)).toHaveValue("Owner's words");
  });
});

test.describe("known problems with sharing", () => {
  test.fixme("a viewer who opens the Share dialog is not shown as its Owner", async ({ page, account, existing, openAs }) => {
    // Expected: the dialog (or at least its people list) does not describe a
    // viewer as "You — Owner". Actual: MembersPanel is given `ownerId={board.id}`
    // unconditionally, so the "You / Owner" row is drawn for everyone, while the
    // member list itself fails with "not found" (GET .../members is 404 for a
    // non-owner). Seen by opening Share as a viewer.
    void account;
    const { record } = await Board.create(page, "Who is the owner");
    await addMember(page.request, "boards", record.id, existing.user.email, "viewer");
    const theirsPage = await openAs(existing);
    await new Board(theirsPage, theirsPage.request, record.id).open();
    const { panel } = await openBoardShare(theirsPage, "Who is the owner");
    await expect(panel.rows().filter({ hasText: "Owner" })).toHaveCount(0);
  });

  test.fixme("a viewer cannot reorder the owner's rail", async ({ account, request, existing }) => {
    // Expected: POST /api/boards/reorder only moves mindmaps the caller can
    // write (the route's own comment says so). Actual: it filters with
    // BOARD_READABLE, so a viewer's call rewrites `position` on the owner's
    // mindmap. Observed by calling the route as a viewer and reading the
    // owner's board position before and after.
    void account;
    const board = await createBoard(request, "Not yours to move");
    const before = (await contents(request, board.id)).board.position;
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    await existing.request.post("/api/boards/reorder", { data: { ids: [board.id] } });
    expect((await contents(request, board.id)).board.position).toBe(before);
  });
});
