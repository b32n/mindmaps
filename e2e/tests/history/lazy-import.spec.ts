import { test, expect } from "@playwright/test";
import { register } from "../../fixtures";
import { createArtefact, createBoard, createNode } from "../../support/api";
import { ExpiryWorker } from "../../support/expiry";
import { connectMcp } from "../../support/mcp";
import { migrationFiles } from "../../support/versions";
import { query, versionsOf } from "../../support/versions";
import { newUser } from "../../support/users";

// A node that exists from before history (or was written by a Worker that did not
// know about it) gets its current state recorded as a version the first time it
// is touched, so the write that follows never destroys the only copy of it.
// Runs on a private Worker (support/expiry.ts) because it has to take versions
// away and change rows underneath the app, which the shared one cannot allow.

test.describe.configure({ mode: "serial" });

const worker = new ExpiryWorker();
test.beforeAll(async () => {
  test.setTimeout(240_000);
  await worker.start();
});
test.afterAll(async () => {
  await worker.dispose();
});

const SHEET = [{ name: "Old", rows: [["was", 1]] }];
const q = <T,>(sql: string, p: Array<string | number | null> = []) => query<T>(sql, p, worker.state);
const vs = (id: string) => versionsOf(id, worker.state);

test("a node with no versions is imported on first touch, by a person and by an agent", async () => {
  test.setTimeout(240_000);
  const request = await worker.client();
  await register(request, newUser("lazy"));
  const board = await createBoard(request, "Before history");
  const card = await createNode(request, board.id, { title: "Original title" });
  const sheet = await createArtefact(request, board.id, "sheet", { title: "Old sheet", sheets: SHEET });
  const untouched = await createNode(request, board.id, { title: "Left alone" });
  const mcp = await connectMcp(request, { clientName: "late-agent" });
  // the state of a database migrated under existing data: nodes, no versions
  await worker.execute(`DELETE FROM versions; DELETE FROM version_heads;`);
  expect(await vs(card.id)).toEqual([]);

  expect((await request.patch(`/api/nodes/${card.id}`, { data: { title: "New title" } })).ok()).toBe(true);
  const c = await vs(card.id);
  expect(c.map((r) => [r.seq, r.op, r.status, r.title])).toEqual([
    [1, "import", "sealed", "Original title"],
    [2, "edit", "open", "New title"],
  ]);
  expect(c[0]).toMatchObject({ actor_via: "system", board_id: board.id, workspace_id: board.workspace_id });

  const r = await mcp.call("update_artefact", { id: sheet.id, sheets: [{ name: "New", rows: [["is", 2]] }] });
  expect(r.isError, r.text).toBe(false);
  const s = await vs(sheet.id);
  expect(s.map((x) => [x.seq, x.op, x.status])).toEqual([[1, "import", "sealed"], [2, "edit", "sealed"]]);
  expect(s[0]!.payload_key).toMatch(new RegExp(`^versions/${sheet.id}/`));
  expect(s[0]!.payload_key).not.toBe(s[1]!.payload_key);
  expect(s[1]).toMatchObject({ actor_client_name: "late-agent", actor_via: "mcp" });

  // merely moving a node is not touching its content
  expect((await request.patch(`/api/nodes/${untouched.id}`, { data: { x: 50, y: 60 } })).ok()).toBe(true);
  expect(await vs(untouched.id)).toEqual([]);
});

test("applying the migration again over a database with history changes nothing", async () => {
  test.setTimeout(240_000);
  const request = await worker.client();
  await register(request, newUser("again"));
  const board = await createBoard(request, "Twice");
  const card = await createNode(request, board.id, { title: "Kept" });
  const before = await q(`SELECT * FROM versions ORDER BY id`);
  const heads = await q(`SELECT * FROM version_heads ORDER BY node_id`);
  expect(before.length).toBeGreaterThan(0);
  const file = migrationFiles().find((f) => /_versions\.sql$/.test(f))!;
  await worker.executeFile(`worker/migrations/${file}`);
  expect(await q(`SELECT * FROM versions ORDER BY id`)).toEqual(before);
  expect(await q(`SELECT * FROM version_heads ORDER BY node_id`)).toEqual(heads);
  expect((await vs(card.id)).length).toBe(1);
});

test("a write made while no version was being recorded is captured before the next one lands", async () => {
  test.setTimeout(240_000);
  const request = await worker.client();
  await register(request, newUser("rollback"));
  const board = await createBoard(request, "Rolled back");
  const card = await createNode(request, board.id, { title: "Recorded", body: "" });
  // what a Worker from before this change does: it writes the row and nothing else
  await worker.execute(`UPDATE nodes SET title = 'Written by the old Worker', updated_at = updated_at + 5000 WHERE id = '${card.id}'`);

  expect((await request.patch(`/api/nodes/${card.id}`, { data: { title: "Written by the new one" } })).ok()).toBe(true);
  const rows = await vs(card.id);
  expect(rows.map((r) => [r.seq, r.op, r.title])).toEqual([
    [1, "create", "Recorded"],
    [2, "import", "Written by the old Worker"],
    [3, "edit", "Written by the new one"],
  ]);
  expect(rows[1]).toMatchObject({ status: "sealed", actor_via: "system" });
});
