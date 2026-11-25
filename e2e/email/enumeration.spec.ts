import { expect, test } from "../fixtures";
import { googleSignIn, hashesFor, linkIn, mailbox, waitForMail } from "../support/mail";
import { newUser, strongPassword } from "../support/users";

// Sign-up, sign-in and the other unauthenticated endpoints do not say which
// addresses have an account (docs/SIGNUP.md), against the Worker that sends mail.

const SAME_HEADERS = ["content-type", "access-control-allow-origin"];
const shape = async (res: import("@playwright/test").APIResponse) => ({
  status: res.status(),
  body: await res.json(),
  headers: Object.fromEntries(SAME_HEADERS.map((h) => [h, res.headers()[h] ?? null])),
  // a session cookie on one and not the other would be as good as a different body
  cookie: res.headers()["set-cookie"] ?? null,
});

test.describe("sign-up", () => {
  test("a new address and a taken one get the same status, body and headers, and neither is signed in", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const fresh = newUser("fresh");
    const a = await shape(await anon.post("/api/auth/register", { data: { email: fresh.email, password: fresh.password, name: fresh.name } }));
    const b = await shape(await anon.post("/api/auth/register", { data: { email: existing.user.email, password: strongPassword(), name: "Someone" } }));
    expect(a).toEqual(b);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ ok: true, confirm: "email" });
    expect(a.cookie).toBeNull();
    // no session either way
    expect((await anon.get("/api/auth/me").then((r) => r.json())).user).toBeNull();
    await anon.dispose();
  });

  test("the account is made for the new address and can sign in; the taken one is untouched", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const fresh = newUser("created");
    await anon.post("/api/auth/register", { data: { email: fresh.email, password: fresh.password, name: fresh.name } });
    expect((await anon.post("/api/auth/login", { data: { email: fresh.email, password: fresh.password } })).status()).toBe(200);

    const attacker = strongPassword();
    await anon.post("/api/auth/register", { data: { email: existing.user.email, password: attacker, name: "Not them" } });
    // the password the stranger chose does not work, and the owner's still does
    const bad = await anon.post("/api/auth/login", { data: { email: existing.user.email, password: attacker } });
    expect(bad.status()).toBe(401);
    const good = await anon.post("/api/auth/login", { data: { email: existing.user.email, password: existing.user.password } });
    expect(good.status()).toBe(200);
    expect((await good.json()).user.name).toBe(existing.user.name);
    await anon.dispose();
  });

  test("the address's owner is told by email, with a sign-in link and a reset link", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    await anon.post("/api/auth/register", { data: { email: existing.user.email, password: strongPassword(), name: "x" } });
    const msgs = await waitForMail(anon, existing.user.email, 2);
    const notice = msgs.find((m) => m.subject === "Someone tried to sign up with your email address")!;
    expect(notice).toBeTruthy();
    expect(notice.from).toBe("mindmaps@mail.example.test");
    expect(notice.text).toContain("already one");
    const links = [...notice.text.matchAll(/https?:\/\/\S+/g)].map((m) => new URL(m[0]).pathname);
    expect(links).toEqual(["/login", "/forgot-password"]);
    expect(notice.html).toContain('<html lang="en">');
    // it carries nothing about the person who asked, and no token
    expect(notice.text).not.toMatch(/token=/);
    await anon.dispose();
  });

  test("a new address gets its confirmation mail and no notice; the taken one's owner gets no confirmation link", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const fresh = newUser("mails");
    await anon.post("/api/auth/register", { data: { email: fresh.email, password: fresh.password, name: fresh.name } });
    const [only, ...more] = await waitForMail(anon, fresh.email);
    expect(more).toHaveLength(0);
    expect(only.subject).toBe("Confirm your email address");
    expect(linkIn(only).pathname).toBe("/verify-email");

    const before = (await mailbox(anon, existing.user.email)).length;
    await anon.post("/api/auth/register", { data: { email: existing.user.email, password: strongPassword(), name: "x" } });
    const after = await waitForMail(anon, existing.user.email, before + 1);
    expect(after.slice(before).map((m) => m.subject)).toEqual(["Someone tried to sign up with your email address"]);
    await anon.dispose();
  });

  test("case and spaces in the address make no difference", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const res = await anon.post("/api/auth/register", { data: { email: `  ${existing.user.email.toUpperCase()} `, password: strongPassword(), name: "x" } });
    expect(await shape(res)).toMatchObject({ status: 200, body: { ok: true, confirm: "email" } });
    await waitForMail(anon, existing.user.email, 2);
    await anon.dispose();
  });

  test("the notices to one address are limited, and the sign-up still answers the same", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    for (let i = 0; i < 5; i++) {
      const res = await anon.post("/api/auth/register", { data: { email: existing.user.email, password: strongPassword(), name: "x" } });
      expect(res.status()).toBe(200);
    }
    // its own confirmation, plus three notices and no more
    await waitForMail(anon, existing.user.email, 4);
    await new Promise((r) => setTimeout(r, 1500));
    const subjects = (await mailbox(anon, existing.user.email)).map((m) => m.subject);
    expect(subjects.filter((s) => s.startsWith("Someone tried"))).toHaveLength(3);
    await anon.dispose();
  });

  test("a bad address or a weak password is refused the same for both", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const weakTaken = await shape(await anon.post("/api/auth/register", { data: { email: existing.user.email, password: "short" } }));
    const weakNew = await shape(await anon.post("/api/auth/register", { data: { email: newUser().email, password: "short" } }));
    expect(weakTaken).toEqual(weakNew);
    expect(weakTaken.status).toBe(400);
    await anon.dispose();
  });

  test("a taken address costs the same password hash as a new one", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const fresh = newUser("hash-new");
    const base = await hashesFor(anon, existing.user.email);
    await anon.post("/api/auth/register", { data: { email: fresh.email, password: fresh.password } });
    await anon.post("/api/auth/register", { data: { email: existing.user.email, password: strongPassword() } });
    expect(await hashesFor(anon, fresh.email)).toBe(1);
    expect(await hashesFor(anon, existing.user.email)).toBe(base + 1);
    await anon.dispose();
  });
});

test.describe("sign-in", () => {
  test("an unknown address, a wrong password and a Google-only account all get the same answer", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const gmail = newUser("googler");
    await googleSignIn(anon, { email: gmail.email, sub: `sub-${gmail.email}` });
    const unknown = await shape(await anon.post("/api/auth/login", { data: { email: newUser("ghost").email, password: strongPassword() } }));
    const wrong = await shape(await anon.post("/api/auth/login", { data: { email: existing.user.email, password: strongPassword() } }));
    const googleOnly = await shape(await anon.post("/api/auth/login", { data: { email: gmail.email, password: strongPassword() } }));
    expect(unknown.status).toBe(401);
    expect(wrong).toEqual(unknown);
    expect(googleOnly).toEqual(unknown);
    await anon.dispose();
  });

  test("a missing account costs a password hash too, so it is not the quick answer", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const ghost = newUser("ghost-hash");
    await anon.post("/api/auth/login", { data: { email: ghost.email, password: strongPassword() } });
    expect(await hashesFor(anon, ghost.email)).toBe(1);
    await anon.dispose();
  });

  test("a locked-out address is told the same whether or not it has an account", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const ghost = newUser("ghost-lock");
    const last: Record<string, Awaited<ReturnType<typeof shape>>> = {};
    for (const [who, address] of [["real", existing.user.email], ["ghost", ghost.email]] as const) {
      for (let i = 0; i < 11; i++) last[who] = await shape(await anon.post("/api/auth/login", { data: { email: address, password: strongPassword() } }));
    }
    expect(last.real.status).toBe(429);
    expect(last.ghost).toEqual(last.real);
    await anon.dispose();
  });
});

test.describe("the other endpoints", () => {
  test("forgot-password answers the same for an unknown address and a known one", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const known = await shape(await anon.post("/api/auth/forgot-password", { data: { email: existing.user.email } }));
    const unknown = await shape(await anon.post("/api/auth/forgot-password", { data: { email: newUser("nobody").email } }));
    expect(known).toEqual(unknown);
    expect(known.status).toBe(200);
    await anon.dispose();
  });

  test("resend-verification says nothing to someone who is not signed in, whatever they send", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const known = await shape(await anon.post("/api/auth/resend-verification", { data: { email: existing.user.email } }));
    const unknown = await shape(await anon.post("/api/auth/resend-verification", { data: { email: newUser("nobody2").email } }));
    expect(known.status).toBe(401);
    expect(known).toEqual(unknown);
    await anon.dispose();
  });

  test("a reset or confirmation link that was never issued is refused the same way", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const token = "a".repeat(64);
    const reset = await anon.post("/api/auth/reset-password", { data: { token, password: strongPassword() } });
    const verify = await anon.post("/api/auth/verify-email", { data: { token } });
    expect(reset.status()).toBe(400);
    expect(verify.status()).toBe(400);
    expect((await reset.json()).error).toBe((await verify.json()).error);
    await anon.dispose();
  });
});

// The limits come before the hash: a request over a limit is refused without any
// password work being spent on it.
test.describe("rate limits come before the password hash", () => {
  const freshIp = () => `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

  test("sign-up over the client limit is refused without a hash", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-e2e-client-ip": freshIp() } });
    const users = Array.from({ length: 12 }, () => newUser("flood"));
    const statuses: number[] = [];
    for (const u of users) statuses.push((await anon.post("/api/auth/register", { data: { email: u.email, password: u.password } })).status());
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    const spent = await Promise.all(users.map((u) => hashesFor(anon, u.email)));
    expect(spent.slice(0, 10)).toEqual(Array(10).fill(1));
    expect(spent.slice(10)).toEqual([0, 0]);
    await anon.dispose();
  });

  test("sign-in over the address limit is refused without a hash", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const base = await hashesFor(anon, existing.user.email);
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) statuses.push((await anon.post("/api/auth/login", { data: { email: existing.user.email, password: strongPassword() } })).status());
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.slice(10)).toEqual([429, 429, 429]);
    // a hash for each of the ten attempts that were let through, none for the three that were not
    expect(await hashesFor(anon, existing.user.email)).toBe(base + 10);
    // and the right password is refused at the door too, with no hash
    expect((await anon.post("/api/auth/login", { data: { email: existing.user.email, password: existing.user.password } })).status()).toBe(429);
    expect(await hashesFor(anon, existing.user.email)).toBe(base + 10);
    await anon.dispose();
  });

  test("sign-in over the client limit is refused without a hash, for any address", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-e2e-client-ip": freshIp() } });
    const targets = Array.from({ length: 32 }, () => newUser("spray"));
    const statuses: number[] = [];
    for (const u of targets) statuses.push((await anon.post("/api/auth/login", { data: { email: u.email, password: strongPassword() } })).status());
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    expect(await hashesFor(anon, targets[31].email)).toBe(0);
    expect(await hashesFor(anon, targets[0].email)).toBe(1);
    await anon.dispose();
  });
});
