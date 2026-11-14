import { test, expect } from "@playwright/test";
import { register } from "../../fixtures";
import { createArtefact, createBoard, contents, deleteNode, trash } from "../../support/api";
import { ExpiryWorker } from "../../support/expiry";
import { newUser } from "../../support/users";

// A trash entry is good for seven days. Past that it cannot be restored by
// anyone, its owner included, even if the cron has not swept it yet. Runs on its
// own Worker (see support/expiry.ts) because it has to backdate the entry.

test.describe.configure({ mode: "serial" });

const SECRET = "the-secret-cell";
const worker = new ExpiryWorker();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await worker.start();
});
test.afterAll(async () => {
  await worker.stop();
});

test("an entry past its seven days is refused to its owner and to a collaborator, and is not listed; one inside the window still restores", async () => {
  test.setTimeout(240_000);
  const owner = await worker.client();
  const editor = await worker.client();
  const ownerUser = newUser("owner");
  const editorUser = newUser("editor");
  await register(owner, ownerUser);
  await register(editor, editorUser);

  const board = await createBoard(owner, "Owner's");
  const invite = await owner.post(`/api/boards/${board.id}/members`, { data: { email: editorUser.email, role: "editor" } });
  expect(invite.ok()).toBe(true);

  const make = (type: "sheet" | "doc", title: string) =>
    createArtefact(owner, board.id, type, type === "sheet"
      ? { title, sheets: [{ name: "S", rows: [[SECRET]] }] }
      : { title, blocks: [SECRET] });
  const old = await make("sheet", "Old");
  const oldByEditor = await make("doc", "Old, owner deleted");
  const recent = await make("sheet", "Recent");
  for (const n of [old, oldByEditor, recent]) await deleteNode(owner, n.id);

  await worker.age([old.id, oldByEditor.id], 8);
  // sessions live in the database, so the same cookies are still good
  const body = (n: typeof old) => ({ id: n.id, board_id: board.id, type: n.type, title: n.title, data: n.data });

  expect((await trash(owner)).map((t) => t.id)).toEqual([recent.id]);
  const res = await owner.post("/api/nodes", { data: body(old) });
  expect(res.status()).toBe(410);
  expect(await res.text()).not.toContain(SECRET);
  expect((await owner.post(`/api/trash/${old.id}/restore`)).status()).toBe(404);
  expect((await editor.post("/api/nodes", { data: body(oldByEditor) })).status()).toBe(410);
  expect((await contents(owner, board.id)).nodes).toEqual([]);

  expect((await owner.post("/api/nodes", { data: body(recent) })).status()).toBe(201);
});
