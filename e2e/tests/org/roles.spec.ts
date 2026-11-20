import { test, expect } from "../../fixtures";
import {
  addMember, createBoard, createNode, createWorkspace, listWorkspaces, membersOf, contents,
} from "../../support/api";
import { deleteAccount, deleteWithEmail, meId } from "../../support/account";
import { makeOrg, removeMemberRaw, setRole, transferOwnership } from "../../support/org";
import { query } from "../../support/versions";
import { connectMcp } from "../../support/mcp";

// Roles on a shared (non-personal) workspace: owner, admin, editor, viewer.
//
// Decisions under test (documented in worker/src/members.ts):
//  - an admin manages editors and viewers (invite, change role, remove) and the
//    mindmaps in the workspace, exactly as an owner would;
//  - only the owner promotes or demotes admins, removes an admin, or transfers
//    ownership. An admin cannot mint peers, and cannot touch the owner at all;
//  - the owner can never be removed, demoted or leave: there is always exactly
//    one, until ownership is transferred.

const roleIn = async (request: any, ws: string) =>
  Object.fromEntries((await listWorkspaces(request)).filter((w) => w.id === ws).map((w) => [w.id, w.role]))[ws];

test.describe("admin", () => {
  test("is listed as admin, can read and write, and sees the workspace as admin", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect(await roleIn(org.admin.request, org.ws.id)).toBe("admin");
    expect(await roleIn(org.editor.request, org.ws.id)).toBe("editor");

    const board = await createBoard(request, "Team board", { workspace_id: org.ws.id });
    const node = await createNode(org.admin.request, board.id, { title: "from admin" });
    expect(node.id).toBeTruthy();

    const members = await membersOf(request, "workspaces", org.ws.id);
    expect(members.members.find((m) => m.user_id === org.admin.id)?.role).toBe("admin");
    expect(members.members.find((m) => m.user_id === org.editor.id)?.role).toBe("editor");
    expect(members.owner?.user_id).toBe(org.ownerId);
  });

  test("can see the member list; editors and viewers still cannot", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await org.admin.request.get(`/api/workspaces/${org.ws.id}/members`)).status()).toBe(200);
    expect((await org.editor.request.get(`/api/workspaces/${org.ws.id}/members`)).status()).toBe(404);
    expect((await org.viewer.request.get(`/api/workspaces/${org.ws.id}/members`)).status()).toBe(404);
  });

  test("can invite editors and viewers, by existing account and by pending invite", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const fresh = await makePerson("fresh");
    expect((await addMember(org.admin.request, "workspaces", org.ws.id, fresh.user.email, "viewer")).added?.role).toBe("viewer");
    const pending = await addMember(org.admin.request, "workspaces", org.ws.id, "nobody-yet@example.test", "editor");
    expect(pending.invited?.role).toBe("editor");
  });

  test("can change an editor to a viewer and back, and remove an editor", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await setRole(org.admin.request, org.ws.id, org.editor.id, "viewer")).status()).toBe(200);
    expect(await roleIn(org.editor.request, org.ws.id)).toBe("viewer");
    expect((await setRole(org.admin.request, org.ws.id, org.editor.id, "editor")).status()).toBe(200);
    expect(await roleIn(org.editor.request, org.ws.id)).toBe("editor");
    expect((await removeMemberRaw(org.admin.request, org.ws.id, org.viewer.id)).status()).toBe(200);
    expect((await listWorkspaces(org.viewer.request)).some((w) => w.id === org.ws.id)).toBe(false);
  });

  test("can rename and delete mindmaps in the workspace, as an owner can", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const board = await createBoard(request, "Rename me", { workspace_id: org.ws.id });
    expect((await org.admin.request.patch(`/api/boards/${board.id}`, { data: { name: "Renamed" } })).status()).toBe(200);
    expect((await org.admin.request.delete(`/api/boards/${board.id}`)).status()).toBe(200);
    // an editor still cannot
    const other = await createBoard(request, "Editors cannot", { workspace_id: org.ws.id });
    expect((await org.editor.request.patch(`/api/boards/${other.id}`, { data: { name: "x" } })).status()).toBe(403);
    expect((await org.editor.request.delete(`/api/boards/${other.id}`)).status()).toBe(403);
  });

  test("can create a mindmap in the workspace over MCP (it counts as write access)", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const mcp = await connectMcp(org.admin.request);
    const make = (m: typeof mcp) =>
      m.call("create_mindmap", { name: "By admin over MCP", workspace: org.ws.id, nodes: [{ title: "one" }] });
    // create_mindmap insists on a recall first; its answer does not matter here
    await mcp.call("recall", { query: "nothing", workspace: org.ws.id });
    const res = await make(mcp);
    expect(res.isError, JSON.stringify(res)).toBe(false);

    const viewer = await connectMcp(org.viewer.request);
    await viewer.call("recall", { query: "nothing", workspace: org.ws.id });
    const denied = await make(viewer);
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/view-only/);
  });

  test("cannot promote anyone to admin, demote an admin, or remove one", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const second = await makePerson("second-admin");
    const secondId = await meId(second.request);
    await addMember(request, "workspaces", org.ws.id, second.user.email, "editor");
    expect((await setRole(request, org.ws.id, secondId, "admin")).status()).toBe(200);

    // promote
    expect((await setRole(org.admin.request, org.ws.id, org.editor.id, "admin")).status()).toBe(403);
    expect(await roleIn(org.editor.request, org.ws.id)).toBe("editor");
    // demote a peer
    expect((await setRole(org.admin.request, org.ws.id, secondId, "editor")).status()).toBe(403);
    expect(await roleIn(second.request, org.ws.id)).toBe("admin");
    // remove a peer
    expect((await removeMemberRaw(org.admin.request, org.ws.id, secondId)).status()).toBe(403);
    expect(await roleIn(second.request, org.ws.id)).toBe("admin");
    // and cannot sneak a demotion in through the invite route
    expect((await org.admin.request.post(`/api/workspaces/${org.ws.id}/members`, {
      data: { email: second.user.email, role: "viewer" },
    })).status()).toBe(403);
    expect(await roleIn(second.request, org.ws.id)).toBe("admin");
  });

  test("an admin can still leave", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await removeMemberRaw(org.admin.request, org.ws.id, org.admin.id)).status()).toBe(200);
    expect((await listWorkspaces(org.admin.request)).some((w) => w.id === org.ws.id)).toBe(false);
  });

  test("cannot transfer ownership, to themselves or anyone", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    for (const to of [org.admin.id, org.editor.id]) {
      const res = await transferOwnership(org.admin.request, org.ws.id, to);
      expect(res.status()).toBe(403);
    }
    expect(await roleIn(request, org.ws.id)).toBe("owner");
    expect((await query<any>(`SELECT owner_id FROM workspaces WHERE id = ?`, [org.ws.id]))[0].owner_id).toBe(org.ownerId);
  });
});

test.describe("the owner cannot be touched", () => {
  test("an admin cannot remove, demote or re-invite the owner", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await removeMemberRaw(org.admin.request, org.ws.id, org.ownerId)).status()).toBe(403);
    expect((await setRole(org.admin.request, org.ws.id, org.ownerId, "viewer")).status()).toBe(403);
    expect((await setRole(org.admin.request, org.ws.id, org.ownerId, "editor")).status()).toBe(403);
    expect((await org.admin.request.post(`/api/workspaces/${org.ws.id}/members`, {
      data: { email: account.email, role: "viewer" },
    })).status()).toBe(403);
    expect(await roleIn(request, org.ws.id)).toBe("owner");
    // no stray membership row was created for the owner
    expect((await query(`SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, [org.ws.id, org.ownerId])).length).toBe(0);
  });

  test("editors and viewers cannot change roles or remove anyone", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    for (const who of [org.editor, org.viewer]) {
      expect((await setRole(who.request, org.ws.id, org.admin.id, "viewer")).status()).toBe(403);
      expect((await setRole(who.request, org.ws.id, org.viewer.id, "editor")).status()).toBe(403);
      expect((await removeMemberRaw(who.request, org.ws.id, org.admin.id)).status()).toBe(403);
      expect((await transferOwnership(who.request, org.ws.id, who.id)).status()).toBe(403);
    }
    expect(await roleIn(org.admin.request, org.ws.id)).toBe("admin");
  });

  test("outsiders get a 404, revealing nothing", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const stranger = await makePerson("stranger");
    expect((await setRole(stranger.request, org.ws.id, org.editor.id, "viewer")).status()).toBe(404);
    expect((await transferOwnership(stranger.request, org.ws.id, org.editor.id)).status()).toBe(404);
  });
});

test.describe("last-owner guards", () => {
  test("the owner cannot leave, be removed or be demoted; nothing changes", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const leave = await removeMemberRaw(request, org.ws.id, org.ownerId);
    expect(leave.status()).toBe(409);
    expect((await leave.json()).error).toMatch(/transfer/i);
    for (const role of ["admin", "editor", "viewer"]) {
      expect((await setRole(request, org.ws.id, org.ownerId, role)).status()).toBe(409);
    }
    expect(await roleIn(request, org.ws.id)).toBe("owner");
    expect((await listWorkspaces(request)).find((w) => w.id === org.ws.id)?.owner_id).toBe(org.ownerId);
  });

  test("the owner can change an admin, including promoting and demoting", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await setRole(request, org.ws.id, org.editor.id, "admin")).status()).toBe(200);
    expect(await roleIn(org.editor.request, org.ws.id)).toBe("admin");
    expect((await setRole(request, org.ws.id, org.admin.id, "viewer")).status()).toBe(200);
    expect(await roleIn(org.admin.request, org.ws.id)).toBe("viewer");
    // the demoted admin has lost admin rights
    expect((await setRole(org.admin.request, org.ws.id, org.editor.id, "viewer")).status()).toBe(403);
  });

  test("role changes need an existing, active member", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const stranger = await makePerson("stranger");
    const strangerId = await meId(stranger.request);
    expect((await setRole(request, org.ws.id, strangerId, "editor")).status()).toBe(404);
    expect((await setRole(request, org.ws.id, "no-such-user", "editor")).status()).toBe(404);
    expect((await setRole(request, org.ws.id, org.editor.id, "owner")).status()).toBe(400);
    expect((await setRole(request, org.ws.id, org.editor.id, "superuser")).status()).toBe(400);
    expect((await setRole(request, org.ws.id, org.editor.id, "")).status()).toBe(400);

    // a member whose account was deleted is gone from the workspace
    await deleteWithEmail(org.viewer.request, org.viewer.user);
    expect((await setRole(request, org.ws.id, org.viewer.id, "editor")).status()).toBe(404);
    expect((await transferOwnership(request, org.ws.id, org.viewer.id)).status()).toBe(400);
  });

  test("an invite never creates an admin, and re-inviting an existing member goes through the same rules", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const res = await request.post(`/api/workspaces/${org.ws.id}/members`, { data: { email: "x@example.test", role: "admin" } });
    expect(res.status()).toBe(400);
    // the owner re-inviting an admin as viewer is a role change, allowed
    expect((await addMember(request, "workspaces", org.ws.id, org.admin.user.email, "viewer")).added?.role).toBe("viewer");
    expect(await roleIn(org.admin.request, org.ws.id)).toBe("viewer");
    // the owner inviting themselves stays a harmless no-op
    await addMember(request, "workspaces", org.ws.id, account.email, "viewer");
    expect(await roleIn(request, org.ws.id)).toBe("owner");
    expect((await query(`SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, [org.ws.id, org.ownerId])).length).toBe(0);
  });
});

test.describe("ownership transfer", () => {
  test("moves ownership to a member, the old owner becomes admin, and it is recorded", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const board = await createBoard(request, "Moves with the workspace", { workspace_id: org.ws.id });
    const before = Date.now();
    const res = await transferOwnership(request, org.ws.id, org.editor.id);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, owner_id: org.editor.id });

    expect(await roleIn(org.editor.request, org.ws.id)).toBe("owner");
    expect(await roleIn(request, org.ws.id)).toBe("admin");
    // exactly one owner, and the new owner is not also a member row
    const ws = (await query<any>(`SELECT owner_id FROM workspaces WHERE id = ?`, [org.ws.id]))[0];
    expect(ws.owner_id).toBe(org.editor.id);
    expect((await query(`SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, [org.ws.id, org.editor.id])).length).toBe(0);
    const oldRow = (await query<any>(`SELECT role, admin FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, [org.ws.id, org.ownerId]))[0];
    expect(oldRow).toMatchObject({ admin: 1 });
    // the others are untouched
    expect(await roleIn(org.admin.request, org.ws.id)).toBe("admin");
    expect(await roleIn(org.viewer.request, org.ws.id)).toBe("viewer");
    // content is where it was, readable by everyone, including the old owner
    expect((await request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    expect((await contents(org.editor.request, board.id)).nodes).toBeDefined();

    const audit = await query<any>(`SELECT * FROM workspace_ownership_transfers WHERE workspace_id = ?`, [org.ws.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ from_user_id: org.ownerId, to_user_id: org.editor.id, status: "completed" });
    expect(audit[0].created_at).toBeGreaterThanOrEqual(before);
    expect(audit[0].updated_at).toBeGreaterThanOrEqual(audit[0].created_at);
  });

  test("the new owner holds the owner powers and the old owner has lost them", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await transferOwnership(request, org.ws.id, org.admin.id)).status()).toBe(200);

    // old owner is now an admin: cannot transfer, promote, or remove the new owner
    expect((await transferOwnership(request, org.ws.id, org.editor.id)).status()).toBe(403);
    expect((await setRole(request, org.ws.id, org.editor.id, "admin")).status()).toBe(403);
    expect((await removeMemberRaw(request, org.ws.id, org.admin.id)).status()).toBe(403);
    expect((await setRole(request, org.ws.id, org.admin.id, "viewer")).status()).toBe(403);
    // new owner can: promote, then transfer back
    expect((await setRole(org.admin.request, org.ws.id, org.editor.id, "admin")).status()).toBe(200);
    expect((await transferOwnership(org.admin.request, org.ws.id, org.ownerId)).status()).toBe(200);
    expect(await roleIn(request, org.ws.id)).toBe("owner");
    expect(await roleIn(org.admin.request, org.ws.id)).toBe("admin");
    expect((await query(`SELECT 1 FROM workspace_ownership_transfers WHERE workspace_id = ?`, [org.ws.id])).length).toBe(2);
  });

  test("the old owner may leave afterwards, because they are no longer the last owner", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    await transferOwnership(request, org.ws.id, org.editor.id);
    expect((await removeMemberRaw(request, org.ws.id, org.ownerId)).status()).toBe(200);
    expect((await listWorkspaces(request)).some((w) => w.id === org.ws.id)).toBe(false);
    expect(await roleIn(org.editor.request, org.ws.id)).toBe("owner");
  });

  test("refused, and nothing changes, for a non-member, oneself, a missing target or a deleted account", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const stranger = await makePerson("stranger");
    const strangerId = await meId(stranger.request);
    for (const to of [strangerId, org.ownerId, "no-such-user"]) {
      expect((await transferOwnership(request, org.ws.id, to)).status(), to).toBe(400);
    }
    expect((await request.post(`/api/workspaces/${org.ws.id}/transfer`, { data: {} })).status()).toBe(400);
    expect((await transferOwnership(request, "no-such-workspace", org.editor.id)).status()).toBe(404);
    expect((await query<any>(`SELECT owner_id FROM workspaces WHERE id = ?`, [org.ws.id]))[0].owner_id).toBe(org.ownerId);
    expect((await query(`SELECT 1 FROM workspace_ownership_transfers WHERE workspace_id = ?`, [org.ws.id])).length).toBe(0);
    expect(await roleIn(org.editor.request, org.ws.id)).toBe("editor");
  });

  test("is atomic: racing transfers leave exactly one owner and one audit row", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    // Many at once, to targets that differ, so that several get past the
    // role check before the first one commits; only the batch's own
    // conditions can then keep it to one winner.
    const targets = [org.editor.id, org.admin.id, org.viewer.id, org.editor.id, org.admin.id, org.viewer.id, org.editor.id, org.admin.id];
    const results = await Promise.all(targets.map((to) => transferOwnership(request, org.ws.id, to)));
    const won = results.map((r, i) => [r.status(), targets[i]!] as const).filter(([st]) => st === 200);
    expect(won).toHaveLength(1);
    for (const r of results) expect([200, 403, 409]).toContain(r.status());
    const winner = won[0]![1];
    expect((await query<any>(`SELECT owner_id FROM workspaces WHERE id = ?`, [org.ws.id]))[0].owner_id).toBe(winner);
    const audit = await query<any>(`SELECT to_user_id FROM workspace_ownership_transfers WHERE workspace_id = ?`, [org.ws.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].to_user_id).toBe(winner);
    // the owner is never also a member; the old owner is an admin member
    expect((await query(`SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, [org.ws.id, winner])).length).toBe(0);
    expect((await query<any>(`SELECT admin FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, [org.ws.id, org.ownerId]))[0].admin).toBe(1);
  });
});

test.describe("personal homes are not organisations", () => {
  test("no transfer, no admin role; editor and viewer behave as before; the owner cannot leave", async ({ account, request, makePerson }) => {
    const home = (await listWorkspaces(request)).find((w) => w.personal === 1)!;
    const guest = await makePerson("guest");
    const guestId = await meId(guest.request);
    expect((await addMember(request, "workspaces", home.id, guest.user.email, "viewer")).added?.role).toBe("viewer");

    expect((await transferOwnership(request, home.id, guestId)).status()).toBe(400);
    expect((await setRole(request, home.id, guestId, "admin")).status()).toBe(400);
    expect((await setRole(request, home.id, guestId, "editor")).status()).toBe(200);
    expect((await removeMemberRaw(request, home.id, await meId(request))).status()).toBe(409);
    expect((await listWorkspaces(request)).find((w) => w.id === home.id)?.role).toBe("owner");
    expect((await query<any>(`SELECT owner_id FROM workspaces WHERE id = ?`, [home.id]))[0].owner_id).toBe(await meId(request));
    void account;
  });
});

test.describe("existing editor and viewer access is unchanged", () => {
  test("viewers read only, editors write, neither administers", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const board = await createBoard(request, "Shared", { workspace_id: org.ws.id });
    const node = await createNode(request, board.id, { title: "seed" });

    expect((await org.viewer.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    expect((await org.viewer.request.patch(`/api/nodes/${node.id}`, { data: { title: "viewer edit" } })).status()).toBe(403);
    expect((await org.editor.request.patch(`/api/nodes/${node.id}`, { data: { title: "editor edit" } })).status()).toBe(200);
    for (const who of [org.viewer, org.editor]) {
      expect((await who.request.post(`/api/workspaces/${org.ws.id}/members`, { data: { email: "z@example.test", role: "viewer" } })).status()).toBe(403);
      expect((await who.request.get(`/api/boards/${board.id}/members`)).status()).toBe(404);
    }
    // leaving is still always allowed
    expect((await removeMemberRaw(org.viewer.request, org.ws.id, org.viewer.id)).status()).toBe(200);
  });

  test("the owner's existing powers are unchanged", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await setRole(request, org.ws.id, org.viewer.id, "editor")).status()).toBe(200);
    expect((await removeMemberRaw(request, org.ws.id, org.viewer.id)).status()).toBe(200);
    const board = await createBoard(request, "Owner board", { workspace_id: org.ws.id });
    expect((await request.delete(`/api/boards/${board.id}`)).status()).toBe(200);
  });
});

test.describe("deleting an account that owns a shared workspace", () => {
  test("is refused while other active members are in it, then allowed after a transfer", async ({ account, request, makePerson }) => {
    const org = await makeOrg(request, makePerson, "Crowded org");
    const board = await createBoard(request, "Org content", { workspace_id: org.ws.id });

    const refused = await deleteAccount(request, { email: account.email });
    expect(refused.status()).toBe(409);
    const body = await refused.json();
    expect(body.workspaces).toEqual([{ id: org.ws.id, name: "Crowded org" }]);
    expect(body.error).toContain("Crowded org");
    expect(body.error).toMatch(/transfer ownership/i);
    expect((await request.get("/api/auth/me").then((r) => r.json())).user).not.toBeNull();

    expect((await transferOwnership(request, org.ws.id, org.editor.id)).status()).toBe(200);
    const done = await deleteAccount(request, { email: account.email });
    expect(done.status(), await done.text()).toBe(200);

    // the workspace and its content survive, owned by the new owner; the old owner's
    // membership is gone with the account
    expect((await query<any>(`SELECT owner_id FROM workspaces WHERE id = ?`, [org.ws.id]))[0].owner_id).toBe(org.editor.id);
    expect((await query(`SELECT 1 FROM boards WHERE id = ?`, [board.id])).length).toBe(1);
    expect((await org.editor.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    expect((await org.admin.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    expect((await query(`SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, [org.ws.id, org.ownerId])).length).toBe(0);
    // the audit row outlives the departed owner's membership
    expect((await query(`SELECT 1 FROM workspace_ownership_transfers WHERE workspace_id = ?`, [org.ws.id])).length).toBe(1);
  });

  test("lists every blocking workspace, and ignores ones with nobody else in them", async ({ account, request, makePerson }) => {
    const a = await makeOrg(request, makePerson, "Alpha org");
    const b = await makeOrg(request, makePerson, "Beta org");
    const empty = await createWorkspace(request, "Empty org");
    const res = await deleteAccount(request, { email: account.email });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.workspaces.map((w: any) => w.id).sort()).toEqual([a.ws.id, b.ws.id].sort());
    expect(body.workspaces.some((w: any) => w.id === empty.id)).toBe(false);
  });

  test("a workspace whose only other member has deleted their account does not block", async ({ account, request, makePerson }) => {
    const member = await makePerson("leaver");
    const ws = await createWorkspace(request, "Left alone");
    await addMember(request, "workspaces", ws.id, member.user.email, "editor");
    expect((await deleteAccount(request, { email: account.email })).status()).toBe(409);
    await deleteWithEmail(member.request, member.user);
    expect((await deleteAccount(request, { email: account.email })).status()).toBe(200);
  });

  test("a member being an admin of someone else's organisation never blocks them", async ({ account, request, makePerson }) => {
    const owner = await makePerson("owner");
    const org = await makeOrg(owner.request, makePerson, "Theirs");
    await addMember(owner.request, "workspaces", org.ws.id, account.email, "editor");
    expect((await setRole(owner.request, org.ws.id, await meId(request), "admin")).status()).toBe(200);
    await deleteWithEmail(request, account);
    expect((await listWorkspaces(owner.request)).some((w) => w.id === org.ws.id)).toBe(true);
  });
});
