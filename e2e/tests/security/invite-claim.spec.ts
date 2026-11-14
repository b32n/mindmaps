import { test, expect } from "../../fixtures";
import { addMember, createBoard, createWorkspace, listWorkspaces } from "../../support/api";
import { newUser } from "../../support/users";

// Pending invites are claimed by e-mail address when someone signs up (or
// signs in). The app never sends a message and never asks the new person to
// prove they own the mailbox.

test.describe("how an invite is matched to a sign-up", () => {
  test("only the exact address (case aside) claims it: plus-addresses and look-alikes do not", async ({ account, request, playwright, baseURL }) => {
    void account;
    const ws = await createWorkspace(request, "Exact match");
    const victim = newUser("victim");
    const [local, domain] = victim.email.split("@");
    await addMember(request, "workspaces", ws.id, victim.email, "editor");

    for (const address of [`${local}+tag@${domain}`, `${local}x@${domain}`, `${local}@sub.${domain}`]) {
      const other = await playwright.request.newContext({ baseURL });
      const res = await other.post("/api/auth/register", { data: { email: address, password: newUser().password, name: "Lookalike" } });
      expect(res.status(), address).toBe(200);
      expect((await listWorkspaces(other)).map((w) => w.name), address).toEqual(["Personal"]);
      await other.dispose();
    }
  });

  test("an invite that was cancelled does not give anything to a later sign-up", async ({ account, request, playwright, baseURL }) => {
    void account;
    const ws = await createWorkspace(request, "Cancelled");
    const who = newUser("cancelled");
    const sent = await addMember(request, "workspaces", ws.id, who.email);
    expect((await request.delete(`/api/invites/${sent.invited!.token}`)).ok()).toBe(true);
    const fresh = await playwright.request.newContext({ baseURL });
    await fresh.post("/api/auth/register", { data: { email: who.email, password: who.password, name: who.name } });
    expect((await listWorkspaces(fresh)).map((w) => w.name)).toEqual(["Personal"]);
    await fresh.dispose();
  });

  test("one sign-up claims every invite that is waiting for its address", async ({ account, request, playwright, baseURL }) => {
    void account;
    const first = await createWorkspace(request, "First");
    const second = await createWorkspace(request, "Second");
    await createBoard(request, "In second", { workspace_id: second.id });
    const who = newUser("both");
    await addMember(request, "workspaces", first.id, who.email, "viewer");
    await addMember(request, "workspaces", second.id, who.email, "editor");
    const fresh = await playwright.request.newContext({ baseURL });
    await fresh.post("/api/auth/register", { data: { email: who.email, password: who.password, name: who.name } });
    const mine = await listWorkspaces(fresh);
    expect(mine.map((w) => [w.name, w.role])).toEqual(expect.arrayContaining([["First", "viewer"], ["Second", "editor"]]));
    await fresh.dispose();
  });
});

test.describe("known problems with invites", () => {
  test.fixme("a sign-up that has not proved it owns the invited address does not receive the invite's access", async ({
    account,
    request,
    playwright,
    baseURL,
  }) => {
    // Expected: access granted by an invite goes to the person who controls
    // that mailbox, so a sign-up is only given the membership once the address
    // is verified. Actual: `claimInvites` (worker/src/members.ts) runs during
    // registration and sign-in with the address as typed, and the app has no
    // e-mail verification at all. Anyone who learns that "x@example.com" was
    // invited to a workspace can register that address with their own
    // password and is a member immediately, with the invited role, before the
    // real owner of the mailbox does anything. If the real person registers
    // later they are told the address is taken (409). Observed: a stranger
    // registered the invited address and listed the workspace and its
    // mindmaps.
    void account;
    const ws = await createWorkspace(request, "Confidential");
    const board = await createBoard(request, "Plans", { workspace_id: ws.id });
    const victim = newUser("victim");
    await addMember(request, "workspaces", ws.id, victim.email, "editor");

    const attacker = await playwright.request.newContext({ baseURL });
    const res = await attacker.post("/api/auth/register", { data: { email: victim.email, password: newUser().password, name: "Not the victim" } });
    expect(res.status()).toBe(200);

    expect((await listWorkspaces(attacker)).map((w) => w.name)).not.toContain("Confidential");
    expect((await attacker.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
    await attacker.dispose();
  });
});

test.describe("accounts and their deletion", () => {
  test("the API has no route that deletes an account", async ({ account, request }) => {
    // This is why "deleting a workspace's owner removes the workspace" is not an
    // end-to-end test: nothing in the product reaches it. See the PR notes.
    for (const [method, path] of [
      ["delete", "/api/auth/me"],
      ["delete", "/api/auth/account"],
      ["delete", "/api/users/me"],
    ] as const) {
      const res = await request[method](path);
      expect([404, 405], `${method} ${path}`).toContain(res.status());
    }
    expect((await (await request.get("/api/auth/me")).json()).user.email).toBe(account.email);
  });
});
