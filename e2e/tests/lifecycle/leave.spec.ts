import { test, expect } from "../../fixtures";
import { contents, createBoard, createNode, listWorkspaces, inviteRaw } from "../../support/api";
import { acceptInvite, leaveWorkspace } from "../../support/lifecycle";
import { connectMcp } from "../../support/mcp";
import { makeOrg, removeMemberRaw, transferOwnership } from "../../support/org";
import { query } from "../../support/versions";
import { meId } from "../../support/account";

// Any non-owner member can leave a shared workspace; the owner must transfer
// first. Leaving takes away access (the grant row goes, as removal always did)
// and records the exit in workspace_member_events, which is never deleted.

const events = (ws: string, user: string) =>
  query<any>(`SELECT * FROM workspace_member_events WHERE workspace_id = ? AND user_id = ? ORDER BY created_at, rowid`, [ws, user]);

test.describe("who can leave", () => {
  for (const role of ["admin", "editor", "viewer"] as const) {
    test(`${role}s leave, lose access, and nobody else is affected`, async ({ account, request, makePerson }) => {
      void account;
      const org = await makeOrg(request, makePerson);
      const board = await createBoard(request, "Team board", { workspace_id: org.ws.id });
      const who = org[role];
      expect((await contents(who.request, board.id)).board.id).toBe(board.id);

      const res = await leaveWorkspace(who.request, org.ws.id, who.id);
      expect(res.status(), await res.text()).toBe(200);

      expect((await listWorkspaces(who.request)).map((w) => w.id)).not.toContain(org.ws.id);
      expect((await who.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
      const others = [org.admin, org.editor, org.viewer].filter((p) => p !== who);
      for (const p of others) expect((await listWorkspaces(p.request)).map((w) => w.id)).toContain(org.ws.id);
      expect((await listWorkspaces(request)).find((w) => w.id === org.ws.id)?.role).toBe("owner");
    });
  }

  test("the owner cannot leave, and is still the owner afterwards", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const res = await leaveWorkspace(request, org.ws.id, org.ownerId);
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/transfer/i);
    expect((await listWorkspaces(request)).find((w) => w.id === org.ws.id)?.role).toBe("owner");
    expect(await events(org.ws.id, org.ownerId)).toEqual([]);
  });

  test("after transferring, the former owner (now an admin) can leave", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await transferOwnership(request, org.ws.id, org.editor.id)).status()).toBe(200);
    expect((await leaveWorkspace(request, org.ws.id, org.ownerId)).status()).toBe(200);
    expect((await listWorkspaces(request)).map((w) => w.id)).not.toContain(org.ws.id);
  });

  test("a personal home cannot be left", async ({ account, request }) => {
    void account;
    const home = (await listWorkspaces(request)).find((w) => w.personal)!;
    expect((await leaveWorkspace(request, home.id, await meId(request))).status()).toBe(409);
    expect((await listWorkspaces(request)).some((w) => w.id === home.id)).toBe(true);
  });

  test("someone who is not a member gets not-found, and cannot make someone else leave", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const stranger = await makePerson("stranger");
    expect((await leaveWorkspace(stranger.request, org.ws.id, await meId(stranger.request))).status()).toBe(404);
    expect((await leaveWorkspace(stranger.request, org.ws.id, org.editor.id)).status()).toBe(403);
    expect((await leaveWorkspace(org.editor.request, org.ws.id, org.viewer.id)).status()).toBe(403);
    expect((await listWorkspaces(org.viewer.request)).map((w) => w.id)).toContain(org.ws.id);
  });
});

test.describe("what leaving leaves behind", () => {
  test("a record with status left, the role they had, and both timestamps; the grant itself is gone", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const before = Date.now();
    await leaveWorkspace(org.admin.request, org.ws.id, org.admin.id);
    const [row, ...rest] = await events(org.ws.id, org.admin.id);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ status: "left", role: "admin", actor_user_id: org.admin.id });
    expect(row.created_at).toBeGreaterThanOrEqual(before - 1000);
    expect(row.updated_at).toBeGreaterThanOrEqual(row.created_at);
    expect((await query<any>(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, [org.ws.id, org.admin.id]))[0].n).toBe(0);
  });

  test("being removed by an admin is recorded too, as removed, with who did it", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    expect((await removeMemberRaw(org.admin.request, org.ws.id, org.viewer.id)).status()).toBe(200);
    expect(await events(org.ws.id, org.viewer.id)).toMatchObject([{ status: "removed", role: "viewer", actor_user_id: org.admin.id }]);
  });

  test("what they wrote stays in the workspace", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const board = await createBoard(request, "Shared", { workspace_id: org.ws.id });
    const node = await createNode(org.editor.request, board.id, { title: "mine, but the team's" });
    await leaveWorkspace(org.editor.request, org.ws.id, org.editor.id);
    expect((await contents(request, board.id)).nodes.map((n) => n.id)).toContain(node.id);
  });

  test("an agent connected to it is told the workspace is no longer available", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const mcp = await connectMcp(org.editor.request, { workspace: org.ws.id });
    expect((await mcp.call("list_mindmaps", {})).isError).toBe(false);
    await leaveWorkspace(org.editor.request, org.ws.id, org.editor.id);
    const after = await mcp.call("list_mindmaps", {});
    expect(after.isError).toBe(true);
    expect(after.text).toMatch(/no longer available/);
  });

  test("they can be invited back; the history keeps both", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    await leaveWorkspace(org.viewer.request, org.ws.id, org.viewer.id);
    const sent = await inviteRaw(request, "workspaces", org.ws.id, org.viewer.user.email, "editor");
    expect((await acceptInvite(org.viewer.request, sent.invited!.token)).status()).toBe(200);
    expect((await listWorkspaces(org.viewer.request)).find((w) => w.id === org.ws.id)?.role).toBe("editor");
    await leaveWorkspace(org.viewer.request, org.ws.id, org.viewer.id);
    expect((await events(org.ws.id, org.viewer.id)).map((e) => [e.status, e.role])).toEqual([["left", "viewer"], ["left", "editor"]]);
  });
});
