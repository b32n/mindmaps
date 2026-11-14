import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import {
  addMember, contents, createArtefact, createBoard, deleteNode, listFiles, nodeById, trash, uploadFile,
} from "../../support/api";

// A deleted artefact or file stays in the trash for seven days so undo works.
// Knowing its id must not be enough to bring it back somewhere else and read it:
// only whoever deleted it, or someone who can write to the mindmap it came from,
// may restore it. Anyone else is answered as if the id had never existed.

const SECRET = "the-secret-cell";

type Kind = "sheet" | "doc" | "deck" | "html";
const authored: Record<Kind, Record<string, unknown>> = {
  sheet: { sheets: [{ name: "Original", rows: [[SECRET, 1]] }] },
  doc: { blocks: [SECRET] },
  deck: { slides: [{ title: SECRET }] },
  html: { html: `<p>${SECRET}</p>` },
};

// What the web app's undo sends: the node it captured, a pointer and no payload.
const undoBody = (node: { id: string; type: string; title: string; data: unknown }, boardId: string) => ({
  id: node.id, board_id: boardId, type: node.type, title: node.title, data: node.data,
});

test.describe("restoring someone else's deleted artefact", () => {
  for (const kind of ["sheet", "doc", "deck", "html"] as const) {
    test(`a stranger cannot restore a deleted ${kind}: refused like a missing id, nothing copied`, async ({ account, request, existing }) => {
      void account;
      const board = await createBoard(request, "Owner's");
      const node = await createArtefact(request, board.id, kind, { title: "Gone", ...authored[kind] });
      await deleteNode(request, node.id);
      const mine = await createBoard(existing.request, "Theirs");

      const res = await existing.request.post("/api/nodes", { data: undoBody(node, mine.id) });
      const never = await existing.request.post("/api/nodes", {
        data: undoBody({ ...node, id: "00000000-0000-4000-8000-000000000000" }, mine.id),
      });
      expect(res.status()).toBe(never.status());
      expect(res.status()).toBe(410);
      expect(await res.json()).toEqual(await never.json());
      expect(await res.text()).not.toContain(SECRET);

      expect((await contents(existing.request, mine.id)).nodes).toEqual([]);
      expect((await existing.request.get(`/api/nodes/${node.id}`)).status()).toBe(404);
      expect((await existing.request.get(`/api/artefacts/${node.id}`)).ok()).toBe(false);

      // the owner's entry is untouched and their undo still works
      expect((await trash(request)).map((t) => t.id)).toContain(node.id);
      expect((await trash(existing.request)).map((t) => t.id)).not.toContain(node.id);
      const undo = await request.post("/api/nodes", { data: undoBody(node, board.id) });
      expect(undo.status()).toBe(201);
      expect(JSON.stringify(await (await request.get(`/api/artefacts/${node.id}`)).json())).toContain(SECRET);
    });
  }

  test("a viewer of the original mindmap cannot restore it onto their own", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "Gone", ...authored.sheet });
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const mine = await createBoard(existing.request, "Theirs");
    await deleteNode(request, sheet.id);

    const res = await existing.request.post("/api/nodes", { data: undoBody(sheet, mine.id) });
    expect(res.status()).toBe(410);
    expect(await res.text()).not.toContain(SECRET);
    expect((await contents(existing.request, mine.id)).nodes).toEqual([]);
    // and not back onto the map they can only read, which they cannot write to
    expect((await existing.request.post("/api/nodes", { data: undoBody(sheet, board.id) })).status()).toBe(403);
    expect((await contents(request, board.id)).nodes).toEqual([]);
  });

  test("a stranger cannot restore a deleted file: no rows, no bytes", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const file = await createArtefact(request, board.id, "file", { title: "Report" });
    expect((await uploadFile(request, file.id, { name: "r.txt", type: "text/plain", data: "owner bytes" })).ok()).toBe(true);
    const saved = await nodeById(request, file.id);
    await deleteNode(request, file.id);
    const mine = await createBoard(existing.request, "Theirs");

    // the stranger knows the id and nothing else, so sends no data of the owner's
    const res = await existing.request.post("/api/nodes", { data: { id: file.id, board_id: mine.id, type: "file", title: "x" } });
    // same as an id that was never used: an empty new card
    expect(res.status()).toBe(201);
    expect(await res.text()).not.toContain("r.txt");
    expect(await listFiles(existing.request, file.id)).toEqual([]);
    expect(JSON.stringify((await contents(existing.request, mine.id)).nodes)).not.toContain("r.txt");

    // the owner's trash entry still holds the file, and the stranger's squatting card is what stops the undo
    expect((await trash(request)).map((t) => t.id)).toContain(file.id);
  });

  test("a file's owner can still undo, and gets the file and its bytes back", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const file = await createArtefact(request, board.id, "file", { title: "Report" });
    expect((await uploadFile(request, file.id, { name: "r.txt", type: "text/plain", data: "owner bytes" })).ok()).toBe(true);
    const saved = await nodeById(request, file.id);
    await deleteNode(request, file.id);

    expect((await request.post("/api/nodes", { data: undoBody(saved, board.id) })).status()).toBe(201);
    const files = await listFiles(request, file.id);
    expect(files.map((f) => f.name)).toEqual(["r.txt"]);
    expect(await (await request.get(files[0]!.url!)).text()).toBe("owner bytes");
  });

  test("the trash dialog's restore will not put an archive onto a card someone else made under that id", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const file = await createArtefact(request, board.id, "file", { title: "Report" });
    expect((await uploadFile(request, file.id, { name: "r.txt", type: "text/plain", data: "owner bytes" })).ok()).toBe(true);
    const saved = await nodeById(request, file.id);
    await deleteNode(request, file.id);
    const mine = await createBoard(existing.request, "Theirs");
    expect((await existing.request.post("/api/nodes", { data: undoBody(saved, mine.id) })).status()).toBe(201);

    const res = await request.post(`/api/trash/${file.id}/restore`);
    expect(res.status()).toBe(409);
    expect(await listFiles(existing.request, file.id)).toEqual([]);
  });
});

test.describe("restoring on a shared mindmap", () => {
  test("an editor's undo works for what they deleted, and for what the owner deleted", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Shared");
    await addMember(request, "boards", board.id, existing.user.email, "editor");
    const mine = await createArtefact(existing.request, board.id, "sheet", { title: "Theirs", ...authored.sheet });
    const owners = await createArtefact(request, board.id, "sheet", { title: "Owner's", ...authored.sheet });

    await deleteNode(existing.request, mine.id);
    expect((await existing.request.post("/api/nodes", { data: undoBody(mine, board.id) })).status()).toBe(201);

    // deleted by the owner, put back by a collaborator who can write there
    await deleteNode(request, owners.id);
    const res = await existing.request.post("/api/nodes", { data: undoBody(owners, board.id) });
    expect(res.status()).toBe(201);
    expect(JSON.stringify(await (await existing.request.get(`/api/artefacts/${owners.id}`)).json())).toContain(SECRET);
  });

  test("the owner can undo what an editor deleted", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Shared");
    await addMember(request, "boards", board.id, existing.user.email, "editor");
    const sheet = await createArtefact(existing.request, board.id, "sheet", { title: "Theirs", ...authored.sheet });
    await deleteNode(existing.request, sheet.id);
    expect((await request.post("/api/nodes", { data: undoBody(sheet, board.id) })).status()).toBe(201);
  });

  test("an editor who was removed from the mindmap can no longer restore what the owner deleted", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Shared");
    const added = await addMember(request, "boards", board.id, existing.user.email, "editor");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "Owner's", ...authored.sheet });
    await deleteNode(request, sheet.id);
    const mine = await createBoard(existing.request, "Theirs");
    const gone = await request.delete(`/api/boards/${board.id}/members/${added.added!.userId}`);
    expect(gone.ok()).toBe(true);
    expect((await existing.request.post("/api/nodes", { data: undoBody(sheet, mine.id) })).status()).toBe(410);
  });

  test("an editor's Undo button brings back a sheet they deleted, with its contents", async ({ account, request, existing, openAs }) => {
    void account;
    const board = await createBoard(request, "Shared");
    await addMember(request, "boards", board.id, existing.user.email, "editor");
    const sheet = await createArtefact(existing.request, board.id, "sheet", { title: "Budget", ...authored.sheet });
    const page = await openAs(existing);
    const b = new Board(page, page.request, board.id);
    await b.open();
    await b.node(sheet.id).hover();
    const gone = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/api/nodes/${sheet.id}`));
    await b.deleteButton(sheet.id).click();
    await gone;
    await expect(b.node(sheet.id)).toHaveCount(0);
    const back = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/nodes"));
    await page.getByRole("button", { name: "Undo" }).click();
    expect((await back).status()).toBe(201);
    await expect(b.node(sheet.id)).toBeVisible();
    expect(JSON.stringify(await (await existing.request.get(`/api/artefacts/${sheet.id}`)).json())).toContain(SECRET);
  });
});
