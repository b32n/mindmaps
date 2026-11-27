import { test, expect } from "@playwright/test";
import { PrivateWorker } from "../../support/private-worker";
import { createBoard, createWorkspace, inviteRaw, listBoards, listWorkspaces, membersOf } from "../../support/api";
import { meId } from "../../support/account";
import { acceptInvite, closeWorkspace, pendingInvites, renameWorkspace } from "../../support/lifecycle";
import { createOrganisation, organisation, refusal, signUp } from "../../support/organisation";
import { setRole } from "../../support/org";
import { register } from "../../fixtures";
import { newUser } from "../../support/users";

// First run in organisation mode: the first account is the owner and creates the
// organisation; there is exactly one; everyone else comes in by invitation.
// Every test has its own Worker because "the first account" needs an empty
// database.

test.describe("org mode, sign-up closed (the real default)", () => {
  let w: PrivateWorker;
  test.beforeEach(async () => {
    w = await new PrivateWorker({ mode: "org", signup: "closed" }).start();
  });
  test.afterEach(async () => w.dispose());

  test("a signed-out visitor cannot read or create anything", async () => {
    const anon = await w.client();
    expect((await anon.get("/api/organisation")).status()).toBe(401);
    expect((await createOrganisation(anon, { name: "Acme" })).status()).toBe(401);
  });

  test("the first account is told to set up the organisation, and does", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const before = await organisation(owner);
    expect(before).toMatchObject({ mode: "org", state: "setup", can_create: true, organisation: null, gated: false });

    const res = await createOrganisation(owner, { name: "  Acme Ltd  " });
    expect(res.status()).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ name: "Acme Ltd", personal: 0, role: "owner", adopted: false });
    expect(created.owner_id).toBe(await meId(owner));

    const after = await organisation(owner);
    expect(after).toMatchObject({ state: "member", can_create: false });
    expect(after.organisation).toMatchObject({ workspace_id: created.id, name: "Acme Ltd", role: "owner" });
    const mine = await listWorkspaces(owner);
    expect(mine.find((x) => x.id === created.id)).toMatchObject({ name: "Acme Ltd", role: "owner", personal: 0 });
  });

  test("names are validated", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    for (const name of ["", "   ", undefined, 7, "x".repeat(81), "two\nlines"]) {
      expect(await refusal(await createOrganisation(owner, { name })), `name ${JSON.stringify(name)}`).toEqual({
        status: 400,
        code: "invalid_name",
      });
    }
    expect((await organisation(owner)).state).toBe("setup");
  });

  test("there is exactly one: a second is refused with a clear code, for everyone", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();

    expect(await refusal(await createOrganisation(owner, { name: "Second" }))).toEqual({ status: 409, code: "organisation_exists" });
    // and the other way in, which used to be how a team space was made
    expect(await refusal(await owner.post("/api/workspaces", { data: { name: "Second" } }))).toEqual({
      status: 409,
      code: "organisation_exists",
    });
    // adopting something else is the same refusal
    expect(await refusal(await createOrganisation(owner, { workspace_id: org.id }))).toEqual({ status: 409, code: "organisation_exists" });
    expect((await listWorkspaces(owner)).filter((x) => !x.personal).map((x) => x.name)).toEqual(["Acme"]);
  });

  test("the organisation cannot be closed (that would leave the instance with none and no way to make one)", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();
    expect(await refusal(await closeWorkspace(owner, org.id))).toEqual({ status: 409, code: "organisation_cannot_close" });
    expect((await listWorkspaces(owner)).map((x) => x.id)).toContain(org.id);
  });

  test("sign-up needs an invitation; the invitee lands outside until they accept", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();

    const stranger = await w.client();
    const nobody = newUser("stranger");
    const refused = await stranger.post("/api/auth/register", { data: { email: nobody.email, password: nobody.password, name: nobody.name } });
    expect(refused.status()).toBe(403);

    const invitee = newUser("invitee");
    await inviteRaw(owner, "workspaces", org.id, invitee.email, "editor");
    const mine = await w.client();
    await register(mine, invitee);

    const info = await organisation(mine);
    expect(info).toMatchObject({ state: "outside", can_create: false, organisation: null, gated: true });
    expect((await listWorkspaces(mine)).map((x) => x.id)).not.toContain(org.id);
    expect((await mine.get(`/api/workspaces/${org.id}/members`)).status()).toBe(404);

    const [invite] = await pendingInvites(mine);
    expect(invite).toMatchObject({ target_id: org.id, target_name: "Acme", role: "editor" });
    expect((await acceptInvite(mine, invite.token)).status()).toBe(200);

    const joined = await organisation(mine);
    expect(joined).toMatchObject({ state: "member", gated: false });
    expect(joined.organisation).toMatchObject({ workspace_id: org.id, role: "editor" });
  });

  test("every role gets the same refusal to create another, and only the owner and admins rename", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();
    const people: Record<string, Awaited<ReturnType<typeof w.client>>> = {};
    for (const role of ["admin", "editor", "viewer"] as const) {
      const c = await w.client();
      const u = newUser(role);
      await inviteRaw(owner, "workspaces", org.id, u.email, role === "viewer" ? "viewer" : "editor");
      await register(c, u);
      for (const inv of await pendingInvites(c)) await acceptInvite(c, inv.token);
      people[role] = c;
    }
    expect((await setRole(owner, org.id, await meId(people.admin), "admin")).status()).toBe(200);

    for (const [role, c] of Object.entries({ owner, ...people })) {
      expect(await refusal(await createOrganisation(c, { name: `By ${role}` })), role).toEqual({ status: 409, code: "organisation_exists" });
      expect(await refusal(await c.post("/api/workspaces", { data: { name: `By ${role}` } })), role).toEqual({
        status: 409,
        code: "organisation_exists",
      });
      expect((await organisation(c)).state, role).toBe("member");
    }
    expect((await renameWorkspace(people.admin, org.id, "Acme Group")).status()).toBe(200);
    expect((await renameWorkspace(people.editor, org.id, "Nope")).status()).toBe(403);
    expect((await organisation(people.viewer)).organisation).toMatchObject({ name: "Acme Group", role: "viewer" });
  });

  test("two sign-ups at once on an empty instance: only one account is created", async () => {
    // Clients first, so the requests leave together rather than one client
    // setup apart.
    const clients = await Promise.all(Array.from({ length: 8 }, () => w.client()));
    const attempts = await Promise.all(
      clients.map(async (c, i) => {
        const u = newUser(`race${i}`);
        const res = await c.post("/api/auth/register", { data: { email: u.email, password: u.password, name: u.name } });
        return { c, status: res.status() };
      }),
    );
    expect(attempts.filter((a) => a.status === 200)).toHaveLength(1);
    expect(attempts.filter((a) => a.status === 403)).toHaveLength(7);
    const winner = attempts.find((a) => a.status === 200)!;
    expect((await organisation(winner.c)).state).toBe("setup");
  });

  test("two creations at once by the owner: one organisation, one workspace", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => createOrganisation(owner, { name: `Acme ${i}` })));
    const codes = await Promise.all(results.map(refusal));
    expect(codes.filter((c) => c.status === 201)).toHaveLength(1);
    expect(codes.filter((c) => c.status === 409 && c.code === "organisation_exists")).toHaveLength(5);
    expect((await listWorkspaces(owner)).filter((x) => !x.personal)).toHaveLength(1);
  });
});

test.describe("org mode, sign-up open", () => {
  let w: PrivateWorker;
  test.beforeEach(async () => {
    w = await new PrivateWorker({ mode: "org", signup: "open" }).start();
  });
  test.afterEach(async () => w.dispose());

  test("a second account before the organisation exists waits; it cannot create it", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const other = await w.client();
    await signUp(other, "other");
    expect(await organisation(other)).toMatchObject({ state: "waiting", can_create: false, organisation: null, adoptable: [] });
    expect(await refusal(await createOrganisation(other, { name: "Mine" }))).toEqual({ status: 403, code: "not_instance_owner" });
    expect(await refusal(await other.post("/api/workspaces", { data: { name: "Mine" } }))).toEqual({
      status: 409,
      code: "organisation_setup_required",
    });
    // the owner is unaffected
    expect((await createOrganisation(owner, { name: "Acme" })).status()).toBe(201);
  });

  test("an uninvited sign-up after setup is outside, sees nothing of it, and cannot create", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();
    const board = await createBoard(owner, "Plans", { workspace_id: org.id });

    const walkIn = await w.client();
    await signUp(walkIn, "walkin");
    expect(await organisation(walkIn)).toMatchObject({ state: "outside", can_create: false, organisation: null, gated: true });
    expect(await refusal(await createOrganisation(walkIn, { name: "Mine" }))).toEqual({ status: 409, code: "organisation_exists" });
    expect(await refusal(await walkIn.post("/api/workspaces", { data: { name: "Mine" } }))).toEqual({ status: 409, code: "organisation_exists" });
    expect((await listBoards(walkIn)).map((b) => b.id)).not.toContain(board.id);
    expect((await walkIn.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
    expect((await membersOf(owner, "workspaces", org.id)).members).toEqual([]);
    // no invitation for them either
    expect(await pendingInvites(walkIn)).toEqual([]);
  });

  test("several sign-ups at once: exactly one is the one who may create the organisation", async () => {
    const people = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const c = await w.client();
        await signUp(c, "race");
        return c;
      }),
    );
    const states = await Promise.all(people.map(async (c) => (await organisation(c)).state));
    expect(states.filter((s) => s === "setup")).toHaveLength(1);
    expect(states.filter((s) => s === "waiting")).toHaveLength(5);

    const outcomes = await Promise.all(people.map((c, i) => createOrganisation(c, { name: `Org ${i}` })));
    const codes = await Promise.all(outcomes.map(refusal));
    expect(codes.filter((c) => c.status === 201)).toHaveLength(1);
    // The rest are refused whichever way the race fell: "not the owner" if they
    // asked before the organisation existed, "exists" if after.
    const refused = codes.filter(
      (c) => (c.status === 403 && c.code === "not_instance_owner") || (c.status === 409 && c.code === "organisation_exists"),
    );
    expect(refused).toHaveLength(5);
  });

  test("if the only account deletes itself, taking the organisation with it, the next one can set it up again", async () => {
    const owner = await w.client();
    const u = await signUp(owner, "owner");
    await createOrganisation(owner, { name: "Acme" });
    const del = await owner.delete("/api/account", { data: { email: u.email } });
    expect(del.status(), await del.text()).toBe(200);

    const next = await w.client();
    await signUp(next, "next");
    expect(await organisation(next)).toMatchObject({ state: "setup", can_create: true, organisation: null });
    expect((await createOrganisation(next, { name: "Again" })).status()).toBe(201);
    expect(await refusal(await createOrganisation(next, { name: "Third" }))).toEqual({ status: 409, code: "organisation_exists" });
  });
});
