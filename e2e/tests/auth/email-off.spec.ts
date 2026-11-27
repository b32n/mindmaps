import { expect, test } from "../../fixtures";
import { addMember, createWorkspace, listWorkspaces } from "../../support/api";
import { signUpViaForm } from "../../support/auth";
import { newUser, strongPassword } from "../../support/users";

// The main test Worker has no MAIL_FROM: email is not configured. The app must
// work exactly as it did, and the flows that need mail must say so rather than
// fail (docs/EMAIL.md, "Without email").

test("the session endpoint says email is off", async ({ request, account }) => {
  expect(account).toBeTruthy();
  const out = await (await request.get("/api/auth/me")).json();
  expect(out.emailEnabled).toBe(false);
  expect(out.emailVerified).toBe(false); // nothing could ever verify it
});

test("sign-up works and sends nothing", async ({ page }) => {
  const u = newUser("off");
  await signUpViaForm(page, u);
  await expect(page).toHaveURL(/\/app\//);
});

test("forgot-password and resend say email is not set up, with a stable code", async ({ request, account }) => {
  const forgot = await request.post("/api/auth/forgot-password", { data: { email: account.email } });
  expect(forgot.status()).toBe(501);
  const body = await forgot.json();
  expect(body.code).toBe("email_unconfigured");
  expect(body.error).toContain("can't send email");

  const unknown = await request.post("/api/auth/forgot-password", { data: { email: newUser("x").email } });
  expect(unknown.status()).toBe(501);
  expect(await unknown.json()).toEqual(body);

  const resend = await request.post("/api/auth/resend-verification");
  expect(resend.status()).toBe(501);
  expect((await resend.json()).code).toBe("email_unconfigured");
});

test("reset and verify links are refused, not crashes", async ({ request }) => {
  const tok = "a".repeat(64);
  expect((await request.post("/api/auth/reset-password", { data: { token: tok, password: strongPassword() } })).status()).toBe(400);
  expect((await request.post("/api/auth/verify-email", { data: { token: tok } })).status()).toBe(400);
});

test("the capture endpoint does not exist on a real configuration", async ({ request }) => {
  expect((await request.get("/api/_mail?to=a@b.test")).status()).toBe(404);
});

test("invites are claimed as they always were: with no way to verify, nobody is held back", async ({ account, request, makePerson, playwright, baseURL }) => {
  expect(account).toBeTruthy();
  const ws = await createWorkspace(request, "Team");
  const person = await makePerson("known");
  expect((await addMember(request, "workspaces", ws.id, person.user.email)).added).toBeTruthy();

  const later = newUser("later");
  const invited = await addMember(request, "workspaces", ws.id, later.email);
  expect(invited.invited).toBeTruthy();
  const c = await playwright.request.newContext({ baseURL });
  await c.post("/api/auth/register", { data: { email: later.email, password: later.password, name: later.name } });
  // with no way to verify, the invitation is listed straight away and accepting it works
  expect((await listWorkspaces(c)).map((w) => w.id)).not.toContain(ws.id);
  const pending = ((await (await c.get("/api/invites")).json()) as { invites: { token: string }[] }).invites;
  expect(pending.map((i) => i.token)).toEqual([invited.invited!.token]);
  expect((await c.post(`/api/invites/${invited.invited!.token}/accept`)).status()).toBe(200);
  expect((await listWorkspaces(c)).map((w) => w.id)).toContain(ws.id);
  await c.dispose();
});

test("existing accounts are not rate limited without a client address, and sign-in still works", async ({ existing, request }) => {
  expect((await request.post("/api/auth/login", { data: { email: existing.user.email, password: existing.user.password } })).status()).toBe(200);
});
