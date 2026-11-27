import { expect, test } from "@playwright/test";
import { register } from "../fixtures";
import { hashesFor, mailbox, waitForMail } from "../support/mail";
import { failing, outage, passing, siteverifyCalls } from "../support/turnstile";
import { newUser, strongPassword } from "../support/users";

// Cloudflare Turnstile on sign-up, forgot-password and resend-verification
// (docs/SIGNUP.md), against the Worker that has it on and a local stand-in for
// Siteverify. The real Siteverify is never called.

const ip = () => `192.0.2.${Math.floor(Math.random() * 250) + 1}`;
const asJson = async (res: import("@playwright/test").APIResponse) => ({ status: res.status(), body: await res.json() });
const signUp = (c: import("@playwright/test").APIRequestContext, u: { email: string; password: string; name?: string }, turnstileToken?: unknown) =>
  c.post("/api/auth/register", { data: { email: u.email, password: u.password, name: u.name, turnstileToken } });
const exists = async (c: import("@playwright/test").APIRequestContext, u: { email: string; password: string }) =>
  (await c.post("/api/auth/login", { data: { email: u.email, password: u.password } })).status() === 200;

test.describe("what the app is told", () => {
  test("the site key is public, and nothing of the secret is", async ({ request }) => {
    const res = await request.get("/api/auth/me");
    const text = await res.text();
    expect(JSON.parse(text).turnstileSiteKey).toBe("e2e-turnstile-site");
    expect(text).not.toContain("e2e-turnstile-secret");
  });
});

test.describe("sign-up", () => {
  test("without a token it is refused, and no account is made", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const u = newUser("no-token");
    const res = await signUp(c, u);
    expect(await asJson(res)).toMatchObject({ status: 400, body: { code: "turnstile_required" } });
    expect((await res.json()).error).toMatch(/security check/i);
    expect(await exists(c, u)).toBe(false);
    await c.dispose();
  });

  test("an empty, blank, non-text or oversized token counts as none", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    for (const bad of ["", "   ", null, 7, { token: "x" }, ["pass-x"], "p".repeat(2049)]) {
      const u = newUser("junk-token");
      const res = await signUp(c, u, bad);
      expect(res.status(), JSON.stringify(bad)?.slice(0, 20)).toBe(400);
      expect((await res.json()).code).toBe("turnstile_required");
      expect(await exists(c, u)).toBe(false);
    }
    await c.dispose();
  });

  test("a token Siteverify refuses is refused, and no account is made", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const u = newUser("bad-token");
    const token = failing();
    const res = await signUp(c, u, token);
    expect(await asJson(res)).toMatchObject({ status: 400, body: { code: "turnstile_failed" } });
    expect(await siteverifyCalls(c, token)).toHaveLength(1);
    expect(await exists(c, u)).toBe(false);
    await c.dispose();
  });

  test("a token Siteverify accepts lets the sign-up through", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const u = newUser("good-token");
    const res = await signUp(c, u, passing());
    expect(await asJson(res)).toEqual({ status: 200, body: { ok: true, confirm: "email" } });
    expect(await exists(c, u)).toBe(true);
    await c.dispose();
  });

  test("Siteverify is sent the secret, the token, the client's address and an idempotency key", async ({ playwright, baseURL }) => {
    const client = ip();
    const c = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-e2e-client-ip": client } });
    const first = passing();
    const second = passing();
    await signUp(c, newUser("call-1"), first);
    await signUp(c, newUser("call-2"), second);
    const [one] = await siteverifyCalls(c, first);
    const [two] = await siteverifyCalls(c, second);
    expect(one).toMatchObject({ response: first, remoteip: client, secretOk: true });
    expect(one.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(two.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(two.idempotency_key).not.toBe(one.idempotency_key);
    await c.dispose();
  });

  test("a token works once: replaying it is refused", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const token = passing();
    expect((await signUp(c, newUser("once-a"), token)).status()).toBe(200);
    const again = await signUp(c, newUser("once-b"), token);
    expect(await asJson(again)).toMatchObject({ status: 400, body: { code: "turnstile_failed" } });
    await c.dispose();
  });

  test("the client's word is not taken: a flag, a header or a made-up field is not a token", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "cf-turnstile-response": "pass-anything", "x-turnstile-passed": "1" } });
    const u = newUser("liar");
    const res = await c.post("/api/auth/register", {
      data: { email: u.email, password: u.password, turnstile: true, turnstilePassed: true, "cf-turnstile-response": passing(), token: passing() },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("turnstile_required");
    expect(await exists(c, u)).toBe(false);
    await c.dispose();
  });

  test("when Siteverify is down the sign-up is refused with 503, after one retry with the same key", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const u = newUser("outage");
    const token = outage();
    const res = await signUp(c, u, token);
    expect(await asJson(res)).toMatchObject({ status: 503, body: { code: "turnstile_unavailable" } });
    const calls = await siteverifyCalls(c, token);
    expect(calls).toHaveLength(2);
    expect(calls[0].idempotency_key).toBe(calls[1].idempotency_key);
    expect(await exists(c, u)).toBe(false);
    await c.dispose();
  });

  test("a taken address and a new one are refused the same way without a token", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const taken = newUser("taken");
    await register(c, taken, passing());
    const a = await asJson(await signUp(c, newUser("new-nt")));
    const b = await asJson(await signUp(c, taken));
    expect(a).toEqual(b);
    await c.dispose();
  });

  test("it is checked after the cheap input checks and the rate limit, and before the hash", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-e2e-client-ip": ip() } });
    // a weak password never reaches Siteverify
    const weak = passing();
    expect((await signUp(c, { email: newUser().email, password: "short" }, weak)).status()).toBe(400);
    expect(await siteverifyCalls(c, weak)).toHaveLength(0);
    // a refused token never reaches the hash
    const u = newUser("no-hash");
    expect((await signUp(c, u, failing())).status()).toBe(400);
    expect(await hashesFor(c, u.email)).toBe(0);
    // over the sign-up limit: refused before Siteverify is asked
    for (let i = 0; i < 12; i++) await signUp(c, newUser("burst"), passing());
    const limited = passing();
    expect((await signUp(c, newUser("burst-x"), limited)).status()).toBe(429);
    expect(await siteverifyCalls(c, limited)).toHaveLength(0);
    await c.dispose();
  });
});

test.describe("forgot-password", () => {
  test("a missing or refused token is refused, and no mail is sent", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const u = newUser("forgot-refused");
    await register(c, u, passing());
    await waitForMail(c, u.email);
    const none = await c.post("/api/auth/forgot-password", { data: { email: u.email } });
    expect(await asJson(none)).toMatchObject({ status: 400, body: { code: "turnstile_required" } });
    const bad = await c.post("/api/auth/forgot-password", { data: { email: u.email, turnstileToken: failing() } });
    expect(await asJson(bad)).toMatchObject({ status: 400, body: { code: "turnstile_failed" } });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await mailbox(c, u.email)).map((m) => m.subject)).toEqual(["Confirm your email address"]);
    await c.dispose();
  });

  test("a good token sends the link, and an unknown address gets the identical answer", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const u = newUser("forgot-ok");
    await register(c, u, passing());
    const known = await asJson(await c.post("/api/auth/forgot-password", { data: { email: u.email, turnstileToken: passing() } }));
    const unknown = await asJson(await c.post("/api/auth/forgot-password", { data: { email: newUser("nobody").email, turnstileToken: passing() } }));
    expect(known).toEqual({ status: 200, body: { ok: true } });
    expect(unknown).toEqual(known);
    const msgs = await waitForMail(c, u.email, 2);
    expect(msgs.map((m) => m.subject)).toContain("Reset your password");
    await c.dispose();
  });

  test("the refusal is the same for a known and an unknown address", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const u = newUser("forgot-same");
    await register(c, u, passing());
    const a = await asJson(await c.post("/api/auth/forgot-password", { data: { email: u.email } }));
    const b = await asJson(await c.post("/api/auth/forgot-password", { data: { email: newUser("nobody2").email } }));
    expect(a).toEqual(b);
    await c.dispose();
  });
});

test.describe("resend-verification", () => {
  test("a missing or refused token is refused; a good one sends the mail", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const u = newUser("resend-ts");
    await register(c, u, passing());
    await waitForMail(c, u.email);
    expect(await asJson(await c.post("/api/auth/resend-verification"))).toMatchObject({ status: 400, body: { code: "turnstile_required" } });
    expect(await asJson(await c.post("/api/auth/resend-verification", { data: { turnstileToken: failing() } }))).toMatchObject({
      status: 400,
      body: { code: "turnstile_failed" },
    });
    expect(await asJson(await c.post("/api/auth/resend-verification", { data: { turnstileToken: passing() } }))).toEqual({ status: 200, body: { ok: true } });
    expect(await waitForMail(c, u.email, 2)).toHaveLength(2);
    await c.dispose();
  });
});

test.describe("what it does not guard", () => {
  test("sign-in, confirming an address and using a reset link need no token", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const u = newUser("unguarded");
    await register(c, u, passing());
    expect((await c.post("/api/auth/login", { data: { email: u.email, password: u.password } })).status()).toBe(200);
    expect((await c.post("/api/auth/verify-email", { data: { token: "a".repeat(64) } })).status()).toBe(400);
    const reset = await c.post("/api/auth/reset-password", { data: { token: "a".repeat(64), password: strongPassword() } });
    expect((await reset.json()).code).toBe("invalid_link"); // refused as a link, not as a missing check
    await c.dispose();
  });
});
