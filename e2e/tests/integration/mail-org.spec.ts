import { test, expect } from "@playwright/test";
import { PrivateWorker } from "../../support/private-worker";
import { inviteRaw, listWorkspaces } from "../../support/api";
import { mailbox, tokenIn, waitForMail } from "../../support/mail";
import { createOrganisation, organisation, signUp } from "../../support/organisation";
import { newUser } from "../../support/users";
import { dns, join, joinOffers, putPolicy, recordName, uniqueDomain, userOn, verifyDomain } from "../../support/sso";

// Outbound email (docs/EMAIL.md, SIGNUP.md) on an instance with an organisation
// (docs/MODES.md, SSO.md): sign-up answers every address alike, the first
// account is still decided by the insert, an invitation can be accepted
// only once the address is confirmed, and an address confirmed by email
// proves itself for joining an organisation by its domain.

const MAIL = { MAIL_FROM: "mindmaps@mail.example.test", MAIL_FROM_NAME: "mindmaps", MAIL_TRANSPORT: "capture" };

test.describe("org mode, sign-up closed, email on", () => {
  let w: PrivateWorker;
  test.beforeEach(async () => {
    w = await new PrivateWorker({ mode: "org", signup: "closed", vars: MAIL }).start();
  });
  test.afterEach(async () => w.dispose());

  test("two first sign-ups at once: one account, the other is refused like any stranger", async () => {
    const a = await w.client();
    const b = await w.client();
    const [ua, ub] = [newUser("first-a"), newUser("first-b")];
    const post = (c: typeof a, u: typeof ua) =>
      c.post("/api/auth/register", { data: { email: u.email, password: u.password, name: u.name } });
    const res = await Promise.all([post(a, ua), post(b, ub)]);
    expect(res.map((r) => r.status()).sort()).toEqual([200, 403]);
    const won = res[0]!.status() === 200 ? ua : ub;
    const lost = won === ua ? ub : ua;
    // exactly one can sign in
    expect((await (await w.client()).post("/api/auth/login", { data: { email: won.email, password: won.password } })).status()).toBe(200);
    expect((await (await w.client()).post("/api/auth/login", { data: { email: lost.email, password: lost.password } })).status()).toBe(401);
  });

  test("once the organisation exists, a taken address and a stranger's get the same refusal; an invited address gets the generic answer", async () => {
    const owner = await w.client();
    const o = await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();

    const anon = await w.client();
    const attempt = async (email: string) => {
      const r = await anon.post("/api/auth/register", { data: { email, password: newUser("x").password, name: "x" } });
      return { status: r.status(), body: await r.json() };
    };
    const taken = await attempt(o.email);
    const stranger = await attempt(newUser("stranger").email);
    expect(taken).toEqual(stranger);
    expect(taken.status).toBe(403);

    const invitee = newUser("invitee");
    await inviteRaw(owner, "workspaces", org.id, invitee.email);
    const ok = await attempt(invitee.email);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, confirm: "email" });
  });

  test("the invited person confirms the address, then sees the invitation and joins by accepting it", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();
    const guest = await w.client();
    const g = newUser("guest");
    const sent = (await inviteRaw(owner, "workspaces", org.id, g.email)).invited!;
    const reg = await guest.post("/api/auth/register", { data: { email: g.email, password: g.password, name: g.name } });
    expect(reg.status()).toBe(200);
    expect((await guest.post("/api/auth/login", { data: { email: g.email, password: g.password } })).status()).toBe(200);

    // unconfirmed: accepting is refused and joins nothing
    expect((await guest.post(`/api/invites/${sent.token}/accept`)).status()).toBe(403);
    expect((await listWorkspaces(guest)).some((x) => x.id === org.id)).toBe(false);

    const [msg] = await waitForMail(guest, g.email);
    expect((await guest.post("/api/auth/verify-email", { data: { token: tokenIn(msg) } })).status()).toBe(200);
    const listed = ((await (await guest.get("/api/invites")).json()) as { invites: { token: string }[] }).invites;
    expect(listed.map((i) => i.token)).toEqual([sent.token]);
    expect((await guest.post(`/api/invites/${sent.token}/accept`)).status()).toBe(200);
    expect((await organisation(guest)).state).toBe("member");
  });
});

test.describe("joining an organisation by its domain, email on", () => {
  let w: PrivateWorker;
  test.beforeEach(async () => {
    w = await new PrivateWorker({ mode: "multitenant", signup: "open", vars: MAIL }).start();
  });
  test.afterEach(async () => w.dispose());

  test("an address confirmed by email is proof enough to join; before that it is not", async () => {
    const domain = uniqueDomain();
    const owner = await w.client();
    const ownerUser = { ...newUser("owner"), email: userOn(domain, "owner").email };
    await owner.post("/api/auth/register", { data: { email: ownerUser.email, password: ownerUser.password, name: "o" } });
    await owner.post("/api/auth/login", { data: { email: ownerUser.email, password: ownerUser.password } });
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();
    await verifyDomain(owner, org.id, domain);
    expect((await putPolicy(owner, org.id, { auto_join: true, default_role: "viewer" })).status()).toBe(200);

    const joiner = await w.client();
    const j = { ...newUser("joiner"), email: userOn(domain, "joiner").email };
    await joiner.post("/api/auth/register", { data: { email: j.email, password: j.password, name: "j" } });
    await joiner.post("/api/auth/login", { data: { email: j.email, password: j.password } });

    expect(await (await joinOffers(joiner)).json()).toMatchObject({ offers: [], unproven: true });
    const early = await join(joiner, org.id);
    expect(early.status()).toBe(403);
    expect((await early.json()).code).toBe("email_unproven");

    const [msg] = await waitForMail(joiner, j.email);
    expect((await joiner.post("/api/auth/verify-email", { data: { token: tokenIn(msg) } })).status()).toBe(200);
    const offers = (await (await joinOffers(joiner)).json()) as { offers: { workspace_id: string }[]; unproven: boolean };
    expect(offers.unproven).toBe(false);
    expect(offers.offers.map((o) => o.workspace_id)).toEqual([org.id]);
    expect((await join(joiner, org.id)).status()).toBe(200);
    expect((await listWorkspaces(joiner)).some((x) => x.id === org.id)).toBe(true);
    expect((await mailbox(joiner, j.email)).length).toBeGreaterThan(0);
    await dns.clearTxt(recordName(domain));
  });
});
