import { randomUUID } from "node:crypto";
import { test, expect } from "../../fixtures";
import {
  contents, createArtefact, createBoard, createEdge, createLink, createNode, createWorkspace, inviteRaw, listBoards, listFiles,
  listWorkspaces, nodeById, shareBoard, uploadFile,
} from "../../support/api";
import { deleteWithEmail } from "../../support/account";
import { closeWorkspace, moveBoard } from "../../support/lifecycle";
import { connectMcp } from "../../support/mcp";
import { makeOrg } from "../../support/org";
import { query } from "../../support/versions";

// Moving a mindmap between workspaces. Needs write access to the mindmap and to
// the target workspace. The mindmap keeps its id, cards, edges, artefacts,
// files, shares, grants, links and history; what changes is which workspace it
// belongs to, so who reaches it through the workspace changes with it.

const word = () => `zq${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const home = async (request: any) => (await listWorkspaces(request)).find((w) => w.personal)!;
const wsOf = async (id: string) => (await query<any>(`SELECT workspace_id FROM boards WHERE id = ?`, [id]))[0]?.workspace_id;

/** A mindmap with a card, an edge, a sheet, a file, a link, a sub-mindmap and a direct share. */
async function furnished(request: any, makePerson: any, workspace_id: string) {
  const term = word();
  const board = await createBoard(request, `Map ${term}`, { workspace_id });
  const a = await createNode(request, board.id, { title: `Alpha ${term}` });
  const b = await createNode(request, board.id, { title: `Beta ${term}` });
  const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "relates" });
  const sheet = await createArtefact(request, board.id, "sheet", { title: "Budget", sheets: [{ name: "S", rows: [[`cell ${term}`]] }] });
  const fileNode = await createArtefact(request, board.id, "file", { title: "Report" });
  const up = await uploadFile(request, fileNode.id, { name: "notes.txt", type: "text/plain", data: `hello ${term}` });
  expect(up.status()).toBe(201);
  const link = await createLink(request, sheet.id);
  const sub = await createBoard(request, `Sub ${term}`, { parent_id: board.id, node_id: a.id, workspace_id });
  const guest = await makePerson("guest");
  await shareBoard(request, board.id, guest.user.email, "viewer");
  return { term, board, a, b, edge, sheet, fileNode, link, sub, guest };
}

test.describe("personal home to an organisation and back", () => {
  test("an editor moves their own mindmap into the organisation; the team gets it whole", async ({ account, request, makePerson, playwright, baseURL }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const mine = await home(org.editor.request);
    const s = await furnished(org.editor.request, makePerson, mine.id);
    expect((await org.viewer.request.get(`/api/boards/${s.board.id}/contents`)).status()).toBe(404);

    const res = await moveBoard(org.editor.request, s.board.id, org.ws.id);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: s.board.id, workspace_id: org.ws.id });
    expect(await wsOf(s.board.id)).toBe(org.ws.id);

    // everyone in the organisation reads what was moved
    for (const who of [request, org.admin.request, org.viewer.request]) {
      const c = await contents(who, s.board.id);
      expect(c.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([s.a.id, s.b.id, s.sheet.id, s.fileNode.id]));
      expect(c.edges.map((e) => e.id)).toEqual([s.edge.id]);
      expect((await listBoards(who)).find((x) => x.id === s.board.id)?.workspace_id).toBe(org.ws.id);
    }
    // artefact content and files travelled with it
    expect((await org.viewer.request.get(`/api/artefacts/${s.sheet.id}`)).status()).toBe(200);
    expect((await listFiles(org.viewer.request, s.fileNode.id)).map((f) => f.name)).toEqual(["notes.txt"]);
    expect((await uploadFile(org.editor.request, (await createArtefact(org.editor.request, s.board.id, "file", { title: "More" })).id, { name: "b.txt", type: "text/plain", data: "b" })).status()).toBe(201);
    // the sub-mindmap came too
    expect(await wsOf(s.sub.id)).toBe(org.ws.id);
    expect((await contents(org.viewer.request, s.sub.id)).board.id).toBe(s.sub.id);

    // shares and links are as they were
    expect((await contents(s.guest.request, s.board.id)).board.id).toBe(s.board.id);
    const anon = await playwright.request.newContext({ baseURL });
    expect((await anon.get(`/api/shared/${s.link.token}`)).status()).toBe(200);
    await anon.dispose();
    expect((await query<any>(`SELECT COUNT(*) AS n FROM board_shares WHERE board_id = ?`, [s.board.id]))[0].n).toBe(1);
    expect((await query<any>(`SELECT COUNT(*) AS n FROM shares WHERE target_id = ? AND revoked = 0`, [s.sheet.id]))[0].n).toBe(1);
  });

  test("and back: the team loses it, the mover keeps it, and so does a direct share", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const s = await furnished(request, makePerson, org.ws.id);
    expect((await contents(org.viewer.request, s.board.id)).board.id).toBe(s.board.id);

    const mine = await home(request);
    expect((await moveBoard(request, s.board.id, mine.id)).status()).toBe(200);
    expect(await wsOf(s.board.id)).toBe(mine.id);
    expect(await wsOf(s.sub.id)).toBe(mine.id);
    for (const who of [org.admin.request, org.editor.request, org.viewer.request]) {
      expect((await who.get(`/api/boards/${s.board.id}/contents`)).status()).toBe(404);
      expect((await who.get(`/api/nodes/${s.a.id}`)).status()).toBe(404);
      expect((await listBoards(who)).map((b) => b.id)).not.toContain(s.board.id);
    }
    expect((await contents(request, s.board.id)).nodes.length).toBeGreaterThan(2);
    expect((await contents(s.guest.request, s.board.id)).board.id).toBe(s.board.id);
  });

  test("version history follows the mindmap into the new workspace", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const mine = await home(request);
    const s = await furnished(request, makePerson, mine.id);
    const inWs = async (ws: string) =>
      (await query<any>(`SELECT COUNT(*) AS n FROM versions WHERE board_id IN (?, ?) AND workspace_id = ?`, [s.board.id, s.sub.id, ws]))[0].n;
    const total = await inWs(mine.id);
    expect(total).toBeGreaterThan(0);
    await moveBoard(request, s.board.id, org.ws.id);
    expect(await inWs(mine.id)).toBe(0);
    expect(await inWs(org.ws.id)).toBe(total);
    // an edit afterwards is filed under the new workspace as well
    await createNode(request, s.board.id, { title: "after the move" });
    expect((await query<any>(`SELECT COUNT(*) AS n FROM versions WHERE board_id = ? AND workspace_id <> ?`, [s.board.id, org.ws.id]))[0].n).toBe(0);
  });

  test("the cards are searchable in the new workspace and no longer in the old", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const mine = await home(request);
    const s = await furnished(request, makePerson, mine.id);
    const inOrg = await connectMcp(request, { workspace: org.ws.id });
    const inHome = await connectMcp(request, { workspace: mine.id });
    // the query is echoed back when nothing matches, so look for the card and the map, not the word
    const seen = async (mcp: any) => {
      const text = (await mcp.call("search", { query: s.term })).text + (await mcp.call("list_mindmaps", {})).text;
      return text.includes(`Alpha ${s.term}`) || text.includes(`Map ${s.term}`);
    };
    expect(await seen(inHome)).toBe(true);
    expect(await seen(inOrg)).toBe(false);
    await moveBoard(request, s.board.id, org.ws.id);
    expect(await seen(inOrg)).toBe(true);
    expect(await seen(inHome)).toBe(false);
    // a team member's agent finds it too
    const theirs = await connectMcp(org.viewer.request, { workspace: org.ws.id });
    expect(await seen(theirs)).toBe(true);
  });

  test("an agent's recall scope is the destination's: reads see it there, writes land there", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const mine = await home(request);
    const s = await furnished(request, makePerson, mine.id);
    await moveBoard(request, s.board.id, org.ws.id);
    const mcp = await connectMcp(org.editor.request, { workspace: org.ws.id });
    const r = await mcp.call("add_card", { mindmap_id: s.board.id, title: `Agent ${s.term}` });
    expect(r.isError, r.text).toBe(false);
    expect((await query<any>(`SELECT COUNT(*) AS n FROM versions WHERE workspace_id = ? AND title LIKE 'Agent%'`, [org.ws.id]))[0].n).toBe(1);
  });

  test("the mover's account deletion does not take the moved mindmap with it", async ({ playwright, baseURL, request, account, makePerson }) => {
    void account;
    void playwright;
    void baseURL;
    const org = await makeOrg(request, makePerson);
    const mine = await home(org.editor.request);
    const s = await furnished(org.editor.request, makePerson, mine.id);
    await moveBoard(org.editor.request, s.board.id, org.ws.id);
    await deleteWithEmail(org.editor.request, org.editor.user);
    expect((await contents(request, s.board.id)).nodes.map((n) => n.id)).toContain(s.a.id);
  });
});

test.describe("who may move", () => {
  test("a viewer of the target workspace cannot move something in", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const mine = await home(org.viewer.request);
    const board = await createBoard(org.viewer.request, "Mine", { workspace_id: mine.id });
    const res = await moveBoard(org.viewer.request, board.id, org.ws.id);
    expect(res.status()).toBe(403);
    expect(await wsOf(board.id)).toBe(mine.id);
  });

  test("a viewer of the mindmap cannot move it out, even to somewhere they can write", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const board = await createBoard(request, "Team's", { workspace_id: org.ws.id });
    const mine = await home(org.viewer.request);
    expect((await moveBoard(org.viewer.request, board.id, mine.id)).status()).toBe(403);
    expect(await wsOf(board.id)).toBe(org.ws.id);
  });

  test("someone with only a viewer share on the mindmap cannot move it", async ({ account, request, makePerson }) => {
    void account;
    const board = await createBoard(request, "Shared out");
    const guest = await makePerson("guest");
    await shareBoard(request, board.id, guest.user.email, "viewer");
    const theirs = await home(guest.request);
    expect((await moveBoard(guest.request, board.id, theirs.id)).status()).toBe(403);
  });

  test("not even an editor share: a mindmap handed to you stays in its workspace, so a guest cannot take it from its owner", async ({ account, request, makePerson }) => {
    void account;
    const board = await createBoard(request, "Shared out");
    const guest = await makePerson("guest");
    await shareBoard(request, board.id, guest.user.email, "editor");
    const theirs = await home(guest.request);
    expect((await moveBoard(guest.request, board.id, theirs.id)).status()).toBe(403);
    expect(await wsOf(board.id)).toBe((await home(request)).id);
    expect((await contents(request, board.id)).board.id).toBe(board.id);
  });

  test("a workspace you are not in is answered like one that does not exist", async ({ account, request, makePerson }) => {
    void account;
    const board = await createBoard(request, "Staying put");
    const other = await makePerson("other");
    const theirs = await createWorkspace(other.request, "Theirs");
    const real = await moveBoard(request, board.id, theirs.id);
    const missing = await moveBoard(request, board.id, randomUUID());
    expect(real.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(await real.text()).toBe(await missing.text());
    expect(await wsOf(board.id)).toBe((await home(request)).id);
  });

  test("a mindmap you cannot reach is not-found, the same as one that does not exist", async ({ account, request, makePerson }) => {
    void account;
    const other = await makePerson("other");
    const theirs = await createBoard(other.request, "Not yours");
    const mine = await home(request);
    const a = await moveBoard(request, theirs.id, mine.id);
    const b = await moveBoard(request, randomUUID(), mine.id);
    expect(a.status()).toBe(404);
    expect(await a.text()).toBe(await b.text());
    expect(await wsOf(theirs.id)).toBe((await home(other.request)).id);
  });

  test("signed out is refused", async ({ account, request, playwright, baseURL }) => {
    void account;
    const board = await createBoard(request, "x");
    const anon = await playwright.request.newContext({ baseURL });
    expect((await moveBoard(anon, board.id, (await home(request)).id)).status()).toBe(401);
    await anon.dispose();
  });
});

test.describe("what cannot be moved", () => {
  test("a sub-mindmap moves with its parent, never alone", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const mine = await home(request);
    const s = await furnished(request, makePerson, mine.id);
    const res = await moveBoard(request, s.sub.id, org.ws.id);
    expect(res.status()).toBe(400);
    expect(await wsOf(s.sub.id)).toBe(mine.id);
  });

  test("moving to where it already is, or naming nothing valid, is a bad request and changes nothing", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Here");
    const mine = await home(request);
    expect((await moveBoard(request, board.id, mine.id)).status()).toBe(400);
    for (const bad of [undefined, null, "", 7, {}]) {
      const res = await request.post(`/api/boards/${board.id}/move`, { data: { workspace_id: bad } });
      expect(res.status(), JSON.stringify(bad)).toBe(400);
    }
    expect(await wsOf(board.id)).toBe(mine.id);
  });

  test("a closed workspace is neither a source nor a destination", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const mine = await home(request);
    const board = await createBoard(request, "Going in", { workspace_id: mine.id });
    const inside = await createBoard(request, "Inside", { workspace_id: org.ws.id });
    await closeWorkspace(request, org.ws.id);
    expect((await moveBoard(request, board.id, org.ws.id)).status()).toBe(404);
    expect((await moveBoard(request, inside.id, mine.id)).status()).toBe(404);
    expect(await wsOf(board.id)).toBe(mine.id);
    expect(await wsOf(inside.id)).toBe(org.ws.id);
  });
});

test.describe("moving between two organisations", () => {
  test("works with write access to both, and the first organisation loses it", async ({ account, request, makePerson }) => {
    void account;
    const one = await makeOrg(request, makePerson, "One");
    const two = await createWorkspace(request, "Two");
    await inviteRaw(request, "workspaces", two.id, one.viewer.user.email, "viewer");
    const board = await createBoard(request, "Traveller", { workspace_id: one.ws.id });
    expect((await moveBoard(request, board.id, two.id)).status()).toBe(200);
    expect((await one.editor.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
    expect(await nodeById(request, (await createNode(request, board.id, { title: "x" })).id)).toBeTruthy();
  });
});
