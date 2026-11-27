import { randomUUID } from "node:crypto";
import { test, expect } from "../../fixtures";
import {
  addMember, contents, createArtefact, createBoard, createLink, createNode, createWorkspace, listBoards, listWorkspaces,
  nodeById, shareBoard,
} from "../../support/api";
import { deleteWithEmail } from "../../support/account";
import { closeWorkspace, closedWorkspaces, renameWorkspace, reopenWorkspace } from "../../support/lifecycle";
import { connectMcp } from "../../support/mcp";
import { makeOrg, transferOwnership } from "../../support/org";
import { query } from "../../support/versions";

// Closing a shared workspace is a soft delete. The owner closes it; it vanishes
// for everyone (lists, mindmaps, search, the MCP surface), nothing is deleted,
// and the owner can reopen it for 30 days. Personal homes are never closed.

const DAY = 24 * 60 * 60 * 1000;
const word = () => `zq${randomUUID().replace(/-/g, "").slice(0, 10)}`;

const ids = async (request: any) => (await listWorkspaces(request)).map((w) => w.id);

/** An org with a mindmap, a card, an artefact and a public link, plus someone holding a share on the mindmap. */
async function seeded(request: any, makePerson: any) {
  const org = await makeOrg(request, makePerson, `Closing ${word()}`);
  const term = word();
  const board = await createBoard(request, `Plans ${term}`, { workspace_id: org.ws.id });
  const card = await createNode(request, board.id, { title: `Card ${term}` });
  const sheet = await createArtefact(request, board.id, "sheet", { title: "Budget", sheets: [{ name: "S", rows: [["a"]] }] });
  const link = await createLink(request, sheet.id);
  const guest = await makePerson("guest");
  await shareBoard(request, board.id, guest.user.email, "editor");
  return { org, term, board, card, sheet, link, guest };
}

test.describe("who may close and reopen", () => {
  test("the owner closes; the answer says when it can be reopened until", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const before = Date.now();
    const res = await closeWorkspace(request, org.ws.id);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.closed_at).toBeGreaterThanOrEqual(before - 1000);
    expect(body.reopen_until - body.closed_at).toBe(30 * DAY);
  });

  test("an admin, an editor and a viewer are refused; an outsider is told it does not exist", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    for (const who of [org.admin, org.editor, org.viewer]) {
      expect((await closeWorkspace(who.request, org.ws.id)).status()).toBe(403);
    }
    const stranger = await makePerson("stranger");
    const real = await closeWorkspace(stranger.request, org.ws.id);
    const missing = await closeWorkspace(stranger.request, randomUUID());
    expect(real.status()).toBe(404);
    expect(await real.text()).toBe(await missing.text());
    // nobody changed anything
    expect(await ids(request)).toContain(org.ws.id);
    expect((await query<any>(`SELECT status FROM workspaces WHERE id = ?`, [org.ws.id]))[0].status).toBe("active");
  });

  test("signed out is refused", async ({ account, request, playwright, baseURL }) => {
    void account;
    const ws = await createWorkspace(request, "x");
    const anon = await playwright.request.newContext({ baseURL });
    expect((await closeWorkspace(anon, ws.id)).status()).toBe(401);
    expect((await reopenWorkspace(anon, ws.id)).status()).toBe(401);
    await anon.dispose();
  });

  test("only the owner reopens: members and outsiders cannot even see it is there", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    await closeWorkspace(request, org.ws.id);
    const stranger = await makePerson("stranger");
    for (const who of [org.admin, org.editor, org.viewer, stranger]) {
      expect((await reopenWorkspace(who.request, org.ws.id)).status()).toBe(404);
    }
    expect(await ids(request)).not.toContain(org.ws.id);
    expect((await reopenWorkspace(request, org.ws.id)).status()).toBe(200);
    expect(await ids(request)).toContain(org.ws.id);
  });

  test("the previous owner, after a transfer, cannot close; the new owner can", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await transferOwnership(request, org.ws.id, org.editor.id)).status()).toBe(200);
    expect((await closeWorkspace(request, org.ws.id)).status()).toBe(403);
    expect((await closeWorkspace(org.editor.request, org.ws.id)).status()).toBe(200);
  });

  test("closing twice and reopening an open one are conflicts, not silent successes", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await reopenWorkspace(request, org.ws.id)).status()).toBe(409);
    expect((await closeWorkspace(request, org.ws.id)).status()).toBe(200);
    expect((await closeWorkspace(request, org.ws.id)).status()).toBe(409);
    expect((await reopenWorkspace(request, org.ws.id)).status()).toBe(200);
    expect((await reopenWorkspace(request, org.ws.id)).status()).toBe(409);
  });
});

test.describe("personal homes are not organisations", () => {
  test("a personal workspace cannot be closed or reopened", async ({ account, request }) => {
    void account;
    const home = (await listWorkspaces(request)).find((w) => w.personal)!;
    expect((await closeWorkspace(request, home.id)).status()).toBe(400);
    expect((await reopenWorkspace(request, home.id)).status()).toBe(400);
    expect((await listWorkspaces(request)).some((w) => w.id === home.id)).toBe(true);
    expect((await query<any>(`SELECT status, closed_at FROM workspaces WHERE id = ?`, [home.id]))[0]).toMatchObject({ status: "active", closed_at: null });
  });

  test("closing a shared workspace leaves the owner's personal home and other workspaces alone", async ({ account, request, makePerson }) => {
    void account;
    const home = (await listWorkspaces(request)).find((w) => w.personal)!;
    const mine = await createBoard(request, `Home ${word()}`, { workspace_id: home.id });
    const other = await createWorkspace(request, "Other");
    const otherBoard = await createBoard(request, "In other", { workspace_id: other.id });
    const org = await makeOrg(request, makePerson);
    await closeWorkspace(request, org.ws.id);
    const boards = (await listBoards(request)).map((b) => b.id);
    expect(boards).toContain(mine.id);
    expect(boards).toContain(otherBoard.id);
    expect(await ids(request)).toEqual(expect.arrayContaining([home.id, other.id]));
  });
});

test.describe("what a closed workspace looks like", () => {
  test("it leaves every member's list, and its mindmaps leave the mindmap list", async ({ account, request, makePerson }) => {
    void account;
    const s = await seeded(request, makePerson);
    for (const who of [request, s.org.admin.request, s.org.editor.request, s.org.viewer.request]) {
      expect(await ids(who)).toContain(s.org.ws.id);
      expect((await listBoards(who)).map((b) => b.id)).toContain(s.board.id);
    }
    await closeWorkspace(request, s.org.ws.id);
    for (const who of [request, s.org.admin.request, s.org.editor.request, s.org.viewer.request]) {
      expect(await ids(who)).not.toContain(s.org.ws.id);
      expect((await listBoards(who)).map((b) => b.id)).not.toContain(s.board.id);
    }
  });

  test("its mindmaps and cards are unreachable by anyone, the owner included, and so for a direct share on one", async ({ account, request, makePerson }) => {
    void account;
    const s = await seeded(request, makePerson);
    await closeWorkspace(request, s.org.ws.id);
    for (const who of [request, s.org.admin.request, s.org.editor.request, s.org.viewer.request, s.guest.request]) {
      expect((await who.get(`/api/boards/${s.board.id}/contents`)).status()).toBe(404);
      expect((await who.get(`/api/nodes/${s.card.id}`)).status()).toBe(404);
      expect((await who.get(`/api/nodes/${s.sheet.id}`)).status()).toBe(404);
    }
    expect((await listBoards(s.guest.request)).map((b) => b.id)).not.toContain(s.board.id);
  });

  test("an artefact granted on its own stops being readable, listed or recalled, and comes back on reopen", async ({ account, request, makePerson }) => {
    void account;
    const s = await seeded(request, makePerson);
    const grantee = await makePerson("grantee");
    const note = `Grant ${s.term}`;
    const doc = await createArtefact(request, s.board.id, "doc", { title: note, blocks: ["body"] });
    expect((await addMember(request, "artefacts", doc.id, grantee.user.email, "viewer")).added).toBeTruthy();
    const mcp = await connectMcp(grantee.request);
    const listed = async () =>
      (await (await grantee.request.get("/api/artefacts")).text()).includes(doc.id) ||
      (await mcp.call("list_mindmaps", {})).text.includes(note) ||
      (await mcp.call("search", { query: s.term })).text.includes(note);
    expect((await grantee.request.get(`/api/artefacts/${doc.id}`)).status()).toBe(200);
    expect(await listed()).toBe(true);

    await closeWorkspace(request, s.org.ws.id);
    expect((await grantee.request.get(`/api/artefacts/${doc.id}`)).status()).toBe(404);
    expect((await grantee.request.get(`/api/nodes/${doc.id}`)).status()).toBe(404);
    expect(await listed()).toBe(false);

    await reopenWorkspace(request, s.org.ws.id);
    expect((await grantee.request.get(`/api/artefacts/${doc.id}`)).status()).toBe(200);
    expect(await listed()).toBe(true);
  });

  test("nothing can be written into it: cards, mindmaps, renames, people, ownership", async ({ account, request, makePerson }) => {
    void account;
    const s = await seeded(request, makePerson);
    await closeWorkspace(request, s.org.ws.id);
    for (const who of [request, s.org.admin.request, s.org.editor.request, s.guest.request]) {
      const card = await who.post("/api/nodes", { data: { board_id: s.board.id, type: "card", title: "late", x: 0, y: 0 } });
      expect([403, 404]).toContain(card.status());
      expect([403, 404]).toContain((await who.patch(`/api/nodes/${s.card.id}`, { data: { title: "edited" } })).status());
      expect([403, 404]).toContain((await who.patch(`/api/boards/${s.board.id}`, { data: { name: "edited" } })).status());
    }
    for (const who of [request, s.org.admin.request, s.org.editor.request]) {
      const made = await who.post("/api/boards", { data: { name: "into closed", workspace_id: s.org.ws.id } });
      expect(made.status()).toBe(403);
    }
    expect([403, 404]).toContain((await renameWorkspace(request, s.org.ws.id, "New name")).status());
    expect([403, 404]).toContain((await request.get(`/api/workspaces/${s.org.ws.id}/members`)).status());
    expect([403, 404]).toContain((await request.post(`/api/workspaces/${s.org.ws.id}/members`, { data: { email: "x@example.test" } })).status());
    expect([403, 404]).toContain((await transferOwnership(request, s.org.ws.id, s.org.editor.id)).status());
    // and the data is untouched
    expect((await query<any>(`SELECT name FROM workspaces WHERE id = ?`, [s.org.ws.id]))[0].name).toMatch(/^Closing /);
    expect((await query<any>(`SELECT title FROM nodes WHERE id = ?`, [s.card.id]))[0].title).toBe(`Card ${s.term}`);
    expect((await query<any>(`SELECT name FROM boards WHERE id = ?`, [s.board.id]))[0].name).toBe(`Plans ${s.term}`);
  });

  test("a public link to an artefact stops resolving, and works again after reopening", async ({ account, request, makePerson, playwright, baseURL }) => {
    void account;
    const s = await seeded(request, makePerson);
    const anon = await playwright.request.newContext({ baseURL });
    expect((await anon.get(`/api/shared/${s.link.token}`)).status()).toBe(200);
    await closeWorkspace(request, s.org.ws.id);
    expect((await anon.get(`/api/shared/${s.link.token}`)).status()).toBe(404);
    await reopenWorkspace(request, s.org.ws.id);
    expect((await anon.get(`/api/shared/${s.link.token}`)).status()).toBe(200);
    await anon.dispose();
  });

  test("nothing is deleted: rows stay, with status, closed_at and who closed it", async ({ account, request, makePerson }) => {
    void account;
    const s = await seeded(request, makePerson);
    const before = Date.now();
    await closeWorkspace(request, s.org.ws.id);
    const ws = (await query<any>(`SELECT status, closed_at, closed_by, updated_at, owner_id FROM workspaces WHERE id = ?`, [s.org.ws.id]))[0];
    expect(ws.status).toBe("closed");
    expect(ws.closed_at).toBeGreaterThanOrEqual(before - 1000);
    expect(ws.closed_by).toBe(s.org.ownerId);
    expect(ws.updated_at).toBeGreaterThanOrEqual(ws.closed_at);
    expect((await query<any>(`SELECT COUNT(*) AS n FROM boards WHERE workspace_id = ?`, [s.org.ws.id]))[0].n).toBe(1);
    expect((await query<any>(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?`, [s.org.ws.id]))[0].n).toBe(3);
  });
});

test.describe("the owner's list of closed workspaces", () => {
  test("shows only the owner's, with the date it can be reopened until", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Soon gone");
    expect(await closedWorkspaces(request)).toEqual([]);
    await closeWorkspace(request, org.ws.id);
    const [row, ...rest] = await closedWorkspaces(request);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ id: org.ws.id, name: "Soon gone", reopenable: true });
    expect(row.reopen_until - row.closed_at).toBe(30 * DAY);
    // members do not get it: it is the owner's to bring back
    for (const who of [org.admin, org.editor, org.viewer]) expect(await closedWorkspaces(who.request)).toEqual([]);
  });

  test("a reopened workspace leaves the closed list", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    await closeWorkspace(request, org.ws.id);
    await reopenWorkspace(request, org.ws.id);
    expect(await closedWorkspaces(request)).toEqual([]);
  });
});

test.describe("reopening", () => {
  test("restores everything as it was: people, roles, mindmaps, cards, artefacts, shares and links", async ({ account, request, makePerson, playwright, baseURL }) => {
    void account;
    const s = await seeded(request, makePerson);
    const roles = async () => Object.fromEntries(await Promise.all(
      [s.org.admin, s.org.editor, s.org.viewer].map(async (p) => [p.id, (await listWorkspaces(p.request)).find((w) => w.id === s.org.ws.id)?.role]),
    ));
    const before = await roles();
    await closeWorkspace(request, s.org.ws.id);
    expect((await reopenWorkspace(request, s.org.ws.id)).status()).toBe(200);
    expect(await roles()).toEqual(before);
    expect(before).toEqual({ [s.org.admin.id]: "admin", [s.org.editor.id]: "editor", [s.org.viewer.id]: "viewer" });
    const c = await contents(s.org.viewer.request, s.board.id);
    expect(c.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([s.card.id, s.sheet.id]));
    expect((await nodeById(s.guest.request, s.card.id)).title).toBe(`Card ${s.term}`);
    const anon = await playwright.request.newContext({ baseURL });
    expect((await anon.get(`/api/shared/${s.link.token}`)).status()).toBe(200);
    await anon.dispose();
    // and it is writable again
    expect((await createNode(s.org.editor.request, s.board.id, { title: "after" })).id).toBeTruthy();
    const ws = (await query<any>(`SELECT status, closed_at, closed_by FROM workspaces WHERE id = ?`, [s.org.ws.id]))[0];
    expect(ws).toMatchObject({ status: "active", closed_at: null, closed_by: null });
  });
});

test.describe("the owner-delete guard", () => {
  test("a workspace with people in it blocks account deletion until it is closed", async ({ account, request, makePerson }) => {
    const org = await makeOrg(request, makePerson, "Blocks");
    const blocked = await request.delete("/api/account", { data: { email: account.email } });
    expect(blocked.status()).toBe(409);
    expect((await (await request.get("/api/account/delete-blockers")).json()).workspaces.map((w: any) => w.id)).toEqual([org.ws.id]);

    await closeWorkspace(request, org.ws.id);
    expect((await (await request.get("/api/account/delete-blockers")).json()).workspaces).toEqual([]);
    await deleteWithEmail(request, account);
  });

  test("reopening puts the block back", async ({ account, request, makePerson }) => {
    const org = await makeOrg(request, makePerson, "Blocks again");
    await closeWorkspace(request, org.ws.id);
    await reopenWorkspace(request, org.ws.id);
    expect((await request.delete("/api/account", { data: { email: account.email } })).status()).toBe(409);
  });
});

test.describe("the agent surface (MCP)", () => {
  const text = async (mcp: any, tool: string, args: Record<string, unknown>) => {
    const r = await mcp.call(tool, args);
    return r;
  };

  test("a connection scoped to the workspace is refused once it is closed, and works again when it reopens", async ({ account, request, makePerson }) => {
    void account;
    const s = await seeded(request, makePerson);
    const mcp = await connectMcp(s.org.editor.request, { workspace: s.org.ws.id });
    expect((await text(mcp, "list_mindmaps", {})).text).toContain(s.board.name);
    await closeWorkspace(request, s.org.ws.id);
    const list = await text(mcp, "list_mindmaps", {});
    expect(list.isError).toBe(true);
    expect(list.text).not.toContain(s.board.name);
    const write = await text(mcp, "add_card", { mindmap_id: s.board.id, title: `Late ${s.term}` });
    expect(write.isError).toBe(true);
    expect((await query<any>(`SELECT COUNT(*) AS n FROM nodes WHERE board_id = ? AND title LIKE 'Late%'`, [s.board.id]))[0].n).toBe(0);
    await reopenWorkspace(request, s.org.ws.id);
    expect((await text(mcp, "list_mindmaps", {})).text).toContain(s.board.name);
    expect((await text(mcp, "add_card", { mindmap_id: s.board.id, title: `Back ${s.term}` })).isError).toBe(false);
  });

  test("an unscoped connection no longer lists, recalls or searches it, and cannot write into it by id", async ({ account, request, makePerson }) => {
    void account;
    const s = await seeded(request, makePerson);
    // a connection made for Personal reaches every workspace the person belongs to when asked
    const mcp = await connectMcp(s.org.editor.request);
    expect((await text(mcp, "list_mindmaps", {})).text).not.toContain(s.board.name);
    const found = async () =>
      (await text(mcp, "search", { query: s.term, workspace: s.org.ws.name })).text + (await text(mcp, "recall", { query: s.term, workspace: s.org.ws.name })).text;
    expect(await found()).toContain(s.term);
    await closeWorkspace(request, s.org.ws.id);
    for (const args of [{}, { workspace: s.org.ws.name }, { workspace: s.org.ws.id }]) {
      for (const tool of ["list_mindmaps", "search", "recall"]) {
        const r = await text(mcp, tool, { query: s.term, ...args });
        expect(r.text, `${tool} ${JSON.stringify(args)}`).not.toContain(s.board.name);
        expect(r.text, `${tool} ${JSON.stringify(args)}`).not.toContain(`Card ${s.term}`);
      }
    }
    for (const [tool, args] of [
      ["add_card", { mindmap_id: s.board.id, title: "x" }],
      ["get_mindmap", { id: s.board.id }],
    ] as const) {
      const r = await text(mcp, tool, args as any);
      expect(r.isError, tool).toBe(true);
    }
    // the owner's own connection too
    const own = await connectMcp(request);
    expect((await text(own, "list_mindmaps", {})).text).not.toContain(s.board.name);
    expect((await text(own, "add_card", { mindmap_id: s.board.id, title: "x" })).isError).toBe(true);
  });

  test("a mindmap shared directly from a closed workspace is no longer shared with the guest", async ({ account, request, makePerson }) => {
    void account;
    const s = await seeded(request, makePerson);
    const mcp = await connectMcp(s.guest.request);
    expect((await text(mcp, "list_mindmaps", {})).text).toContain(s.board.name);
    await closeWorkspace(request, s.org.ws.id);
    expect((await text(mcp, "list_mindmaps", {})).text).not.toContain(s.board.name);
    expect((await text(mcp, "get_mindmap", { id: s.board.id })).isError).toBe(true);
  });
});
