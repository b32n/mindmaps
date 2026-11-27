import { test, expect } from "../../fixtures";
import { createBoard, createNode, inviteRaw, listBoards, listWorkspaces } from "../../support/api";
import { exportZip } from "../../support/account";
import { jsonEntry } from "../../support/zip";
import { acceptInvite, pendingInvites } from "../../support/lifecycle";
import { connectMcp, consentPage } from "../../support/mcp";
import { modeWorkers } from "../../support/hosts";
import { codeOf, enforceSso, join, me, newOrg, putPolicy, security, ssoSession, userOn, type SsoOrg } from "../../support/sso";
import type { Person } from "../../fixtures";

// Enforce SSO: members whose address is on one of the organisation's verified
// domains reach that organisation only through its SSO. Everything else they
// have is unaffected, and so is everyone whose address is elsewhere. The owner
// keeps a way back (docs/SSO.md, "Break-glass").

test.use({ baseURL: modeWorkers.multitenant.baseURL });
const BASE = modeWorkers.multitenant.baseURL;

const SSO_REQUIRED = { status: 403, code: "sso_required" };

async function joinAs(org: SsoOrg, who: Person, role: "viewer" | "editor" = "editor") {
  const sent = await inviteRaw(org.owner.request, "workspaces", org.ws, who.user.email, role);
  void sent;
  for (const i of await pendingInvites(who.request)) if (i.target_id === org.ws) expect((await acceptInvite(who.request, i.token)).status()).toBe(200);
}

async function enforced(personOn: (d: string, l?: string) => Promise<Person>, makePerson: (l?: string) => Promise<Person>) {
  const org = await newOrg(personOn, { sso: true, enforce: false });
  const employee = await personOn(org.domain, "employee");
  const contractor = await makePerson("contractor"); // an address elsewhere
  await joinAs(org, employee);
  await joinAs(org, contractor);
  const board = await createBoard(org.owner.request, "Roadmap", { workspace_id: org.ws });
  const card = await createNode(org.owner.request, board.id, { type: "card", title: "Secret plan" });
  const mine = await createBoard(employee.request, "My own notes");
  return { org, employee, contractor, board, card, mine };
}

test.describe("with enforcement on", () => {
  test("a password session gets 403 sso_required for the organisation, and nothing else changes", async ({ personOn, makePerson }) => {
    const { org, employee, contractor, board, card, mine } = await enforced(personOn, makePerson);
    // the session existed before the switch: enforcement bites immediately
    expect((await employee.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    expect((await enforceSso(org.owner.request, org.ws, true)).status()).toBe(200);

    const e = employee.request;
    for (const [name, res] of [
      ["board contents", await e.get(`/api/boards/${board.id}/contents`)],
      ["board cards", await e.get(`/api/boards/${board.id}/cards`)],
      ["node", await e.get(`/api/nodes/${card.id}`)],
      ["write a node", await e.post("/api/nodes", { data: { board_id: board.id, type: "card", title: "x", x: 0, y: 0 } })],
      ["rename the board", await e.patch(`/api/boards/${board.id}`, { data: { name: "hacked" } })],
      ["edit the node", await e.patch(`/api/nodes/${card.id}`, { data: { title: "hacked" } })],
      ["delete the board", await e.delete(`/api/boards/${board.id}`)],
      ["create a board in it", await e.post("/api/boards", { data: { name: "new", workspace_id: org.ws } })],
      ["members", await e.get(`/api/workspaces/${org.ws}/members`)],
      ["invite", await e.post(`/api/workspaces/${org.ws}/members`, { data: { email: `x@${org.domain}`, role: "viewer" } })],
      ["security", await e.get(`/api/workspaces/${org.ws}/security`)],
    ] as const)
      expect(await codeOf(res), name).toEqual(SSO_REQUIRED);
    expect(((await (await e.get(`/api/boards/${board.id}/contents`)).json()) as { error: string }).error).toMatch(/single sign-on/i);

    // lists leave the organisation's mindmaps out, and say the workspace is locked
    const seen = await listBoards(e);
    expect(seen.map((b) => b.id)).toContain(mine.id);
    expect(seen.map((b) => b.id)).not.toContain(board.id);
    const ws = (await listWorkspaces(e)) as Array<{ id: string; sso_required?: boolean }>;
    expect(ws.find((w) => w.id === org.ws)?.sso_required).toBe(true);
    expect(ws.filter((w) => w.id !== org.ws).every((w) => !w.sso_required)).toBe(true);
    expect((await e.get("/api/artefacts")).status()).toBe(200);
    const recall = (await (await e.get("/api/recall?q=secret")).json()) as { hits: { title?: string }[] };
    expect(JSON.stringify(recall)).not.toContain("Secret plan");

    // their own things, in the same session, are untouched
    expect((await e.get(`/api/boards/${mine.id}/contents`)).status()).toBe(200);
    expect((await e.patch(`/api/boards/${mine.id}`, { data: { name: "still mine" } })).status()).toBe(200);

    // the contractor's address is elsewhere: not subject to the rule
    expect((await contractor.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    // and the organisation's data did not change
    // (the owner's password session is locked out of content too: only settings stay reachable, so lift the switch to look)
    expect((await enforceSso(org.owner.request, org.ws, false)).status()).toBe(200);
    expect((await org.owner.request.get(`/api/nodes/${card.id}`).then((r) => r.json())).title).toBe("Secret plan");
  });

  test("the same person through SSO has full access", async ({ personOn, makePerson }) => {
    const { org, employee, board, card } = await enforced(personOn, makePerson);
    await enforceSso(org.owner.request, org.ws, true);
    const s = await ssoSession(BASE, employee.user.email);
    expect((await me(s)).user!.id).toBe((await me(employee.request)).user!.id);
    expect((await s.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    expect((await s.patch(`/api/nodes/${card.id}`, { data: { title: "edited via sso" } })).status()).toBe(200);
    expect((await listBoards(s)).some((b) => b.id === board.id)).toBe(true);
    expect(((await listWorkspaces(s)) as Array<{ sso_required?: boolean }>).every((w) => !w.sso_required)).toBe(true);
    // and the password session next to it is still locked out
    expect(await codeOf(await employee.request.get(`/api/boards/${board.id}/contents`))).toEqual(SSO_REQUIRED);
  });

  test("another organisation's SSO session does not satisfy this one", async ({ personOn, makePerson }) => {
    const { org, employee, board } = await enforced(personOn, makePerson);
    await enforceSso(org.owner.request, org.ws, true);
    const other = await newOrg(personOn, { sso: true, name: "Other" });
    // a session proven through the other organisation (for an address on the other's domain) carries no proof for this one
    const s = await ssoSession(BASE, userOn(other.domain, "x").email);
    expect((await s.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
    void employee;
  });

  test("switching it off gives the password session its access back", async ({ personOn, makePerson }) => {
    const { org, employee, board } = await enforced(personOn, makePerson);
    await enforceSso(org.owner.request, org.ws, true);
    expect(await codeOf(await employee.request.get(`/api/boards/${board.id}/contents`))).toEqual(SSO_REQUIRED);
    await enforceSso(org.owner.request, org.ws, false);
    expect((await employee.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
  });

  test("a mindmap shared straight to a domain member is the organisation's too", async ({ personOn, makePerson }) => {
    const org = await newOrg(personOn, { sso: true });
    const guest = await personOn(org.domain, "guest");
    const board = await createBoard(org.owner.request, "Shared", { workspace_id: org.ws });
    expect((await org.owner.request.post(`/api/boards/${board.id}/members`, { data: { email: guest.user.email, role: "viewer" } })).status()).toBe(201);
    expect((await guest.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    await enforceSso(org.owner.request, org.ws, true);
    expect(await codeOf(await guest.request.get(`/api/boards/${board.id}/contents`))).toEqual(SSO_REQUIRED);
    void makePerson;
  });

  test("joining by auto-join needs SSO too", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await putPolicy(org.owner.request, org.ws, { auto_join: true });
    const pw = await personOn(org.domain, "pw");
    await enforceSso(org.owner.request, org.ws, true);
    expect(await codeOf(await join(pw.request, org.ws))).toEqual(SSO_REQUIRED);
    const s = await ssoSession(BASE, pw.user.email);
    expect((await join(s, org.ws)).status()).toBe(200);
  });

  test("accepting an invitation to it needs SSO for a member of the domain", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    const pw = await personOn(org.domain, "invitee");
    const sent = await inviteRaw(org.owner.request, "workspaces", org.ws, pw.user.email, "editor");
    await enforceSso(org.owner.request, org.ws, true);
    expect(await codeOf(await acceptInvite(pw.request, sent.invited!.token))).toEqual(SSO_REQUIRED);
    const s = await ssoSession(BASE, pw.user.email);
    expect((await acceptInvite(s, sent.invited!.token)).status()).toBe(200);
  });

  test("a person whose domain the organisation does not hold is never affected, whatever their role", async ({ personOn, makePerson }) => {
    const { org, contractor, board } = await enforced(personOn, makePerson);
    await enforceSso(org.owner.request, org.ws, true);
    expect((await contractor.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    expect((await listWorkspaces(contractor.request)).find((w) => w.id === org.ws)).toBeTruthy();
  });

  test("removing the domain lifts enforcement for it", async ({ personOn, makePerson }) => {
    const { org, employee, board } = await enforced(personOn, makePerson);
    await enforceSso(org.owner.request, org.ws, true);
    const sec = (await (await security(org.owner.request, org.ws)).json()) as { domains: { id: string }[] };
    expect((await org.owner.request.delete(`/api/workspaces/${org.ws}/domains/${sec.domains[0]!.id}`)).status()).toBe(200);
    expect((await employee.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
  });

  test("account export from a locked session leaves the organisation out", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await createBoard(org.owner.request, "Org plans", { workspace_id: org.ws });
    expect(JSON.stringify(jsonEntry((await exportZip(org.owner.request)).zip, "workspaces.json"))).toContain("Acme");
    await enforceSso(org.owner.request, org.ws, true);
    const locked = await exportZip(org.owner.request);
    expect(JSON.stringify(jsonEntry(locked.zip, "workspaces.json"))).not.toContain("Acme");
    expect(JSON.stringify(jsonEntry(locked.zip, "mindmaps.json"))).not.toContain("Org plans");
  });
});

test.describe("break-glass: the owner", () => {
  test("an owner on the domain, locked out of content by a broken IdP, can still reach the settings and switch enforcement off", async ({ personOn, makePerson }) => {
    const { org, board } = await enforced(personOn, makePerson);
    await enforceSso(org.owner.request, org.ws, true);
    // content: locked, as for anyone on the domain
    expect(await codeOf(await org.owner.request.get(`/api/boards/${board.id}/contents`))).toEqual(SSO_REQUIRED);
    // settings: open, from the password session
    const sec = await security(org.owner.request, org.ws);
    expect(sec.status()).toBe(200);
    expect(((await sec.json()) as { policy: { enforce_sso: boolean } }).policy.enforce_sso).toBe(true);
    expect((await enforceSso(org.owner.request, org.ws, false)).status()).toBe(200);
    expect((await org.owner.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
  });

  test("an admin on the domain has no such path: the settings are locked for them too", async ({ personOn, makePerson }) => {
    const { org, employee } = await enforced(personOn, makePerson);
    const id = (await me(employee.request)).user!.id;
    await org.owner.request.patch(`/api/workspaces/${org.ws}/members/${id}`, { data: { role: "admin" } });
    expect((await security(employee.request, org.ws)).status()).toBe(200);
    await enforceSso(org.owner.request, org.ws, true);
    expect(await codeOf(await security(employee.request, org.ws))).toEqual(SSO_REQUIRED);
    expect(await codeOf(await putPolicy(employee.request, org.ws, { auto_join: false }))).toEqual(SSO_REQUIRED);
  });

  test("an owner whose address is on no verified domain is never subject to it", async ({ personOn, makePerson }) => {
    const owner = await makePerson("outside-owner");
    const created = await owner.request.post("/api/organisation", { data: { name: "Acme" } });
    const ws = ((await created.json()) as { id: string }).id;
    // someone else's organisation enforces SSO on its own domain; this owner is not on it
    await newOrg(personOn, { sso: true, enforce: true });
    const board = await createBoard(owner.request, "Mine", { workspace_id: ws });
    expect((await owner.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
  });
});

test.describe("MCP", () => {
  test("consent for the organisation's workspace is refused to a password session, and the page does not offer it", async ({ personOn, makePerson }) => {
    const { org, employee } = await enforced(personOn, makePerson);
    await enforceSso(org.owner.request, org.ws, true);

    const page = await consentPage(employee.request);
    expect(page).not.toContain(`value="${org.ws}"`);
    expect(page).toMatch(/single sign-on/i);

    // a tampered form aimed at it is refused, nothing is issued
    const reg = await employee.request.post("/oauth/register", { data: { client_name: "e2e", redirect_uris: ["http://127.0.0.1:9/callback"] } });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: "http://127.0.0.1:9/callback", response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" });
    const res = await employee.request.post(`/oauth/authorize?${q}`, { maxRedirects: 0, form: { workspace: org.ws } });
    expect(res.status()).toBe(403);
    expect(await res.text()).toMatch(/single sign-on/i);
  });

  test("a connection made through SSO can use the organisation; one made from a password session cannot reach it", async ({ personOn, makePerson }) => {
    const { org, employee } = await enforced(personOn, makePerson);
    await enforceSso(org.owner.request, org.ws, true);

    const viaPassword = await connectMcp(employee.request);
    const listed = await viaPassword.call("list_mindmaps", { workspace: org.ws });
    expect(listed.text).not.toContain("Roadmap");
    expect(listed.isError || /single sign-on|workspace/i.test(listed.text)).toBe(true);
    expect((await viaPassword.call("recall", { query: "Secret plan" })).text).not.toContain("Roadmap");

    const s = await ssoSession(BASE, employee.user.email);
    const viaSso = await connectMcp(s, { workspace: org.ws });
    const ok = await viaSso.call("list_mindmaps", {});
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.text).toContain("Roadmap");
    // the proof survives a refresh
    const again = await viaSso.refresh();
    expect((await again.call("list_mindmaps", {})).text).toContain("Roadmap");
  });

  test("a connection made before enforcement is locked out of the organisation the moment it is switched on", async ({ personOn, makePerson }) => {
    const { org, employee } = await enforced(personOn, makePerson);
    const agent = await connectMcp(employee.request, { workspace: org.ws });
    expect((await agent.call("list_mindmaps", {})).text).toContain("Roadmap");
    await enforceSso(org.owner.request, org.ws, true);
    const after = await agent.call("list_mindmaps", {});
    expect(after.text).not.toContain("Roadmap");
    await enforceSso(org.owner.request, org.ws, false);
    expect((await agent.call("list_mindmaps", {})).text).toContain("Roadmap");
  });
});

test.describe("what is not affected", () => {
  test("nothing changes for an organisation that does not enforce", async ({ personOn, makePerson }) => {
    const { employee, board, org } = await enforced(personOn, makePerson);
    expect((await employee.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    const ws = (await listWorkspaces(employee.request)) as Array<{ id: string; sso_required?: boolean }>;
    expect(ws.find((w) => w.id === org.ws)?.sso_required).toBeFalsy();
    expect(((await (await employee.request.get("/api/organisation")).json()) as { sso_required?: boolean }).sso_required).toBeFalsy();
  });
});
