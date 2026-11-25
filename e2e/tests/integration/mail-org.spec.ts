import { test, expect } from "@playwright/test";
import { PrivateWorker } from "../../support/private-worker";
import { inviteRaw, listWorkspaces } from "../../support/api";
import { tokenIn, waitForMail } from "../../support/mail";
import { createOrganisation, organisation, signUp } from "../../support/organisation";
import { newUser } from "../../support/users";

// Outbound email (docs/EMAIL.md, SIGNUP.md) on an instance with an organisation
// (docs/MODES.md, SSO.md): sign-up answers every address alike, the first
// account is still decided by the insert, and an invitation can be accepted
// only once the address is confirmed.

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
