import { readFileSync } from "node:fs";
import { test, expect } from "../../fixtures";
import {
  contents, createArtefact, createBoard, createWorkspace, inviteRaw, listBoards, listWorkspaces, membersOf, shareBoard,
} from "../../support/api";
import { acceptInvite, closeWorkspace, declineInvite, pendingInvites, reopenWorkspace } from "../../support/lifecycle";
import { makeOrg, setRole } from "../../support/org";
import { newUser } from "../../support/users";
import { query } from "../../support/versions";

// Invitations are accepted, not claimed. Inviting someone to a workspace leaves
// an invite waiting for them, whether or not they already have an account; they
// see it (GET /api/invites) and only become a member by accepting. Declining,
// or the inviter taking it back, ends it with a status and nothing else.

const row = async (token: string) => (await query<any>(`SELECT * FROM invites WHERE token = ?`, [token]))[0];

test.describe("inviting an existing account", () => {
  test("does not add them: they wait, and see nothing of the workspace", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const board = await createBoard(request, "Plans", { workspace_id: ws.id });
    const res = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "editor");
    expect(res.added).toBeUndefined();
    expect(res.invited).toMatchObject({ email: existing.user.email, role: "editor", existing: true });

    expect((await listWorkspaces(existing.request)).map((w) => w.id)).not.toContain(ws.id);
    expect((await existing.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
    expect((await listBoards(existing.request)).map((b) => b.id)).not.toContain(board.id);
    const members = await membersOf(request, "workspaces", ws.id);
    expect(members.members.map((m) => m.email)).not.toContain(existing.user.email);
    expect(members.pending.map((p) => p.email)).toEqual([existing.user.email]);
  });

  test("they list it, with the workspace, the role and who asked", async ({ account, request, existing }) => {
    const ws = await createWorkspace(request, "Acme");
    const sent = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "viewer");
    const [invite, ...rest] = await pendingInvites(existing.request);
    expect(rest).toEqual([]);
    expect(invite).toMatchObject({
      token: sent.invited!.token, target_type: "workspace", target_id: ws.id, target_name: "Acme", role: "viewer",
    });
    expect(invite.invited_by.email).toBe(account.email);
    expect(invite.created_at).toBeGreaterThan(0);
  });

  test("the list is theirs alone: another account, or a look-alike address, sees nothing", async ({ account, request, existing, makePerson }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    await inviteRaw(request, "workspaces", ws.id, existing.user.email, "viewer");
    const other = await makePerson("other");
    expect(await pendingInvites(other.request)).toEqual([]);
    expect(await pendingInvites(request)).toEqual([]);
  });

  test("accepting makes them a member with the invited role", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const board = await createBoard(request, "Plans", { workspace_id: ws.id });
    const sent = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "viewer");
    const res = await acceptInvite(existing.request, sent.invited!.token);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, target_type: "workspace", target_id: ws.id, role: "viewer" });

    expect((await listWorkspaces(existing.request)).find((w) => w.id === ws.id)?.role).toBe("viewer");
    expect((await contents(existing.request, board.id)).board.id).toBe(board.id);
    expect(await pendingInvites(existing.request)).toEqual([]);
    const members = await membersOf(request, "workspaces", ws.id);
    expect(members.members.map((m) => m.email)).toContain(existing.user.email);
    expect(members.pending).toEqual([]);

    const r = await row(sent.invited!.token);
    expect(r).toMatchObject({ status: "accepted", revoked: 0 });
    expect(r.accepted_at).toBeGreaterThan(0);
    expect(r.updated_at).toBeGreaterThanOrEqual(r.created_at);
    expect(r.accepted_by).toBeTruthy();
  });

  test("accepting twice is a conflict, and does not change the role", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const sent = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "viewer");
    expect((await acceptInvite(existing.request, sent.invited!.token)).status()).toBe(200);
    expect((await acceptInvite(existing.request, sent.invited!.token)).status()).toBe(409);
    expect((await listWorkspaces(existing.request)).find((w) => w.id === ws.id)?.role).toBe("viewer");
  });

  test("declining ends it: not a member, status declined, and it cannot be accepted afterwards", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const sent = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "editor");
    const res = await declineInvite(existing.request, sent.invited!.token);
    expect(res.status()).toBe(200);
    expect(await pendingInvites(existing.request)).toEqual([]);
    expect((await listWorkspaces(existing.request)).map((w) => w.id)).not.toContain(ws.id);
    expect((await membersOf(request, "workspaces", ws.id)).pending).toEqual([]);
    expect(await row(sent.invited!.token)).toMatchObject({ status: "declined", accepted_at: null });
    expect((await acceptInvite(existing.request, sent.invited!.token)).status()).toBe(409);
    expect((await declineInvite(existing.request, sent.invited!.token)).status()).toBe(409);
    expect((await listWorkspaces(existing.request)).map((w) => w.id)).not.toContain(ws.id);
  });

  test("a declined person can be invited again", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const first = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "editor");
    await declineInvite(existing.request, first.invited!.token);
    const again = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "viewer");
    expect(again.invited!.token).not.toBe(first.invited!.token);
    expect((await acceptInvite(existing.request, again.invited!.token)).status()).toBe(200);
    expect((await listWorkspaces(existing.request)).find((w) => w.id === ws.id)?.role).toBe("viewer");
  });

  test("inviting twice does not stack: there is one pending invite per person and workspace", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    await inviteRaw(request, "workspaces", ws.id, existing.user.email, "viewer");
    const second = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "editor");
    const mine = await pendingInvites(existing.request);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ token: second.invited!.token, role: "editor" });
    expect((await membersOf(request, "workspaces", ws.id)).pending).toHaveLength(1);
  });
});

test.describe("who can act on an invite", () => {
  test("only the person it was sent to: someone else holding the token gets not-found", async ({ account, request, existing, makePerson, playwright, baseURL }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const sent = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "editor");
    const token = sent.invited!.token;
    const thief = await makePerson("thief");
    for (const act of [acceptInvite, declineInvite]) {
      expect((await act(thief.request, token)).status()).toBe(404);
      expect((await act(request, token)).status()).toBe(404);
    }
    const anon = await playwright.request.newContext({ baseURL });
    expect((await acceptInvite(anon, token)).status()).toBe(401);
    expect((await declineInvite(anon, token)).status()).toBe(401);
    expect((await anon.get("/api/invites")).status()).toBe(401);
    await anon.dispose();
    expect((await listWorkspaces(thief.request)).map((w) => w.id)).not.toContain(ws.id);
    expect(await row(token)).toMatchObject({ status: "pending" });
    // an unknown token is the same answer
    expect((await acceptInvite(existing.request, "nope-nope-nope-nope-nope")).status()).toBe(404);
  });

  test("the inviter takes it back: status revoked, and it can no longer be accepted", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const sent = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "editor");
    expect((await request.delete(`/api/invites/${sent.invited!.token}`)).status()).toBe(200);
    expect(await pendingInvites(existing.request)).toEqual([]);
    expect(await row(sent.invited!.token)).toMatchObject({ status: "revoked", revoked: 1 });
    expect((await acceptInvite(existing.request, sent.invited!.token)).status()).toBe(404);
    expect((await listWorkspaces(existing.request)).map((w) => w.id)).not.toContain(ws.id);
  });

  test("nobody else can take it back", async ({ account, request, existing, makePerson }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const sent = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "editor");
    const other = await makePerson("other");
    expect((await other.request.delete(`/api/invites/${sent.invited!.token}`)).status()).toBe(404);
    expect((await pendingInvites(existing.request)).map((i) => i.token)).toEqual([sent.invited!.token]);
  });

  test("an invite from someone who has since lost the right to invite is refused and ended", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const guest = await makePerson("guest");
    const sent = await inviteRaw(org.admin.request, "workspaces", org.ws.id, guest.user.email, "editor");
    expect((await setRole(request, org.ws.id, org.admin.id, "editor")).status()).toBe(200);
    const res = await acceptInvite(guest.request, sent.invited!.token);
    expect(res.status()).toBe(409);
    expect((await listWorkspaces(guest.request)).map((w) => w.id)).not.toContain(org.ws.id);
    expect(await row(sent.invited!.token)).toMatchObject({ status: "revoked" });
    expect(await pendingInvites(guest.request)).toEqual([]);
  });

  test("an admin's invitation stands while they are still an admin", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const guest = await makePerson("guest");
    const sent = await inviteRaw(org.admin.request, "workspaces", org.ws.id, guest.user.email, "viewer");
    expect((await acceptInvite(guest.request, sent.invited!.token)).status()).toBe(200);
  });

  test("an editor still cannot invite", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const guest = await makePerson("guest");
    const res = await org.editor.request.post(`/api/workspaces/${org.ws.id}/members`, { data: { email: guest.user.email, role: "viewer" } });
    expect(res.status()).toBe(403);
    expect(await pendingInvites(guest.request)).toEqual([]);
  });
});

test.describe("closed workspaces", () => {
  test("an invite to one is not shown or acceptable while it is closed, and is back after reopening", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const sent = await inviteRaw(request, "workspaces", ws.id, existing.user.email, "editor");
    await closeWorkspace(request, ws.id);
    expect(await pendingInvites(existing.request)).toEqual([]);
    expect((await acceptInvite(existing.request, sent.invited!.token)).status()).toBe(404);
    expect((await listWorkspaces(existing.request)).map((w) => w.id)).not.toContain(ws.id);
    await reopenWorkspace(request, ws.id);
    expect((await pendingInvites(existing.request)).map((i) => i.token)).toEqual([sent.invited!.token]);
    expect((await acceptInvite(existing.request, sent.invited!.token)).status()).toBe(200);
  });
});

test.describe("signing up or in with an invited address", () => {
  const signUp = async (playwright: any, baseURL: any, user: { email: string; password: string; name: string }) => {
    const ctx = await playwright.request.newContext({ baseURL });
    const res = await ctx.post("/api/auth/register", { data: { email: user.email, password: user.password, name: user.name } });
    expect(res.status()).toBe(200);
    return ctx;
  };

  test("registering joins nothing: the invite is waiting, and accepting is what joins", async ({ account, request, playwright, baseURL }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const board = await createBoard(request, "Plans", { workspace_id: ws.id });
    const who = newUser("newcomer");
    const sent = await inviteRaw(request, "workspaces", ws.id, who.email, "editor");
    expect(sent.invited).toBeTruthy();
    expect(sent.invited!.existing).toBeFalsy();

    const ctx = await signUp(playwright, baseURL, who);
    expect((await listWorkspaces(ctx)).map((w) => w.name)).toEqual(["Personal"]);
    expect((await ctx.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
    expect((await pendingInvites(ctx)).map((i) => i.target_name)).toEqual(["Acme"]);
    expect(await row(sent.invited!.token)).toMatchObject({ status: "pending", accepted_at: null });

    expect((await acceptInvite(ctx, sent.invited!.token)).status()).toBe(200);
    expect((await listWorkspaces(ctx)).find((w) => w.id === ws.id)?.role).toBe("editor");
    await ctx.dispose();
  });

  test("signing in again does not join either; declining is remembered across sign-ins", async ({ account, request, playwright, baseURL }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const who = newUser("returning");
    const sent = await inviteRaw(request, "workspaces", ws.id, who.email, "viewer");
    const first = await signUp(playwright, baseURL, who);
    await first.post("/api/auth/logout");
    const login = await first.post("/api/auth/login", { data: { email: who.email, password: who.password } });
    expect(login.status()).toBe(200);
    expect((await listWorkspaces(first)).map((w) => w.name)).toEqual(["Personal"]);
    expect(await pendingInvites(first)).toHaveLength(1);

    await declineInvite(first, sent.invited!.token);
    await first.post("/api/auth/logout");
    await first.post("/api/auth/login", { data: { email: who.email, password: who.password } });
    expect((await listWorkspaces(first)).map((w) => w.name)).toEqual(["Personal"]);
    expect(await pendingInvites(first)).toEqual([]);
    await first.dispose();
  });

  test("one sign-up sees every invite waiting for its address and accepts each separately", async ({ account, request, playwright, baseURL }) => {
    void account;
    const a = await createWorkspace(request, "First");
    const b = await createWorkspace(request, "Second");
    const who = newUser("both");
    const ia = await inviteRaw(request, "workspaces", a.id, who.email, "viewer");
    const ib = await inviteRaw(request, "workspaces", b.id, who.email, "editor");
    const ctx = await signUp(playwright, baseURL, who);
    expect((await pendingInvites(ctx)).map((i) => i.target_name).sort()).toEqual(["First", "Second"]);
    expect((await acceptInvite(ctx, ia.invited!.token)).status()).toBe(200);
    await declineInvite(ctx, ib.invited!.token);
    expect((await listWorkspaces(ctx)).map((w) => w.name).sort()).toEqual(["First", "Personal"]);
    await ctx.dispose();
  });

  test("an address that is only look-alike gets no invite", async ({ account, request, playwright, baseURL }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const victim = newUser("victim");
    const [local, domain] = victim.email.split("@");
    await inviteRaw(request, "workspaces", ws.id, victim.email, "editor");
    for (const address of [`${local}+tag@${domain}`, `${local}x@${domain}`]) {
      const ctx = await signUp(playwright, baseURL, { ...newUser(), email: address });
      expect(await pendingInvites(ctx), address).toEqual([]);
      await ctx.dispose();
    }
  });

  test("the address is matched without regard to case", async ({ account, request, playwright, baseURL }) => {
    void account;
    const ws = await createWorkspace(request, "Acme");
    const who = newUser("cased");
    await inviteRaw(request, "workspaces", ws.id, who.email.toUpperCase(), "viewer");
    const ctx = await signUp(playwright, baseURL, who);
    expect(await pendingInvites(ctx)).toHaveLength(1);
    await ctx.dispose();
  });

  test("there is no sign-in path that joins on its own: the Google callback does not claim invites", async () => {
    // Google needs a real Google to exercise, so guard the code: the only thing
    // that ever turned an invite into membership on sign-in was claimInvites.
    const src = readFileSync(new URL("../../../worker/src/index.ts", import.meta.url), "utf8");
    expect(src).not.toContain("claimInvites");
  });
});

test.describe("a mindmap or artefact invitation", () => {
  test("to someone with no account waits for them to accept after signing up", async ({ account, request, playwright, baseURL }) => {
    void account;
    const board = await createBoard(request, "One map");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "S", sheets: [{ name: "S", rows: [["a"]] }] });
    const who = newUser("guest");
    const sent = await inviteRaw(request, "boards", board.id, who.email, "viewer");
    const sentNode = await inviteRaw(request, "artefacts", sheet.id, who.email, "viewer");
    const ctx = await playwright.request.newContext({ baseURL });
    await ctx.post("/api/auth/register", { data: { email: who.email, password: who.password, name: who.name } });

    expect((await ctx.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
    expect((await ctx.get(`/api/nodes/${sheet.id}`)).status()).toBe(404);
    expect((await pendingInvites(ctx)).map((i) => [i.target_type, i.target_name]).sort()).toEqual([
      ["board", "One map"], ["node", "S"],
    ]);
    expect((await acceptInvite(ctx, sent.invited!.token)).status()).toBe(200);
    expect((await contents(ctx, board.id)).board.id).toBe(board.id);
    await declineInvite(ctx, sentNode.invited!.token);
    expect((await ctx.get(`/api/nodes/${sheet.id}`)).status()).toBe(200); // reachable through the mindmap it now reads
    await ctx.dispose();
  });

  test("sharing a mindmap with an existing account is unchanged: it is theirs straight away", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "One map");
    const res = await shareBoard(request, board.id, existing.user.email, "viewer");
    expect(res.added).toMatchObject({ email: existing.user.email, role: "viewer" });
    expect((await contents(existing.request, board.id)).board.id).toBe(board.id);
    expect(await pendingInvites(existing.request)).toEqual([]);
  });
});

test.describe("existing memberships", () => {
  test("a member invited again is a role change, not a new invitation", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson);
    const res = await inviteRaw(request, "workspaces", org.ws.id, org.viewer.user.email, "editor");
    expect(res.added).toMatchObject({ role: "editor" });
    expect(res.invited).toBeUndefined();
    expect(await pendingInvites(org.viewer.request)).toEqual([]);
    expect((await listWorkspaces(org.viewer.request)).find((w) => w.id === org.ws.id)?.role).toBe("editor");
  });
});
