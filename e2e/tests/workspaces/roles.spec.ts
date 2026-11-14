import { test, expect } from "../../fixtures";
import { addMember, createBoard, createEdge, createNode, createWorkspace, nodeById } from "../../support/api";

// What each role may do inside a workspace, checked where it is enforced: the
// API. (The UI does not hide controls from a viewer; see the sharing specs.)
// Roles that exist: owner (the workspace's creator, never a membership row),
// editor ("Can edit"), viewer ("Can view").

test.describe("a viewer of a workspace", () => {
  test("can read its mindmaps and cards, and nothing else", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Read-only");
    const board = await createBoard(request, "Plan", { workspace_id: ws.id });
    const card = await createNode(request, board.id, { title: "Card", x: 0, y: 0 });
    const other = await createNode(request, board.id, { title: "Other", x: 10, y: 0 });
    await addMember(request, "workspaces", ws.id, existing.user.email, "viewer");
    const v = existing.request;

    expect((await v.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    expect((await v.get(`/api/nodes/${card.id}`)).status()).toBe(200);
    expect((await v.get(`/api/boards/${board.id}/cards`)).status()).toBe(200);
    expect(((await (await v.get("/api/boards")).json()) as { id: string }[]).map((b) => b.id)).toContain(board.id);

    const denied = async (res: Awaited<ReturnType<typeof v.get>>) => {
      expect(res.status()).toBe(403);
    };
    await denied(await v.post("/api/nodes", { data: { board_id: board.id, title: "x" } }));
    await denied(await v.patch(`/api/nodes/${card.id}`, { data: { title: "changed" } }));
    await denied(await v.delete(`/api/nodes/${card.id}`));
    await denied(await v.post("/api/boards", { data: { name: "mine", workspace_id: ws.id } }));
    // links answer 404 rather than 403 to a viewer (canWriteNode has no "can see it" branch)
    expect((await v.post("/api/edges", { data: { source_id: card.id, target_id: other.id } })).status()).toBe(404);
    expect((await nodeById(request, card.id)).title).toBe("Card");
  });

  test("cannot rename, pin or delete a mindmap, or see or change who has access", async ({ account, request, existing, makePerson }) => {
    void account;
    const ws = await createWorkspace(request, "Locked");
    const board = await createBoard(request, "Plan", { workspace_id: ws.id });
    await addMember(request, "workspaces", ws.id, existing.user.email, "viewer");
    const third = await makePerson("third");
    const v = existing.request;

    expect((await v.patch(`/api/boards/${board.id}`, { data: { name: "Hijacked" } })).status()).toBe(403);
    expect((await v.patch(`/api/boards/${board.id}`, { data: { pinned: true } })).status()).toBe(403);
    expect((await v.delete(`/api/boards/${board.id}`)).status()).toBe(403);
    // the member list is the owner's: for everyone else it does not exist
    expect((await v.get(`/api/workspaces/${ws.id}/members`)).status()).toBe(404);
    expect((await v.post(`/api/workspaces/${ws.id}/members`, { data: { email: third.user.email } })).status()).toBe(403);
    expect((await v.post(`/api/boards/${board.id}/members`, { data: { email: third.user.email } })).status()).toBe(403);
    expect((await request.get(`/api/boards/${board.id}/contents`)).ok()).toBe(true);
    const mine = await (await request.get(`/api/boards/${board.id}/contents`)).json();
    expect(mine.board.name).toBe("Plan");
    expect(mine.board.pinned).toBe(false);
  });

  test("cannot promote themselves by inviting their own address", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "No self-promotion");
    await addMember(request, "workspaces", ws.id, existing.user.email, "viewer");
    const res = await existing.request.post(`/api/workspaces/${ws.id}/members`, {
      data: { email: existing.user.email, role: "editor" },
    });
    expect(res.status()).toBe(403);
    const { members } = await (await request.get(`/api/workspaces/${ws.id}/members`)).json();
    expect(members.map((m: { role: string }) => m.role)).toEqual(["viewer"]);
  });
});

test.describe("an editor of a workspace", () => {
  test("can add mindmaps, cards and links, and change cards the owner made", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Editors");
    const ownersBoard = await createBoard(request, "Owner's", { workspace_id: ws.id });
    const card = await createNode(request, ownersBoard.id, { title: "Owner card", x: 0, y: 0 });
    await addMember(request, "workspaces", ws.id, existing.user.email, "editor");
    const e = existing.request;

    const mine = await createBoard(e, "Editor's", { workspace_id: ws.id });
    expect(mine.workspace_id).toBe(ws.id);
    const added = await createNode(e, ownersBoard.id, { title: "Editor card", x: 5, y: 5 });
    expect((await e.patch(`/api/nodes/${card.id}`, { data: { title: "Edited by editor" } })).ok()).toBe(true);
    expect((await nodeById(request, card.id)).title).toBe("Edited by editor");
    const edge = await createEdge(e, { source_id: card.id, target_id: added.id });
    expect(edge.source_id).toBe(card.id);
    // and the owner sees the editor's mindmap in the same workspace
    const list = (await (await request.get("/api/boards")).json()) as { id: string }[];
    expect(list.map((b) => b.id)).toContain(mine.id);
  });

  test("cannot rename, pin or delete a mindmap, not even one they made themselves", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Owner decides");
    await addMember(request, "workspaces", ws.id, existing.user.email, "editor");
    const e = existing.request;
    const theirs = await createBoard(e, "Made by editor", { workspace_id: ws.id });

    expect((await e.patch(`/api/boards/${theirs.id}`, { data: { name: "renamed" } })).status()).toBe(403);
    expect((await e.delete(`/api/boards/${theirs.id}`)).status()).toBe(403);
    // the workspace owner can, because the workspace is theirs
    expect((await request.patch(`/api/boards/${theirs.id}`, { data: { name: "Renamed by owner" } })).ok()).toBe(true);
    expect((await request.delete(`/api/boards/${theirs.id}`)).ok()).toBe(true);
  });

  test("cannot invite, remove other members, or see the member list", async ({ account, request, existing, makePerson }) => {
    void account;
    const ws = await createWorkspace(request, "Closed door");
    const other = await makePerson("other");
    await addMember(request, "workspaces", ws.id, existing.user.email, "editor");
    await addMember(request, "workspaces", ws.id, other.user.email, "viewer");
    const e = existing.request;
    const ownerId = ((await (await request.get("/api/auth/me")).json()) as { user: { id: string } }).user.id;
    const otherId = ((await (await other.request.get("/api/auth/me")).json()) as { user: { id: string } }).user.id;

    expect((await e.get(`/api/workspaces/${ws.id}/members`)).status()).toBe(404);
    expect((await e.post(`/api/workspaces/${ws.id}/members`, { data: { email: "someone@example.test" } })).status()).toBe(403);
    expect((await e.delete(`/api/workspaces/${ws.id}/members/${otherId}`)).status()).toBe(403);
    expect((await e.delete(`/api/workspaces/${ws.id}/members/${ownerId}`)).status()).toBe(403);
    const { members, pending } = await (await request.get(`/api/workspaces/${ws.id}/members`)).json();
    expect(members).toHaveLength(2);
    expect(pending).toEqual([]);
  });
});

test.describe("the workspace owner", () => {
  test("is listed as Owner and never appears among the members", async ({
    account,
    request,
    existing,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Owned");
    const list = (await (await request.get("/api/workspaces")).json()) as { id: string; role: string }[];
    expect(list.find((w) => w.id === ws.id)?.role).toBe("owner");
    await addMember(request, "workspaces", ws.id, existing.user.email, "editor");
    const members = (await (await request.get(`/api/workspaces/${ws.id}/members`)).json()).members;
    expect(members.map((m: { role: string }) => m.role)).not.toContain("owner");
  });

  test("a blank name becomes 'New workspace'", async ({ account, request }) => {
    void account;
    const res = await request.post("/api/workspaces", { data: { name: "   " } });
    expect(res.status()).toBe(201);
    expect((await res.json()).name).toBe("New workspace");
  });

  test("workspaces cannot be renamed or deleted: the API has no such routes", async ({ account, request }) => {
    void account;
    const ws = await createWorkspace(request, "Permanent");
    expect((await request.patch(`/api/workspaces/${ws.id}`, { data: { name: "x" } })).status()).toBe(404);
    expect((await request.delete(`/api/workspaces/${ws.id}`)).status()).toBe(404);
  });
});
