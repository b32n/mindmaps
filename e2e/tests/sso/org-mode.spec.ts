import { test, expect } from "@playwright/test";
import { PrivateWorker } from "../../support/private-worker";
import { createWorkspace, inviteRaw, listWorkspaces } from "../../support/api";
import { acceptInvite, pendingInvites } from "../../support/lifecycle";
import { createOrganisation, organisation, signUp } from "../../support/organisation";
import {
  addDomain, codeOf, enforceSso, join, joinOffers, newIdp, putPolicy, setUpSso, signUpAs, ssoSignIn, uniqueDomain, userOn, verifyDomain,
} from "../../support/sso";

// Org mode: the one organisation has the domains, policy and SSO; nothing else
// on the instance does. Each test has its own Worker because "the first
// account" needs an empty database.

test.describe("org mode", () => {
  let w: PrivateWorker;
  test.beforeEach(async () => {
    w = await new PrivateWorker({ signup: "closed" }).start();
    await w.restart("org");
  });
  test.afterEach(async () => w.dispose());

  async function setUp() {
    const domain = uniqueDomain("org");
    const owner = await w.client();
    const user = await signUpAs(owner, userOn(domain, "owner"));
    const created = await createOrganisation(owner, { name: "Acme" });
    expect(created.status(), await created.text()).toBe(201);
    const ws = ((await created.json()) as { id: string }).id;
    await verifyDomain(owner, ws, domain);
    const idp = await newIdp();
    await setUpSso(owner, ws, idp, user.email);
    return { domain, owner, user, ws, idp };
  }

  test("SSO makes an account for a person on the verified domain, which joins nothing; Join is a separate step", async () => {
    const o = await setUp();
    expect((await putPolicy(o.owner, o.ws, { auto_join: true, default_role: "viewer" })).status()).toBe(200);
    const email = userOn(o.domain, "newbie").email;
    await o.idp.control({ claims: { email } });
    const c = await w.client();
    const { end } = await ssoSignIn(c, email);
    expect(end?.location).toMatch(/\/app/);

    expect(await organisation(c)).toMatchObject({ mode: "org", state: "outside" });
    expect((await listWorkspaces(c)).some((x) => x.id === o.ws)).toBe(false);
    const offers = (await (await joinOffers(c)).json()) as { offers: { workspace_id: string }[] };
    expect(offers.offers.map((x) => x.workspace_id)).toEqual([o.ws]);
    expect((await join(c, o.ws)).status()).toBe(200);
    expect(await organisation(c)).toMatchObject({ state: "member", organisation: { workspace_id: o.ws, role: "viewer" } });
  });

  test("a password account on the domain is not offered Join; SSO accounts of other addresses are refused", async () => {
    const o = await setUp();
    await putPolicy(o.owner, o.ws, { auto_join: true });
    const mate = userOn(o.domain, "mate");
    await inviteRaw(o.owner, "workspaces", o.ws, mate.email, "viewer");
    const c = await w.client();
    await signUpAs(c, mate);
    // the invitation is the way in for a password account, and it is not Join
    expect(((await (await joinOffers(c)).json()) as { offers: unknown[]; unproven: boolean })).toEqual({ offers: [], unproven: true });
    expect(await codeOf(await join(c, o.ws))).toMatchObject({ status: 403, code: "email_unproven" });
  });

  test("enforce SSO: a member's password session is locked out of the organisation and told so", async () => {
    const o = await setUp();
    const mate = userOn(o.domain, "mate");
    const sent = await inviteRaw(o.owner, "workspaces", o.ws, mate.email, "editor");
    void sent;
    const c = await w.client();
    await signUpAs(c, mate);
    for (const i of await pendingInvites(c)) if (i.target_id === o.ws) expect((await acceptInvite(c, i.token)).status()).toBe(200);
    expect(await organisation(c)).toMatchObject({ state: "member" });

    expect((await enforceSso(o.owner, o.ws, true)).status()).toBe(200);
    const info = (await organisation(c)) as { state: string; sso_required?: boolean };
    expect(info).toMatchObject({ state: "member", sso_required: true });
    expect(await codeOf(await c.get(`/api/workspaces/${o.ws}/members`))).toEqual({ status: 403, code: "sso_required" });
    const ws = (await listWorkspaces(c)) as Array<{ id: string; sso_required?: boolean }>;
    expect(ws.find((x) => x.id === o.ws)?.sso_required).toBe(true);
  });

  test("only the organisation has any of it: another shared workspace on the instance is refused", async () => {
    // a workspace made before the instance was switched to org mode
    await w.restart(undefined);
    const owner = await w.client();
    await signUp(owner, "first");
    const team = await createWorkspace(owner, "Team");
    const labs = await createWorkspace(owner, "Labs");
    await w.restart("org");
    expect((await createOrganisation(owner, { workspace_id: team.id })).status()).toBe(201);

    expect(await codeOf(await addDomain(owner, labs.id, uniqueDomain("labs")))).toEqual({ status: 404, code: "not_an_organisation" });
    expect((await addDomain(owner, team.id, uniqueDomain("team"))).status()).toBe(201);
  });
});
