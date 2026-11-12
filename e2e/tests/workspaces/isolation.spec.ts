import { randomUUID } from "node:crypto";
import { test, expect } from "../../fixtures";
import {
  addMember,
  contents,
  createArtefact,
  createBoard,
  createLink,
  createNode,
  createWorkspace,
  listBoards,
  listFiles,
  nodeById,
  uploadFile,
  type ApiNode,
} from "../../support/api";
import type { APIRequestContext } from "@playwright/test";

// A person who is not in a workspace gets nothing from it: not through the
// UI's lists, and not by guessing ids against the API. The owner's data is
// arranged through the API; the stranger is a second signed-in person.

async function world(request: APIRequestContext) {
  const ws = await createWorkspace(request, "Private");
  const board = await createBoard(request, "Private board", { workspace_id: ws.id });
  const card = await createNode(request, board.id, { title: "Private card", body: "secret body", x: 0, y: 0 });
  const other = await createNode(request, board.id, { title: "Other card", x: 10, y: 10 });
  const sheet = await createArtefact(request, board.id, "sheet", { title: "Private sheet", sheets: [{ name: "S", rows: [["a", 1]] }] });
  const folder = await createArtefact(request, board.id, "folder", { title: "Private folder" });
  const up = await uploadFile(request, folder.id, { name: "plan.txt", type: "text/plain", data: "private text" });
  expect(up.status()).toBe(201);
  const [file] = await listFiles(request, folder.id);
  const link = await createLink(request, sheet.id);
  return { ws, board, card, other, sheet, folder, file, link };
}

test.describe("a stranger cannot reach another workspace's data", () => {
  test("lists never include it: mindmaps, artefacts and workspaces", async ({ account, request, existing }) => {
    void account;
    const w = await world(request);
    const v = existing.request;

    expect((await listBoards(v)).map((b) => b.id)).not.toContain(w.board.id);
    const artefacts = (await (await v.get("/api/artefacts")).json()) as { id: string }[];
    expect(artefacts).toEqual([]);
    const spaces = (await (await v.get("/api/workspaces")).json()) as { id: string }[];
    expect(spaces.map((s) => s.id)).not.toContain(w.ws.id);
  });

  test("every read answers 404, exactly as for an id that does not exist", async ({ account, request, existing }) => {
    void account;
    const w = await world(request);
    const v = existing.request;
    const missing = randomUUID();

    // [what, real path, same path with a made-up id]
    const reads: [string, (id: string) => string, string][] = [
      ["board contents", (id) => `/api/boards/${id}/contents`, w.board.id],
      ["board cards", (id) => `/api/boards/${id}/cards`, w.board.id],
      ["card", (id) => `/api/nodes/${id}`, w.card.id],
      ["artefact payload", (id) => `/api/artefacts/${id}`, w.sheet.id],
      ["artefact frame", (id) => `/api/artefacts/${id}/frame`, w.sheet.id],
      ["file list", (id) => `/api/nodes/${id}/files`, w.folder.id],
      ["board people", (id) => `/api/boards/${id}/members`, w.board.id],
      ["workspace people", (id) => `/api/workspaces/${id}/members`, w.ws.id],
      ["artefact people", (id) => `/api/artefacts/${id}/members`, w.sheet.id],
    ];
    for (const [what, path, realId] of reads) {
      await test.step(what, async () => {
        const real = await v.get(path(realId));
        const fake = await v.get(path(missing));
        expect(real.status(), `${what} on a real foreign id`).toBe(404);
        expect(fake.status()).toBe(404);
        expect(await real.text(), `${what}: the body must not tell the two apart`).toBe(await fake.text());
      });
    }
  });

  test("every write is refused and changes nothing", async ({ account, request, existing }) => {
    void account;
    const w = await world(request);
    const v = existing.request;
    const before = await contents(request, w.board.id);

    const attempts: [string, Awaited<ReturnType<typeof v.post>>][] = [
      ["add a card", await v.post("/api/nodes", { data: { board_id: w.board.id, title: "planted" } })],
      ["edit a card", await v.patch(`/api/nodes/${w.card.id}`, { data: { title: "hijacked" } })],
      ["delete a card", await v.delete(`/api/nodes/${w.card.id}`)],
      ["rename the mindmap", await v.patch(`/api/boards/${w.board.id}`, { data: { name: "hijacked" } })],
      ["delete the mindmap", await v.delete(`/api/boards/${w.board.id}`)],
      ["overwrite a sheet", await v.put(`/api/artefacts/${w.sheet.id}`, { data: { id: "x", sheets: [] } })],
      ["upload into a folder", await uploadFile(v, w.folder.id, { name: "x.txt", type: "text/plain", data: "planted" })],
      ["rename a file", await v.patch(`/api/files/${w.file.id}`, { data: { name: "hijacked.txt" } })],
      ["delete a file", await v.delete(`/api/files/${w.file.id}`)],
      ["link its cards", await v.post("/api/edges", { data: { source_id: w.card.id, target_id: w.other.id } })],
      ["link their card to yours", await v.post("/api/edges", { data: { source_id: w.card.id, target_id: (await createNode(v, (await createBoard(v, "Mine")).id, { title: "mine" })).id } })],
      ["publish a link to a sheet", await v.post(`/api/artefacts/${w.sheet.id}/share`, { data: {} })],
      ["revoke someone's public link", await v.delete(`/api/shares/${w.link.token}`)],
    ];
    for (const [what, res] of attempts) {
      expect([403, 404], `${what}: ${res.status()}`).toContain(res.status());
      expect(res.ok(), what).toBe(false);
    }

    const after = await contents(request, w.board.id);
    expect(after.board.name).toBe("Private board");
    expect(after.nodes.map((n: ApiNode) => [n.id, n.title]).sort()).toEqual(before.nodes.map((n: ApiNode) => [n.id, n.title]).sort());
    expect(after.edges).toEqual([]);
    expect((await listFiles(request, w.folder.id)).map((f) => f.name)).toEqual(["plan.txt"]);
    // the link still works for the person it was meant for
    expect((await request.get(`/api/shared/${w.link.token}`)).status()).toBe(200);
  });

  test("they cannot create mindmaps in it, invite themselves, or make themselves an owner", async ({ account, request, existing }) => {
    void account;
    const w = await world(request);
    const v = existing.request;

    expect((await v.post("/api/boards", { data: { name: "planted", workspace_id: w.ws.id } })).status()).toBe(403);
    expect((await v.post(`/api/workspaces/${w.ws.id}/members`, { data: { email: existing.user.email } })).status()).toBe(403);
    expect((await v.post(`/api/boards/${w.board.id}/members`, { data: { email: existing.user.email } })).status()).toBe(403);
    expect((await v.post(`/api/artefacts/${w.sheet.id}/members`, { data: { email: existing.user.email } })).status()).toBe(403);
    expect((await listBoards(request)).map((b) => b.name)).not.toContain("planted");
  });

  test("reordering the rail with a foreign mindmap's id changes nothing", async ({ account, request, existing }) => {
    void account;
    const w = await world(request);
    const before = (await contents(request, w.board.id)).board.position;
    const res = await existing.request.post("/api/boards/reorder", { data: { ids: [w.board.id] } });
    expect(res.ok()).toBe(true);
    expect((await res.json()).count).toBeUndefined();
    expect((await contents(request, w.board.id)).board.position).toBe(before);
  });

  test("an unsigned download URL, or one with a tampered signature, serves nothing", async ({ account, request, existing }) => {
    void account;
    const w = await world(request);
    const signed = (await listFiles(request, w.folder.id))[0].url!;
    expect((await request.get(signed)).status()).toBe(200);

    const v = existing.request;
    expect((await v.get(`/f/${w.file.id}`)).status()).toBe(403);
    const tampered = signed.replace(/sig=[0-9a-f]{4}/, "sig=0000");
    expect((await v.get(tampered)).status()).toBe(403);
    // a valid signature for one file does not open another id
    const swapped = signed.replace(w.file.id, randomUUID());
    expect((await v.get(swapped)).status()).toBe(404);
  });

  test("a public link opens the one artefact it names and nothing around it", async ({ account, request, playwright, baseURL }) => {
    void account;
    const w = await world(request);
    const anon = await playwright.request.newContext({ baseURL });
    const shared = await anon.get(`/api/shared/${w.link.token}`);
    expect(shared.status()).toBe(200);
    const body = await shared.json();
    expect(Object.keys(body).sort()).toEqual(["frame", "kind", "payload", "title"]);
    expect(body.kind).toBe("sheet");
    // the link is not a session: the owner's endpoints stay closed to the anonymous
    expect((await anon.get(`/api/boards/${w.board.id}/contents`)).status()).toBe(401);
    expect((await anon.get(`/api/nodes/${w.card.id}`)).status()).toBe(401);
    expect((await anon.get(`/api/artefacts/${w.sheet.id}`)).status()).toBe(401);
    // a token must be the real thing: a guess or a truncated token is "not available"
    expect((await anon.get(`/api/shared/${w.link.token.slice(0, 15)}`)).status()).toBe(404);
    expect((await anon.get(`/api/shared/${"a".repeat(20)}`)).status()).toBe(404);
    await anon.dispose();
  });
});

test.describe("membership is what opens a workspace", () => {
  test("a mindmap shared on its own opens that mindmap only, not the rest of its workspace", async ({ account, request, existing }) => {
    void account;
    const w = await world(request);
    const sibling = await createBoard(request, "Sibling board", { workspace_id: w.ws.id });
    await addMember(request, "boards", w.board.id, existing.user.email, "viewer");
    const v = existing.request;

    expect((await v.get(`/api/boards/${w.board.id}/contents`)).status()).toBe(200);
    expect((await v.get(`/api/boards/${sibling.id}/contents`)).status()).toBe(404);
    expect((await listBoards(v)).map((b) => b.name)).toContain("Private board");
    expect((await listBoards(v)).map((b) => b.name)).not.toContain("Sibling board");
    // it does not make them a member of the workspace
    expect(((await (await v.get("/api/workspaces")).json()) as { id: string }[]).map((s) => s.id)).not.toContain(w.ws.id);
    expect((await nodeById(v, w.card.id)).title).toBe("Private card");
  });

  test("an artefact granted on its own opens that artefact only: its board and siblings stay closed", async ({ account, request, existing }) => {
    void account;
    const w = await world(request);
    await addMember(request, "artefacts", w.sheet.id, existing.user.email, "viewer");
    const v = existing.request;

    expect((await v.get(`/api/artefacts/${w.sheet.id}`)).status()).toBe(200);
    expect((await v.get(`/api/nodes/${w.sheet.id}`)).status()).toBe(200);
    expect((await v.get(`/api/boards/${w.board.id}/contents`)).status()).toBe(404);
    expect((await v.get(`/api/nodes/${w.card.id}`)).status()).toBe(404);
    expect((await v.get(`/api/nodes/${w.folder.id}/files`)).status()).toBe(404);
    const listed = (await (await v.get("/api/artefacts")).json()) as { id: string }[];
    expect(listed.map((a) => a.id)).toEqual([w.sheet.id]);
  });
});
