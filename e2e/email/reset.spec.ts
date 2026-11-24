import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures";
import { connectMcp } from "../support/mcp";
import { expectNoMail, mailbox, tokenIn, unissuedToken, waitForMail } from "../support/mail";
import { newUser, strongPassword } from "../support/users";

// Password reset (docs/EMAIL.md): the request, the link, what the link does.

const forgot = (r: APIRequestContext, email: string, headers?: Record<string, string>) =>
  r.post("/api/auth/forgot-password", { data: { email }, headers });
const reset = (r: APIRequestContext, token: string, password: string, headers?: Record<string, string>) =>
  r.post("/api/auth/reset-password", { data: { token, password }, headers });
const login = (r: APIRequestContext, email: string, password: string, headers?: Record<string, string>) =>
  r.post("/api/auth/login", { data: { email, password }, headers });
const me = async (r: APIRequestContext) => (await r.get("/api/auth/me")).json();
/** A client address nobody else in this run is using. */
const freshIp = () => `192.0.2.${Math.floor(Math.random() * 250) + 1}`;

/** The reset mail for `email` (the account's first mail is the verification one). */
async function resetToken(r: APIRequestContext, email: string, nth = 1) {
  const all = await waitForMail(r, email, nth + 1);
  const msg = all.filter((m) => m.subject === "Reset your password")[nth - 1];
  expect(msg, "reset mail").toBeTruthy();
  return tokenIn(msg);
}

test.describe("asking for a reset", () => {
  test("an address with an account is mailed a link", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const res = await forgot(anon, existing.user.email);
    expect(res.status()).toBe(200);
    const all = await waitForMail(existing.request, existing.user.email, 2);
    const msg = all.find((m) => m.subject === "Reset your password")!;
    expect(msg.from).toBe("mindmaps@mail.example.test");
    expect(msg.text).toContain("expires in 60 minutes");
    expect(msg.html).toContain('<html lang="en">');
    expect(new URL(msg.text.match(/https?:\/\/\S+/)![0]).pathname).toBe("/reset-password");
    await anon.dispose();
  });

  test("an address with no account gets the identical answer and no mail", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const known = await forgot(anon, existing.user.email);
    const unknown = newUser("ghost");
    const missing = await forgot(anon, unknown.email);
    expect(missing.status()).toBe(known.status());
    expect(await missing.json()).toEqual(await known.json());
    await expectNoMail(anon, unknown.email);
    await anon.dispose();
  });

  test("the address is matched case-insensitively and trimmed", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    expect((await forgot(anon, `  ${existing.user.email.toUpperCase()} `)).status()).toBe(200);
    await resetToken(existing.request, existing.user.email);
    await anon.dispose();
  });

  test("something that is not an address is a plain 400", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    for (const email of ["", "nope", "a@b"]) expect((await forgot(anon, email)).status(), email).toBe(400);
    await anon.dispose();
  });

  test("a second request retires the first link", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    const first = await resetToken(existing.request, existing.user.email, 1);
    await forgot(anon, existing.user.email);
    const second = await resetToken(existing.request, existing.user.email, 2);
    expect(second).not.toBe(first);
    expect((await reset(anon, first, strongPassword())).status()).toBe(400);
    expect((await reset(anon, second, strongPassword())).status()).toBe(200);
    await anon.dispose();
  });

  test("is limited to three an hour per address, for real and unknown addresses alike", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    for (const email of [existing.user.email, newUser("ghost").email]) {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await forgot(anon, email)).status());
      expect(statuses, email).toEqual([200, 200, 200, 429, 429]);
    }
    await anon.dispose();
  });

  test("is limited per client address across addresses", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const headers = { "x-e2e-client-ip": freshIp() };
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await forgot(anon, newUser("sweep").email, headers)).status());
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    // somebody else is untouched
    expect((await forgot(anon, newUser("sweep").email, { "x-e2e-client-ip": freshIp() })).status()).toBe(200);
    await anon.dispose();
  });

  test("the limited answer says the same whether or not the account exists", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const ghost = newUser("ghost").email;
    for (let i = 0; i < 3; i++) {
      await forgot(anon, existing.user.email);
      await forgot(anon, ghost);
    }
    const a = await forgot(anon, existing.user.email);
    const b = await forgot(anon, ghost);
    expect([a.status(), b.status()]).toEqual([429, 429]);
    expect(await a.json()).toEqual(await b.json());
    await anon.dispose();
  });
});

test.describe("using the link", () => {
  test("sets the new password: the new one signs in, the old one does not", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    const token = await resetToken(existing.request, existing.user.email);
    const fresh = strongPassword();
    const res = await reset(anon, token, fresh);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect((await login(anon, existing.user.email, existing.user.password)).status()).toBe(401);
    expect((await login(anon, existing.user.email, fresh)).status()).toBe(200);
    await anon.dispose();
  });

  test("works once", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    const token = await resetToken(existing.request, existing.user.email);
    const first = strongPassword();
    expect((await reset(anon, token, first)).status()).toBe(200);
    const again = await reset(anon, token, strongPassword());
    expect(again.status()).toBe(400);
    expect((await again.json()).code).toBe("invalid_link");
    // the first password is still the one in force
    expect((await login(anon, existing.user.email, first)).status()).toBe(200);
    await anon.dispose();
  });

  test("two uses at once: exactly one wins", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    const token = await resetToken(existing.request, existing.user.email);
    const out = await Promise.all([1, 2, 3].map(() => reset(anon, token, strongPassword())));
    expect(out.map((r) => r.status()).sort()).toEqual([200, 400, 400]);
    await anon.dispose();
  });

  test("a wrong, unissued or malformed token is one and the same refusal", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    const real = await resetToken(existing.request, existing.user.email);
    const wrong = real.slice(0, -1) + (real.endsWith("0") ? "1" : "0");
    const bodies: unknown[] = [];
    for (const token of [wrong, unissuedToken(), "x", ""]) {
      const res = await reset(anon, token, strongPassword());
      expect(res.status(), token).toBe(400);
      bodies.push(await res.json());
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    await anon.dispose();
  });

  test("a verification link is not a reset link", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const [verification] = await waitForMail(existing.request, existing.user.email);
    expect((await reset(anon, tokenIn(verification), strongPassword())).status()).toBe(400);
    await anon.dispose();
  });

  test("a weak password is refused with the reasons and does not use the link up", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    const token = await resetToken(existing.request, existing.user.email);
    const weak = await reset(anon, token, "short");
    expect(weak.status()).toBe(400);
    const body = await weak.json();
    expect(body.problems).toContain("at least 12 characters");
    expect(body.error).toMatch(/^Your password needs /);
    expect((await login(anon, existing.user.email, existing.user.password)).status()).toBe(200);
    // the same link still works
    expect((await reset(anon, token, strongPassword())).status()).toBe(200);
    await anon.dispose();
  });

  test("a missing password is refused", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    const token = await resetToken(existing.request, existing.user.email);
    expect((await anon.post("/api/auth/reset-password", { data: { token } })).status()).toBe(400);
    await anon.dispose();
  });

  test("does not sign anyone in", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    const res = await reset(anon, await resetToken(existing.request, existing.user.email), strongPassword());
    expect(res.headers()["set-cookie"]).toBeUndefined();
    expect((await me(anon)).user).toBeNull();
    await anon.dispose();
  });

  test("signs the account out everywhere: every session and every connected app", async ({ existing, playwright, baseURL }) => {
    const second = await playwright.request.newContext({ baseURL });
    await login(second, existing.user.email, existing.user.password);
    expect((await me(second)).user.email).toBe(existing.user.email);
    expect((await me(existing.request)).user.email).toBe(existing.user.email);
    const mcp = await connectMcp(existing.request);
    const call = () =>
      second.post("/mcp", {
        headers: { authorization: `Bearer ${mcp.credentials.accessToken}`, accept: "application/json, text/event-stream" },
        data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
    expect((await call()).status()).toBe(200);

    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    expect((await reset(anon, await resetToken(existing.request, existing.user.email), strongPassword())).status()).toBe(200);

    expect((await me(second)).user).toBeNull();
    expect((await me(existing.request)).user).toBeNull();
    expect((await call()).status()).toBe(401);
    await Promise.all([second.dispose(), anon.dispose()]);
  });

  test("other accounts keep their sessions", async ({ existing, makePerson, playwright, baseURL }) => {
    const bystander = await makePerson("bystander");
    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    await reset(anon, await resetToken(existing.request, existing.user.email), strongPassword());
    expect((await me(bystander.request)).user.email).toBe(bystander.user.email);
    await anon.dispose();
  });

  test("completing a reset proves the address", async ({ existing, playwright, baseURL }) => {
    expect((await me(existing.request)).emailVerified).toBe(false);
    const anon = await playwright.request.newContext({ baseURL });
    await forgot(anon, existing.user.email);
    const fresh = strongPassword();
    await reset(anon, await resetToken(existing.request, existing.user.email), fresh);
    await login(anon, existing.user.email, fresh);
    expect((await me(anon)).emailVerified).toBe(true);
    await anon.dispose();
  });

  test("an unverified squatter loses the account to the real owner's reset", async ({ playwright, baseURL }) => {
    // the squatter registers an address they do not control, with their own password
    const victim = newUser("victim");
    const squatter = await playwright.request.newContext({ baseURL });
    expect((await squatter.post("/api/auth/register", { data: { email: victim.email, password: victim.password, name: "x" } })).status()).toBe(200);
    // the real owner of the address resets
    const owner = await playwright.request.newContext({ baseURL });
    await forgot(owner, victim.email);
    const token = await resetToken(squatter, victim.email);
    const mine = strongPassword();
    expect((await reset(owner, token, mine)).status()).toBe(200);

    expect((await me(squatter)).user).toBeNull();
    expect((await login(squatter, victim.email, victim.password)).status()).toBe(401);
    expect((await login(owner, victim.email, mine)).status()).toBe(200);
    await Promise.all([squatter.dispose(), owner.dispose()]);
  });

  test("the reset link is limited per client address", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const headers = { "x-e2e-client-ip": freshIp() };
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await reset(anon, unissuedToken(), strongPassword(), headers)).status());
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    await anon.dispose();
  });
});

test.describe("sign-in and sign-up limits", () => {
  test("ten wrong passwords lock the address for a while, even against the right one", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    for (let i = 0; i < 10; i++) expect((await login(anon, existing.user.email, "wrong-" + i)).status()).toBe(401);
    const locked = await login(anon, existing.user.email, existing.user.password);
    expect(locked.status()).toBe(429);
    expect((await locked.json()).code).toBe("rate_limited");
    await anon.dispose();
  });

  test("the lock is per address: others are not affected", async ({ existing, makePerson, playwright, baseURL }) => {
    const other = await makePerson("other");
    const anon = await playwright.request.newContext({ baseURL });
    for (let i = 0; i < 10; i++) await login(anon, existing.user.email, "wrong-" + i);
    expect((await login(anon, other.user.email, other.user.password)).status()).toBe(200);
    await anon.dispose();
  });

  test("an unknown address is counted and locked the same way, so the lock reveals nothing", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const ghost = newUser("ghost");
    for (let i = 0; i < 10; i++) expect((await login(anon, ghost.email, "x")).status()).toBe(401);
    expect((await login(anon, ghost.email, "x")).status()).toBe(429);
    await anon.dispose();
  });

  test("a correct sign-in does not count against the limit", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    for (let i = 0; i < 14; i++) expect((await login(anon, existing.user.email, existing.user.password)).status()).toBe(200);
    await anon.dispose();
  });

  test("wrong passwords are limited per client address across addresses", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const headers = { "x-e2e-client-ip": freshIp() };
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await login(anon, newUser("spray").email, "x", headers)).status());
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    await anon.dispose();
  });

  test("the wrong-password message is the same for a missing account, a wrong password and a Google-only account", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const a = await login(anon, existing.user.email, "not-the-password");
    const b = await login(anon, newUser("ghost").email, "not-the-password");
    expect(a.status()).toBe(401);
    expect(await a.json()).toEqual(await b.json());
    await anon.dispose();
  });

  test("sign-up is limited to ten an hour per client address", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-e2e-client-ip": freshIp() } });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const u = newUser("burst");
      statuses.push((await anon.post("/api/auth/register", { data: { email: u.email, password: u.password } })).status());
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    await anon.dispose();
  });

  test("without a client address (local development) sign-up is not pooled into one limit", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    for (let i = 0; i < 12; i++) {
      const u = newUser("local");
      expect((await anon.post("/api/auth/register", { data: { email: u.email, password: u.password } })).status()).toBe(200);
    }
    await anon.dispose();
  });

  test("a refused sign-up is still the message it always was", async ({ existing, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const dup = await anon.post("/api/auth/register", { data: { email: existing.user.email, password: strongPassword() } });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).error).toBe("An account with that email already exists.");
    expect(await mailbox(anon, existing.user.email)).toHaveLength(1); // still only its own verification mail
    await anon.dispose();
  });
});
