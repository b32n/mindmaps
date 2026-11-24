import { test, expect } from "@playwright/test";
import { register } from "../../fixtures";
import { createBoard, createWorkspace, listWorkspaces } from "../../support/api";
import { ExpiryWorker } from "../../support/expiry";
import { closeWorkspace, closedWorkspaces, reopenWorkspace } from "../../support/lifecycle";
import { newUser } from "../../support/users";
import { query } from "../../support/versions";

// A closed workspace can be reopened for 30 days. Past that the owner is told
// it is too late (410), the list says so, and nothing is deleted: there is no
// purge in this change. Runs on its own Worker (support/expiry.ts) because it
// has to backdate closed_at.

test.describe.configure({ mode: "serial" });

const DAY = 24 * 60 * 60 * 1000;
const worker = new ExpiryWorker();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await worker.start();
});
test.afterAll(async () => {
  await worker.dispose();
});

test("inside 30 days it reopens; past 30 days it is refused and listed as not reopenable, and its data is still there", async () => {
  test.setTimeout(240_000);
  const owner = await worker.client();
  await register(owner, newUser("owner"));
  const young = await createWorkspace(owner, "Young");
  const old = await createWorkspace(owner, "Old");
  const oldBoard = await createBoard(owner, "Kept", { workspace_id: old.id });
  expect((await closeWorkspace(owner, young.id)).status()).toBe(200);
  expect((await closeWorkspace(owner, old.id)).status()).toBe(200);

  const ago = (days: number) => Date.now() - days * DAY;
  await worker.execute(`UPDATE workspaces SET closed_at = ${ago(29)} WHERE id = '${young.id}'`);
  await worker.execute(`UPDATE workspaces SET closed_at = ${ago(31)} WHERE id = '${old.id}'`);

  const list = await closedWorkspaces(owner);
  expect(list.find((w) => w.id === young.id)).toMatchObject({ reopenable: true });
  expect(list.find((w) => w.id === old.id)).toMatchObject({ reopenable: false });

  const late = await reopenWorkspace(owner, old.id);
  expect(late.status()).toBe(410);
  expect((await listWorkspaces(owner)).map((w) => w.id)).not.toContain(old.id);

  expect((await reopenWorkspace(owner, young.id)).status()).toBe(200);
  expect((await listWorkspaces(owner)).map((w) => w.id)).toContain(young.id);

  // never purged: the rows are still there, and a late reopen stays refused
  expect((await owner.get(`/api/boards/${oldBoard.id}/contents`)).status()).toBe(404);
  expect((await reopenWorkspace(owner, old.id)).status()).toBe(410);
  expect((await query<any>(`SELECT COUNT(*) AS n FROM boards WHERE id = ?`, [oldBoard.id], worker.state))[0].n).toBe(1);
  expect((await query<any>(`SELECT status FROM workspaces WHERE id = ?`, [old.id], worker.state))[0].status).toBe("closed");
});
