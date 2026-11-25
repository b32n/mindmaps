import { test, expect } from "../../fixtures";
import { createBoard, inviteRaw, listWorkspaces, membersOf } from "../../support/api";
import { acceptInvite, pendingInvites } from "../../support/lifecycle";
import { makeOrg } from "../../support/org";
import { modeWorkers } from "../../support/hosts";
import {
  addDomain, client, codeOf, join, joinOffers, newOrg, putPolicy, removeDomain, security, ssoSession, uniqueDomain, userOn,
  verifyDomain, type Security,
} from "../../support/sso";

// Domain policy, per organisation and for verified domains only: who may join
// by themselves (auto-join, a step the person takes, never silent), and who may
// be invited (restrict invites). See worker/src/org-policy.ts and docs/SSO.md.

test.use({ baseURL: modeWorkers.multitenant.baseURL });
const BASE = modeWorkers.multitenant.baseURL;

test.describe("the policy itself", () => {
  test("validated, partial, and read back", async ({ personOn }) => {
    const org = await newOrg(personOn);
    const r = org.owner.request;
    const res = await putPolicy(r, org.ws, { auto_join: true, default_role: "editor" });
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as { policy: Security["policy"] }).policy).toEqual({
      auto_join: true, default_role: "editor", restrict_invites: false, enforce_sso: false,
    });
    // a partial update leaves the rest alone
    await putPolicy(r, org.ws, { restrict_invites: true });
    expect(((await (await security(r, org.ws)).json()) as Security).policy).toEqual({
      auto_join: true, default_role: "editor", restrict_invites: true, enforce_sso: false,
    });

    for (const bad of [{ default_role: "admin" }, { default_role: "owner" }, { default_role: 3 }, { default_role: "" }]) {
      expect(await codeOf(await putPolicy(r, org.ws, bad)), JSON.stringify(bad)).toEqual({ status: 400, code: "invalid_role" });
    }
    for (const bad of [{ auto_join: "yes" }, { auto_join: 1 }, { restrict_invites: null }, { restrict_invites: "true" }, {}]) {
      expect(await codeOf(await putPolicy(r, org.ws, bad)), JSON.stringify(bad)).toEqual({ status: 400, code: "invalid_policy" });
    }
    // enforce_sso is not set here: it has its own route, and an attempt is not silently accepted
    expect(await codeOf(await putPolicy(r, org.ws, { enforce_sso: true }))).toEqual({ status: 400, code: "invalid_policy" });
    expect(((await (await security(r, org.ws)).json()) as Security).policy.enforce_sso).toBe(false);
  });

  test("auto-join and restricted invites need a verified domain to mean anything", async ({ account, request }) => {
    void account;
    const ws = (await (await request.post("/api/organisation", { data: { name: "No domain" } })).json()) as { id: string };
    expect(await codeOf(await putPolicy(request, ws.id, { auto_join: true }))).toEqual({ status: 409, code: "no_verified_domain" });
    expect(await codeOf(await putPolicy(request, ws.id, { restrict_invites: true }))).toEqual({ status: 409, code: "no_verified_domain" });
    // a pending domain is not enough
    await addDomain(request, ws.id, uniqueDomain());
    expect(await codeOf(await putPolicy(request, ws.id, { auto_join: true }))).toEqual({ status: 409, code: "no_verified_domain" });
    // turning them off, and choosing the role, are always fine
    expect((await putPolicy(request, ws.id, { auto_join: false, default_role: "editor" })).status()).toBe(200);
  });

  test("owner and admin may set it; editor, viewer and outsider may not", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Team");
    const outsider = await makePerson("outsider");
    await verifyDomain(request, org.ws.id, uniqueDomain());
    expect((await putPolicy(org.admin.request, org.ws.id, { auto_join: true })).status()).toBe(200);
    for (const who of [org.editor, org.viewer])
      expect(await codeOf(await putPolicy(who.request, org.ws.id, { auto_join: false }))).toEqual({ status: 403, code: "forbidden" });
    expect(await codeOf(await putPolicy(outsider.request, org.ws.id, { auto_join: false }))).toEqual({ status: 404, code: "not_found" });
    const anon = await client(BASE);
    expect((await putPolicy(anon, org.ws.id, { auto_join: false })).status()).toBe(401);
    await anon.dispose();
    expect(((await (await security(request, org.ws.id)).json()) as Security).policy.auto_join).toBe(true);
  });

  test("one organisation's policy is not another's", async ({ personOn }) => {
    const a = await newOrg(personOn, { name: "A" });
    const b = await newOrg(personOn, { name: "B" });
    await putPolicy(a.owner.request, a.ws, { auto_join: true, default_role: "editor" });
    expect(((await (await security(b.owner.request, b.ws)).json()) as Security).policy.auto_join).toBe(false);
    // and the owner of one cannot touch the other's
    expect(await codeOf(await putPolicy(b.owner.request, a.ws, { auto_join: false }))).toEqual({ status: 404, code: "not_found" });
  });
});

test.describe("auto-join", () => {
  test("a person with a proven address on the domain is offered the organisation and joins by pressing Join", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await putPolicy(org.owner.request, org.ws, { auto_join: true, default_role: "viewer" });

    const email = userOn(org.domain, "newhire").email;
    const session = await ssoSession(BASE, email);

    // signing in did not join anyone
    expect((await listWorkspaces(session)).some((w) => w.id === org.ws)).toBe(false);
    const offers = await (await joinOffers(session)).json();
    expect(offers).toEqual({ offers: [{ workspace_id: org.ws, name: "Acme", role: "viewer" }], unproven: false });

    const res = await join(session, org.ws);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, workspace_id: org.ws, role: "viewer" });
    expect((await listWorkspaces(session)).find((w) => w.id === org.ws)).toMatchObject({ role: "viewer" });
    expect(((await membersOf(org.owner.request, "workspaces", org.ws)).members.find((m) => m.email === email))?.role).toBe("viewer");

    // joined: nothing left to offer, and joining again says so
    expect(await (await joinOffers(session)).json()).toEqual({ offers: [], unproven: false });
    expect(await codeOf(await join(session, org.ws))).toEqual({ status: 409, code: "already_member" });
    // and they can read the organisation's mindmaps, but not write them
    const board = await createBoard(org.owner.request, "Handbook", { workspace_id: org.ws });
    expect((await session.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    expect((await session.post("/api/nodes", { data: { board_id: board.id, type: "note", x: 0, y: 0 } })).status()).toBe(403);
  });

  test("the default role is the one the admin chose", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await putPolicy(org.owner.request, org.ws, { auto_join: true, default_role: "editor" });
    const session = await ssoSession(BASE, userOn(org.domain, "ed").email);
    expect(await (await join(session, org.ws)).json()).toMatchObject({ role: "editor" });
    const board = await createBoard(org.owner.request, "Handbook", { workspace_id: org.ws });
    expect((await session.post("/api/nodes", { data: { board_id: board.id, type: "note", x: 0, y: 0 } })).status()).toBeLessThan(300);
  });

  test("a password-only account is unproven: it is told so and cannot join", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await putPolicy(org.owner.request, org.ws, { auto_join: true });
    const pw = await personOn(org.domain, "pwonly");
    // the offer is not shown (it would name the organisation to someone who has not proven the address)
    expect(await (await joinOffers(pw.request)).json()).toEqual({ offers: [], unproven: true });
    expect(await codeOf(await join(pw.request, org.ws))).toEqual({ status: 403, code: "email_unproven" });
    expect((await listWorkspaces(pw.request)).some((w) => w.id === org.ws)).toBe(false);
  });

  test("proof belongs to the session, not the account: the same person's password session still cannot join", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await putPolicy(org.owner.request, org.ws, { auto_join: true });
    const pw = await personOn(org.domain, "both");
    // they also sign in through SSO elsewhere, which links the same account
    const proven = await ssoSession(BASE, pw.user.email);
    expect(await (await joinOffers(proven)).json()).toMatchObject({ unproven: false, offers: [{ workspace_id: org.ws }] });
    expect(await codeOf(await join(pw.request, org.ws))).toEqual({ status: 403, code: "email_unproven" });
    expect((await join(proven, org.ws)).status()).toBe(200);
  });

  test("nothing is offered, and joining is refused, when it is off, or the domain is gone, or the address is elsewhere", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    const email = userOn(org.domain, "hire").email;
    const session = await ssoSession(BASE, email);

    // policy never set
    expect(await (await joinOffers(session)).json()).toEqual({ offers: [], unproven: false });
    expect(await codeOf(await join(session, org.ws))).toEqual({ status: 404, code: "join_not_available" });

    await putPolicy(org.owner.request, org.ws, { auto_join: true });
    expect(((await (await joinOffers(session)).json()) as { offers: unknown[] }).offers).toHaveLength(1);

    // the domain is removed: the policy lapses with it
    const sec = (await (await security(org.owner.request, org.ws)).json()) as Security;
    expect((await removeDomain(org.owner.request, org.ws, sec.domains[0]!.id)).status()).toBe(200);
    expect(await (await joinOffers(session)).json()).toEqual({ offers: [], unproven: false });
    expect(await codeOf(await join(session, org.ws))).toEqual({ status: 404, code: "join_not_available" });

    // an address on another domain never matches, and the answer is the same as for a workspace that does not exist
    const elsewhere = await personOn(uniqueDomain("else"), "elsewhere");
    expect(await codeOf(await join(elsewhere.request, org.ws))).toEqual({ status: 404, code: "join_not_available" });
    expect(await codeOf(await join(elsewhere.request, "no-such-workspace"))).toEqual({ status: 404, code: "join_not_available" });
  });

  test("it is per organisation: another organisation's auto-join does not apply to this domain", async ({ personOn }) => {
    const a = await newOrg(personOn, { sso: true, name: "A" });
    const b = await newOrg(personOn, { sso: true, name: "B" });
    await putPolicy(b.owner.request, b.ws, { auto_join: true });
    const session = await ssoSession(BASE, userOn(a.domain, "hire").email);
    expect(await codeOf(await join(session, b.ws))).toEqual({ status: 404, code: "join_not_available" });
    expect(await codeOf(await join(session, a.ws))).toEqual({ status: 404, code: "join_not_available" });
  });

  test("an existing member keeps their role; joining never lowers it", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await putPolicy(org.owner.request, org.ws, { auto_join: true, default_role: "viewer" });
    // the owner themself signs in through SSO and sees nothing to join
    const ownerSession = await ssoSession(BASE, org.owner.user.email);
    expect(await (await joinOffers(ownerSession)).json()).toEqual({ offers: [], unproven: false });
    expect(await codeOf(await join(ownerSession, org.ws))).toEqual({ status: 409, code: "already_member" });
    expect((await listWorkspaces(ownerSession)).find((w) => w.id === org.ws)?.role).toBe("owner");
  });

  test("a signed-out caller is refused", async () => {
    const anon = await client(BASE);
    expect((await joinOffers(anon)).status()).toBe(401);
    expect((await join(anon, "x")).status()).toBe(401);
    await anon.dispose();
  });
});

test.describe("restrict invites to the verified domains", () => {
  test("off by default: any address can be invited, as before", async ({ personOn }) => {
    const org = await newOrg(personOn);
    const res = await org.owner.request.post(`/api/workspaces/${org.ws}/members`, { data: { email: "anyone@elsewhere.example", role: "editor" } });
    expect(res.status()).toBe(201);
  });

  test("on: only addresses on a verified domain, whoever asks and whether or not they have an account", async ({ personOn, makePerson }) => {
    const org = await newOrg(personOn);
    const admin = await personOn(org.domain, "admin");
    await inviteRaw(org.owner.request, "workspaces", org.ws, admin.user.email, "editor");
    for (const inv of await pendingInvites(admin.request)) await acceptInvite(admin.request, inv.token);
    expect((await org.owner.request.patch(`/api/workspaces/${org.ws}/members/${(await (await admin.request.get("/api/auth/me")).json()).user.id}`, { data: { role: "admin" } })).status()).toBe(200);
    await putPolicy(org.owner.request, org.ws, { restrict_invites: true });

    const stranger = await makePerson("stranger"); // an account, on example.test
    const ask = (r: typeof org.owner.request, email: string) =>
      r.post(`/api/workspaces/${org.ws}/members`, { data: { email, role: "editor" } });

    for (const r of [org.owner.request, admin.request]) {
      expect(await codeOf(await ask(r, "nobody@elsewhere.example"))).toEqual({ status: 403, code: "invite_domain_restricted" });
      expect(await codeOf(await ask(r, stranger.user.email))).toEqual({ status: 403, code: "invite_domain_restricted" });
      // a lookalike is not the domain; neither is a subdomain
      expect(await codeOf(await ask(r, `x@evil-${org.domain}`))).toEqual({ status: 403, code: "invite_domain_restricted" });
      expect(await codeOf(await ask(r, `x@sub.${org.domain}`))).toEqual({ status: 403, code: "invite_domain_restricted" });
    }
    expect((await ask(org.owner.request, `Colleague@${org.domain.toUpperCase()}`)).status()).toBe(201);
    expect((await ask(admin.request, `other@${org.domain}`)).status()).toBe(201);
    expect((await membersOf(org.owner.request, "workspaces", org.ws)).pending.map((p) => p.email).sort()).toEqual([`colleague@${org.domain}`, `other@${org.domain}`]);
  });

  test("it also guards sharing one of the organisation's mindmaps outside it", async ({ personOn, makePerson }) => {
    const org = await newOrg(personOn);
    const board = await createBoard(org.owner.request, "Plans", { workspace_id: org.ws });
    const stranger = await makePerson("stranger");
    await putPolicy(org.owner.request, org.ws, { restrict_invites: true });
    const res = await org.owner.request.post(`/api/boards/${board.id}/members`, { data: { email: stranger.user.email, role: "viewer" } });
    expect(await codeOf(res)).toEqual({ status: 403, code: "invite_domain_restricted" });
    // a mindmap in someone's own workspace is nobody's policy
    const mine = await createBoard(stranger.request, "Mine");
    const ok = await stranger.request.post(`/api/boards/${mine.id}/members`, { data: { email: "friend@elsewhere.example", role: "viewer" } });
    expect(ok.status()).toBe(201);
  });

  test("it never locks anyone out: members who are already in keep access and their role can still change", async ({ personOn, makePerson }) => {
    const org = await newOrg(personOn);
    const guest = await makePerson("guest");
    await inviteRaw(org.owner.request, "workspaces", org.ws, guest.user.email, "viewer");
    for (const inv of await pendingInvites(guest.request)) await acceptInvite(guest.request, inv.token);
    const guestId = (await (await guest.request.get("/api/auth/me")).json()).user.id as string;
    await putPolicy(org.owner.request, org.ws, { restrict_invites: true });

    expect((await listWorkspaces(guest.request)).some((w) => w.id === org.ws)).toBe(true);
    // changing an existing off-domain member's role is not an invitation
    const again = await org.owner.request.post(`/api/workspaces/${org.ws}/members`, { data: { email: guest.user.email, role: "editor" } });
    expect(again.status()).toBe(201);
    expect((await org.owner.request.patch(`/api/workspaces/${org.ws}/members/${guestId}`, { data: { role: "viewer" } })).status()).toBe(200);
    // the owner still opens and edits the policy
    expect((await putPolicy(org.owner.request, org.ws, { restrict_invites: false })).status()).toBe(200);
  });

  test("an invitation sent before the switch cannot be accepted after it", async ({ personOn, makePerson }) => {
    const org = await newOrg(personOn);
    const guest = await makePerson("guest");
    const sent = await inviteRaw(org.owner.request, "workspaces", org.ws, guest.user.email, "editor");
    await putPolicy(org.owner.request, org.ws, { restrict_invites: true });
    const res = await acceptInvite(guest.request, sent.invited!.token);
    expect(await codeOf(res)).toEqual({ status: 409, code: "invite_domain_restricted" });
    expect((await listWorkspaces(guest.request)).some((w) => w.id === org.ws)).toBe(false);
  });

  test("it lapses with the last verified domain, and turning it off lets any address in again", async ({ personOn }) => {
    const org = await newOrg(personOn);
    await putPolicy(org.owner.request, org.ws, { restrict_invites: true });
    const ask = () => org.owner.request.post(`/api/workspaces/${org.ws}/members`, { data: { email: "x@elsewhere.example", role: "editor" } });
    expect((await ask()).status()).toBe(403);
    await putPolicy(org.owner.request, org.ws, { restrict_invites: false });
    expect((await ask()).status()).toBe(201);
    await putPolicy(org.owner.request, org.ws, { restrict_invites: true });
    const sec = (await (await security(org.owner.request, org.ws)).json()) as Security;
    await removeDomain(org.owner.request, org.ws, sec.domains[0]!.id);
    expect((await org.owner.request.post(`/api/workspaces/${org.ws}/members`, { data: { email: "y@elsewhere.example", role: "editor" } })).status()).toBe(201);
  });

  test("another organisation's restriction does not apply here", async ({ personOn }) => {
    const a = await newOrg(personOn, { name: "A" });
    const b = await newOrg(personOn, { name: "B" });
    await putPolicy(a.owner.request, a.ws, { restrict_invites: true });
    expect((await b.owner.request.post(`/api/workspaces/${b.ws}/members`, { data: { email: "x@elsewhere.example", role: "editor" } })).status()).toBe(201);
  });
});

test.describe("a person with no policy anywhere is unaffected", () => {
  test("the workspace list and join offers are as before", async ({ makePerson }) => {
    const p = await makePerson("plain");
    expect((await listWorkspaces(p.request)).map((w) => w.personal)).toEqual([1]);
    expect(await (await joinOffers(p.request)).json()).toEqual({ offers: [], unproven: false });
  });
});
