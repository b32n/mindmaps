import { test, expect } from "../../fixtures";
import { acceptInvite, pendingInvites } from "../../support/lifecycle";
import { openWorkspacePeople } from "../../support/members";
import { modeWorkers } from "../../support/hosts";
import {
  dns, enforceSso, newIdp, newOrg, putPolicy, recordName, security, ssoSession, uniqueDomain, type Security,
} from "../../support/sso";

// The organisation settings (Domains, Policy, Single sign-on), the Join banner
// and the "Continue with SSO" entry on the login page.

test.use({ baseURL: modeWorkers.multitenant.baseURL });
const BASE = modeWorkers.multitenant.baseURL;

async function invite(org: { owner: { request: import("@playwright/test").APIRequestContext }; ws: string }, p: { user: { email: string }; request: import("@playwright/test").APIRequestContext }, role: string) {
  const sent = await org.owner.request.post(`/api/workspaces/${org.ws}/members`, { data: { email: p.user.email, role: "editor" } });
  expect(sent.status(), await sent.text()).toBeLessThan(300);
  for (const i of await pendingInvites(p.request)) if (i.target_id === org.ws) expect((await acceptInvite(p.request, i.token)).status()).toBe(200);
  if (role === "admin") {
    const id = ((await (await p.request.get("/api/auth/me")).json()) as { user: { id: string } }).user.id;
    const up = await org.owner.request.patch(`/api/workspaces/${org.ws}/members/${id}`, { data: { role } });
    expect(up.status(), await up.text()).toBe(200);
  }
}

const state = async (org: { owner: { request: import("@playwright/test").APIRequestContext }; ws: string }) =>
  (await (await security(org.owner.request, org.ws)).json()) as Security;

test.describe("settings", () => {
  test("domains: add, see the record, fail to verify, publish it, verify, remove", async ({ personOn, openAs }) => {
    const org = await newOrg(personOn, { name: "Initech" });
    const domain = uniqueDomain("ui");
    const page = await openAs(org.owner);
    await page.goto("/app");
    const { dialog } = await openWorkspacePeople(page, "Initech");

    await dialog.getByLabel("Domain", { exact: true }).fill(domain);
    await dialog.getByRole("button", { name: "Add domain" }).click();
    const row = dialog.locator(`[data-domain="${domain}"]`);
    await expect(row).toContainText("Not verified yet");
    await expect(row).toContainText(recordName(domain));
    await expect(row).toContainText("mindmaps-verify=");

    await row.getByRole("button", { name: `Verify ${domain}` }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(row).toContainText("Not verified yet");

    const pending = (await state(org)).domains.find((d) => d.domain === domain)!;
    await dns.setTxt(pending.record!.name, pending.record!.value);
    await row.getByRole("button", { name: `Verify ${domain}` }).click();
    await expect(row).toContainText("Verified");
    expect((await state(org)).domains.find((d) => d.domain === domain)?.status).toBe("verified");

    await row.getByRole("button", { name: `Remove ${domain}` }).click();
    await expect(row).toHaveCount(0);
    expect((await state(org)).domains.find((d) => d.domain === domain)).toBeUndefined();
  });

  test("policy: auto-join, default role and restricting invites are saved", async ({ personOn, openAs }) => {
    const org = await newOrg(personOn, { name: "Hooli" });
    const page = await openAs(org.owner);
    await page.goto("/app");
    const { dialog } = await openWorkspacePeople(page, "Hooli");

    await dialog.getByLabel("Let people with an address on a verified domain join").click();
    await expect.poll(async () => (await state(org)).policy.auto_join).toBe(true);
    await dialog.getByLabel("Joins as").selectOption("editor");
    await expect.poll(async () => (await state(org)).policy.default_role).toBe("editor");
    await dialog.getByLabel("Only invite people on a verified domain").click();
    await expect.poll(async () => (await state(org)).policy.restrict_invites).toBe(true);
    await dialog.getByLabel("Only invite people on a verified domain").click();
    await expect.poll(async () => (await state(org)).policy.restrict_invites).toBe(false);
  });

  test("single sign-on: configure, test through the provider, turn on, require; the secret is never shown", async ({ personOn, openAs }) => {
    const org = await newOrg(personOn, { name: "Umbrella" });
    const idp = await newIdp();
    await idp.control({ claims: { email: org.owner.user.email } });
    const page = await openAs(org.owner);
    await page.goto("/app");
    let { dialog } = await openWorkspacePeople(page, "Umbrella");

    await expect(dialog.getByTestId("sso-status")).toContainText("Not configured");
    await expect(dialog.getByRole("button", { name: "Test", exact: true })).toBeDisabled();
    await dialog.getByLabel("Issuer").fill(idp.issuer);
    await dialog.getByLabel("Client ID").fill(idp.clientId);
    await dialog.getByLabel("Client secret").fill(idp.clientSecret);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByTestId("sso-status")).toContainText("Saved, not tested");
    await expect(dialog.getByLabel("Client secret")).toHaveValue("");
    expect(await dialog.innerHTML()).not.toContain(idp.clientSecret);
    expect(JSON.stringify(await state(org))).not.toContain(idp.clientSecret);
    await expect(dialog.getByLabel("Turn SSO on")).toBeDisabled();

    await dialog.getByRole("button", { name: "Test", exact: true }).click();
    await page.waitForURL(/\/app/);
    await expect(page.getByRole("status")).toContainText("SSO test passed");
    expect(page.url()).not.toContain("sso_test");

    ({ dialog } = await openWorkspacePeople(page, "Umbrella"));
    await expect(dialog.getByTestId("sso-status")).toContainText("Tested");
    await dialog.getByLabel("Turn SSO on").click();
    await expect(dialog.getByTestId("sso-status")).toHaveText("On.");
    await dialog.getByLabel("Require SSO for people on a verified domain").click();
    await expect.poll(async () => (await state(org)).policy.enforce_sso).toBe(true);
  });

  test("an admin sees domains and policy but not single sign-on; an editor sees none of it", async ({ personOn, openAs }) => {
    const org = await newOrg(personOn, { name: "Soylent" });
    const admin = await personOn(org.domain, "admin");
    const editor = await personOn(org.domain, "editor");
    for (const [p, role] of [[admin, "admin"], [editor, "editor"]] as const) {
      await invite(org, p, role);
    }
    const a = await openAs(admin);
    await a.goto("/app");
    const { dialog } = await openWorkspacePeople(a, "Soylent");
    await expect(dialog.getByRole("heading", { name: "Domains" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Policy" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Single sign-on" })).toHaveCount(0);

    const e = await openAs(editor);
    await e.goto("/app");
    await e.locator(".ws-trigger").click();
    await expect(e.getByRole("menuitem", { name: /Soylent/ }).locator(".ws-item-people")).toHaveCount(0);
  });
});

test.describe("Join banner", () => {
  test("a person whose address is proven is offered Join, and joining is a click", async ({ personOn, openAs }) => {
    const org = await newOrg(personOn, { sso: true, name: "Globex" });
    await putPolicy(org.owner.request, org.ws, { auto_join: true, default_role: "viewer" });
    const mate = `mate-${Date.now()}@${org.domain}`;
    const r = await ssoSession(BASE, mate);
    const page = await openAs({ request: r, user: { email: mate, password: "", name: "" } } as never);
    await page.goto("/app");
    const banner = page.getByRole("region", { name: "Join your organisation" });
    await expect(banner).toContainText("Globex");
    await banner.getByRole("button", { name: "Join Globex" }).click();
    await expect(banner).toHaveCount(0);
    await page.locator(".ws-trigger").click();
    await expect(page.getByRole("menuitem", { name: /Globex/ })).toBeVisible();
  });

  test("a password-only address is told to prove it, and is not offered Join", async ({ personOn, openAs }) => {
    const org = await newOrg(personOn, { name: "Wayne" });
    await putPolicy(org.owner.request, org.ws, { auto_join: true });
    const joiner = await personOn(org.domain, "joiner");
    const page = await openAs(joiner);
    await page.goto("/app");
    const banner = page.getByRole("region", { name: "Join your organisation" });
    await expect(banner).toContainText("prove it");
    await expect(banner.getByRole("button", { name: /Join/ })).toHaveCount(0);
  });

  test("nobody sees it when the organisation has no auto-join", async ({ personOn, openAs }) => {
    const org = await newOrg(personOn, { sso: true, name: "Stark" });
    const joiner = await personOn(org.domain, "joiner");
    const page = await openAs(joiner);
    await page.goto("/app");
    await expect(page.locator(".rail-brand")).toBeVisible();
    await expect(page.getByRole("region", { name: "Join your organisation" })).toHaveCount(0);
  });
});

test.describe("login page", () => {
  test("Continue with SSO takes the email and signs in through the provider", async ({ page, personOn }) => {
    const org = await newOrg(personOn, { sso: true, name: "Cyberdyne" });
    const email = `sso-ui-${Date.now()}@${org.domain}`;
    await org.idp.control({ claims: { email } });
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with SSO", exact: true }).click();
    await expect(page.locator(".auth-error")).toContainText("work email");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue with SSO", exact: true }).click();
    await page.waitForURL(/\/app/);
    expect(((await (await page.request.get("/api/auth/me")).json()) as { user: { email: string } }).user.email).toBe(email);
  });

  test("an address with no organisation says so", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(`nobody@${uniqueDomain("none")}`);
    await page.getByRole("button", { name: "Continue with SSO", exact: true }).click();
    await expect(page.locator(".auth-error")).toBeVisible();
  });

  test("a personal install does not offer it, and shows no settings", async ({ page }) => {
    await page.goto(`${modeWorkers.personal.baseURL}/login`);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with SSO", exact: true })).toHaveCount(0);
  });
});

test.describe("locked organisation", () => {
  test("a password session is told the organisation requires SSO", async ({ personOn, openAs }) => {
    const org = await newOrg(personOn, { sso: true, name: "Oscorp" });
    const person = await personOn(org.domain, "staff");
    // join through an invitation accepted before the lock: it is not content
    await invite(org, person, "editor");
    expect((await enforceSso(org.owner.request, org.ws, true)).status()).toBe(200);
    const page = await openAs(person);
    await page.goto("/app");
    const notice = page.getByRole("region", { name: "Single sign-on required" });
    await expect(notice).toContainText("Oscorp");
    await expect(notice.getByRole("button", { name: "Sign in with SSO" })).toBeVisible();
  });
});
