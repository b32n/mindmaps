import { test, expect } from "../../fixtures";
import {
  addMember, contents, createArtefact, createBoard, createNode, createWorkspace, deleteNode, nodeById, trash,
} from "../../support/api";

// An entry in the trash belongs to whoever deleted it. Another user creating a
// node under the same id and deleting that must not overwrite or claim it, and a
// restore must be made with the access the user has now, not the access they had
// when they deleted it.

test.describe("a trash entry cannot be taken over", () => {
  test("deleting a squatting card under a trashed id leaves the original owner's entry alone", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const card = await createNode(request, board.id, { title: "Mine", body: "owner body" });
    await deleteNode(request, card.id);

    // the stranger knows the id only: nothing stops them making a node with it on their own map
    const theirs = await createBoard(existing.request, "Theirs");
    const squat = await existing.request.post("/api/nodes", {
      data: { id: card.id, board_id: theirs.id, type: "card", title: "Squatter", body: "stranger body" },
    });
    expect(squat.status()).toBe(201);
    await deleteNode(existing.request, card.id);

    // not claimed
    expect((await trash(existing.request)).map((t) => t.id)).not.toContain(card.id);
    const entry = (await trash(request)).find((t) => t.id === card.id);
    expect(entry?.label).toBe("Mine");

    // and the owner's restore brings back the owner's card, on the owner's map
    const res = await request.post(`/api/trash/${card.id}/restore`);
    expect(res.status()).toBe(200);
    const back = await nodeById(request, card.id);
    expect(back.title).toBe("Mine");
    expect(back.body).toBe("owner body");
    expect(back.board_id).toBe(board.id);
    expect((await contents(existing.request, theirs.id)).nodes).toEqual([]);
  });

  test("the stranger's own delete does not give them a copy of the owner's entry", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const card = await createNode(request, board.id, { title: "Mine", body: "owner body" });
    await deleteNode(request, card.id);
    const theirs = await createBoard(existing.request, "Theirs");
    await existing.request.post("/api/nodes", { data: { id: card.id, board_id: theirs.id, type: "card", title: "Squatter" } });
    await deleteNode(existing.request, card.id);
    expect((await existing.request.post(`/api/trash/${card.id}/restore`)).status()).toBe(404);
    expect((await contents(existing.request, theirs.id)).nodes).toEqual([]);
  });

  test("a collaborator's delete, the owner's undo and the owner's next delete all keep working", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Shared");
    await addMember(request, "boards", board.id, existing.user.email, "editor");
    const card = await createNode(request, board.id, { title: "Shared card" });

    await deleteNode(existing.request, card.id);
    const undo = await request.post("/api/nodes", {
      data: { id: card.id, board_id: board.id, type: "card", title: "Shared card", data: card.data },
    });
    expect(undo.status()).toBe(201);

    await deleteNode(request, card.id);
    expect((await trash(request)).map((t) => t.id)).toContain(card.id);
    expect((await request.post(`/api/trash/${card.id}/restore`)).status()).toBe(200);
    expect((await nodeById(request, card.id)).title).toBe("Shared card");
  });
});

test.describe("restoring needs write access to the place it goes back to", () => {
  test("an editor removed from a workspace cannot restore their deleted card into it", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Team");
    const added = await addMember(request, "workspaces", ws.id, existing.user.email, "editor");
    const board = await createBoard(existing.request, "Team map", { workspace_id: ws.id });
    const card = await createNode(existing.request, board.id, { title: "Theirs" });
    await deleteNode(existing.request, card.id);

    expect((await request.delete(`/api/workspaces/${ws.id}/members/${added.added!.userId}`)).ok()).toBe(true);

    const res = await existing.request.post(`/api/trash/${card.id}/restore`);
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/access/i);
    // nothing landed on the map they can no longer reach, and the entry is still there to retry
    expect((await contents(request, board.id)).nodes).toEqual([]);
    expect((await trash(existing.request)).map((t) => t.id)).toContain(card.id);

    // once they have access again it works
    await addMember(request, "workspaces", ws.id, existing.user.email, "editor");
    expect((await existing.request.post(`/api/trash/${card.id}/restore`)).status()).toBe(200);
    expect((await contents(request, board.id)).nodes.map((n) => n.id)).toEqual([card.id]);
  });

  test("an editor demoted to viewer cannot restore their deleted card", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Shared");
    await addMember(request, "boards", board.id, existing.user.email, "editor");
    const card = await createNode(existing.request, board.id, { title: "Theirs" });
    await deleteNode(existing.request, card.id);
    await addMember(request, "boards", board.id, existing.user.email, "viewer");

    expect((await existing.request.post(`/api/trash/${card.id}/restore`)).status()).toBe(409);
    expect((await contents(request, board.id)).nodes).toEqual([]);
  });
});

test.describe("writes to artefacts through the REST API", () => {
  test("PUT /api/artefacts bumps the mindmap's updated_at", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Stamped");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "S", sheets: [{ name: "A", rows: [[1]] }] });
    const before = (await request.get("/api/boards").then((r) => r.json()) as any[]).find((b) => b.id === board.id);
    await new Promise((r) => setTimeout(r, 25));
    const put = await request.put(`/api/artefacts/${sheet.id}`, { data: { sheets: [{ name: "A", rows: [[2]] }] } });
    expect(put.ok(), await put.text()).toBe(true);
    const after = (await request.get("/api/boards").then((r) => r.json()) as any[]).find((b) => b.id === board.id);
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
  });

  test("POST /api/nodes refuses a malformed data.workbook like PUT does", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Checked");
    for (const bad of [null, [], "x", { sheets: "nope" }, {}]) {
      const res = await request.post("/api/nodes", {
        data: { board_id: board.id, type: "sheet", title: "Bad", data: { workbook: bad } },
      });
      // null is "no workbook given", which is a blank sheet and fine; the rest are refused
      if (bad === null) expect(res.status()).toBe(201);
      else expect(res.status(), JSON.stringify(bad)).toBe(400);
    }
    const ok = await request.post("/api/nodes", {
      data: { board_id: board.id, type: "sheet", title: "Good", data: { workbook: { sheets: [{ name: "A", rows: [[1]] }] } } },
    });
    expect(ok.status()).toBe(201);
  });
});
