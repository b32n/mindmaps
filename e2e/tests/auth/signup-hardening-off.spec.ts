import { expect, test } from "../../fixtures";
import { hashesFor } from "../../support/mail";
import { newUser, strongPassword } from "../../support/users";

// The main Worker has no email and no Turnstile, which is how every instance
// behaved before: sign-up signs the new account in, and a taken address is still
// refused outright (docs/SIGNUP.md says why, and what it costs).

const freshIp = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

test("the app is told there is no sign-up check", async ({ request }) => {
  expect((await (await request.get("/api/auth/me")).json()).turnstileSiteKey).toBeNull();
});

test("a new account is signed in at once, and a token that is sent is ignored", async ({ playwright, baseURL }) => {
  const c = await playwright.request.newContext({ baseURL });
  const u = newUser("off-new");
  const res = await c.post("/api/auth/register", { data: { email: u.email, password: u.password, name: u.name, turnstileToken: "junk" } });
  expect(res.status()).toBe(200);
  expect((await res.json()).user.email).toBe(u.email);
  expect(res.headers()["set-cookie"]).toContain("wb_session=");
  expect((await (await c.get("/api/auth/me")).json()).user.email).toBe(u.email);
  await c.dispose();
});

test("a taken address is refused as it always was, without spending a hash", async ({ existing, playwright, baseURL }) => {
  const c = await playwright.request.newContext({ baseURL });
  const before = await hashesFor(c, existing.user.email);
  const res = await c.post("/api/auth/register", { data: { email: existing.user.email, password: strongPassword() } });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe("An account with that email already exists.");
  expect(await hashesFor(c, existing.user.email)).toBe(before);
  await c.dispose();
});

test("sign-in for an address with no account costs a hash and answers like a wrong password", async ({ existing, playwright, baseURL }) => {
  const c = await playwright.request.newContext({ baseURL });
  const ghost = newUser("off-ghost");
  const a = await c.post("/api/auth/login", { data: { email: ghost.email, password: strongPassword() } });
  const b = await c.post("/api/auth/login", { data: { email: existing.user.email, password: strongPassword() } });
  expect([a.status(), await a.json()]).toEqual([b.status(), await b.json()]);
  expect(await hashesFor(c, ghost.email)).toBe(1);
  await c.dispose();
});

test("sign-up over the client limit is refused before any hash", async ({ playwright, baseURL }) => {
  const c = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-e2e-client-ip": freshIp() } });
  const users = Array.from({ length: 11 }, () => newUser("off-flood"));
  const statuses: number[] = [];
  for (const u of users) statuses.push((await c.post("/api/auth/register", { data: { email: u.email, password: u.password } })).status());
  expect(statuses).toEqual([...Array(10).fill(200), 429]);
  expect(await hashesFor(c, users[10].email)).toBe(0);
  expect(await hashesFor(c, users[0].email)).toBe(1);
  await c.dispose();
});

test("sign-in over the address limit is refused before any hash", async ({ existing, playwright, baseURL }) => {
  const c = await playwright.request.newContext({ baseURL });
  const base = await hashesFor(c, existing.user.email);
  for (let i = 0; i < 12; i++) await c.post("/api/auth/login", { data: { email: existing.user.email, password: strongPassword() } });
  expect(await hashesFor(c, existing.user.email)).toBe(base + 10);
  await c.dispose();
});
