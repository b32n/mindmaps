import { expect, register, test } from "../fixtures";
import { addMember, createBoard, createWorkspace, inviteRaw, listBoards, listWorkspaces, membersOf } from "../support/api";
import { linkIn, mailbox, tokenIn, unissuedToken, waitForMail } from "../support/mail";
import { newUser, strongPassword } from "../support/users";

// Email verification (docs/EMAIL.md), against the Worker that has outbound mail
// on and captures it. Every test registers its own user.

const verify = (request: import("@playwright/test").APIRequestContext, token: string) =>
  request.post("/api/auth/verify-email", { data: { token } });
const me = async (request: import("@playwright/test").APIRequestContext) => (await request.get("/api/auth/me")).json();

test.describe("the verification email", () => {
  test("sign-up sends one message, from the configured sender, with a link", async ({ account, request }) => {
    const [msg, ...rest] = await waitForMail(request, account.email);
    expect(rest).toHaveLength(0);
    expect(msg.from).toBe("mindmaps@mail.example.test");
    expect(msg.subject).toBe("Confirm your email address");
    const link = linkIn(msg);
    expect(link.pathname).toBe("/verify-email");
    expect(tokenIn(msg)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("it is plain, readable text and accessible HTML, with the link in both", async ({ account, request }) => {
    const [msg] = await waitForMail(request, account.email);
    const url = linkIn(msg).toString();
    expect(msg.html).toContain('<html lang="en">');
    expect(msg.html).toContain("<title>");
    expect(msg.html).toContain(`href="${url}"`);
    // the address is spelled out too, for clients that strip links
    expect(msg.html.split(url).length).toBeGreaterThan(2);
    expect(msg.html).not.toMatch(/<img|<script|<link/i);
    expect(msg.text).toContain("expires in 24 hours");
  });

  test("a new account starts unverified, and the app says email is on", async ({ account, request }) => {
    const out = await me(request);
    expect(out.user.email).toBe(account.email);
    expect(out.emailEnabled).toBe(true);
    expect(out.emailVerified).toBe(false);
  });

  test("signed out, /me reports email on and no verification state", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const out = await me(anon);
    expect(out.user).toBeNull();
    expect(out.emailEnabled).toBe(true);
    expect(out.emailVerified).toBeNull();
    await anon.dispose();
  });
});

test.describe("following the link", () => {
  test("verifies the account, from a browser that is not signed in", async ({ account, request, playwright, baseURL }) => {
    const [msg] = await waitForMail(request, account.email);
    const stranger = await playwright.request.newContext({ baseURL });
    const res = await verify(stranger, tokenIn(msg));
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await stranger.dispose();

    expect((await me(request)).emailVerified).toBe(true);
  });

  test("works once: the same link again is refused", async ({ account, request }) => {
    const [msg] = await waitForMail(request, account.email);
    expect((await verify(request, tokenIn(msg))).status()).toBe(200);
    const again = await verify(request, tokenIn(msg));
    expect(again.status()).toBe(400);
    expect((await again.json()).code).toBe("invalid_link");
  });

  test("two clicks at once: exactly one wins", async ({ account, request }) => {
    const [msg] = await waitForMail(request, account.email);
    const token = tokenIn(msg);
    const statuses = (await Promise.all([verify(request, token), verify(request, token), verify(request, token)])).map((r) => r.status());
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 400)).toHaveLength(2);
  });

  test("a wrong token, a never-issued one and rubbish all get the same refusal", async ({ account, request }) => {
    const [msg] = await waitForMail(request, account.email);
    const real = tokenIn(msg);
    const wrong = real.slice(0, -1) + (real.endsWith("0") ? "1" : "0");
    const bodies: unknown[] = [];
    for (const token of [wrong, unissuedToken(), "nope", "", real.toUpperCase()]) {
      const res = await verify(request, token);
      expect(res.status(), token).toBe(400);
      bodies.push(await res.json());
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect((await me(request)).emailVerified).toBe(false);
  });

  test("a missing or non-string token is refused, not a crash", async ({ request, account }) => {
    expect(account).toBeTruthy();
    for (const data of [{}, { token: 5 }, { token: null }, { token: ["a"] }]) {
      expect((await request.post("/api/auth/verify-email", { data })).status()).toBe(400);
    }
    expect((await request.post("/api/auth/verify-email", { data: "not json", headers: { "content-type": "text/plain" } })).status()).toBe(400);
  });

  test("a token is not a different account's: it only verifies the account it was sent to", async ({ account, request, makePerson }) => {
    const other = await makePerson("other");
    const [msg] = await waitForMail(request, account.email);
    await verify(other.request, tokenIn(msg));
    expect((await me(other.request)).emailVerified).toBe(false);
    expect((await me(request)).emailVerified).toBe(true);
  });
});

test.describe("resending", () => {
  test("sends a fresh link and retires the old one", async ({ account, request }) => {
    const [first] = await waitForMail(request, account.email);
    expect((await request.post("/api/auth/resend-verification")).status()).toBe(200);
    const [, second] = await waitForMail(request, account.email, 2);
    expect(tokenIn(second)).not.toBe(tokenIn(first));

    expect((await verify(request, tokenIn(first))).status()).toBe(400);
    expect((await verify(request, tokenIn(second))).status()).toBe(200);
  });

  test("needs a session", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    expect((await anon.post("/api/auth/resend-verification")).status()).toBe(401);
    await anon.dispose();
  });

  test("an account that is already verified is told so and sent nothing", async ({ account, request }) => {
    const [msg] = await waitForMail(request, account.email);
    await verify(request, tokenIn(msg));
    const res = await request.post("/api/auth/resend-verification");
    expect(res.status()).toBe(200);
    expect((await res.json()).alreadyVerified).toBe(true);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await mailbox(request, account.email)).toHaveLength(1);
  });

  test("is limited to three a hour per account", async ({ account, request }) => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await request.post("/api/auth/resend-verification")).status());
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await request.post("/api/auth/resend-verification");
    expect(limited.status()).toBe(429);
    expect((await limited.json()).code).toBe("rate_limited");
    expect(limited.headers()["retry-after"]).toBeTruthy();
    // 1 from sign-up + 3 that got through
    await waitForMail(request, account.email, 4);
    await new Promise((r) => setTimeout(r, 800));
    expect(await mailbox(request, account.email)).toHaveLength(4);
  });

  test("is limited per address of the client too, and a different client is not affected", async ({ playwright, baseURL }) => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const mk = (headers?: Record<string, string>) => playwright.request.newContext({ baseURL, extraHTTPHeaders: headers });
    const results: number[] = [];
    // 7 accounts x 3 resends each = 21 > the 20 an address may ask for
    for (let a = 0; a < 7; a++) {
      const c = await mk({ "x-e2e-client-ip": ip });
      const u = newUser("ipresend");
      // sign-up itself counts towards the sign-up limit only
      await register(c, u);
      for (let i = 0; i < 3; i++) results.push((await c.post("/api/auth/resend-verification")).status());
      await c.dispose();
    }
    expect(results.filter((s) => s === 200)).toHaveLength(20);
    expect(results.slice(20)).toEqual([429]);

    const other = await mk({ "x-e2e-client-ip": "198.51.100.7" });
    const u = newUser("ipresend2");
    await register(other, u);
    expect((await other.post("/api/auth/resend-verification")).status()).toBe(200);
    await other.dispose();
  });
});

test.describe("what an unverified address cannot do", () => {
  test("an invite waiting for an address is not claimed by someone who only typed it in", async ({ account, request, playwright, baseURL }) => {
    expect(account).toBeTruthy(); // the owner is whoever the page is signed in as
    const ws = await createWorkspace(request, "Team");
    const victim = newUser("victim");

    const invited = await addMember(request, "workspaces", ws.id, victim.email);
    expect(invited.invited).toBeTruthy();

    // someone who does not control the address registers it, and signs in again
    const squatter = await playwright.request.newContext({ baseURL });
    await register(squatter, { ...victim, password: strongPassword(), name: "squatter" });
    expect((await listWorkspaces(squatter)).map((w) => w.id)).not.toContain(ws.id);
    expect((await squatter.get(`/api/workspaces/${ws.id}/members`)).status()).toBeGreaterThanOrEqual(403);
    // and the invite is still pending for the real owner of the address
    expect((await membersOf(request, "workspaces", ws.id)).pending.map((p) => p.email)).toEqual([victim.email]);
    await squatter.dispose();
  });

  test("an unverified account is not added when someone invites its address; it cannot accept, and can once verified", async ({ account, request, makePerson }) => {
    const ws = await createWorkspace(request, "Team");
    const person = await makePerson("pending");

    const res = await inviteRaw(request, "workspaces", ws.id, person.user.email);
    expect(res.added).toBeUndefined();
    expect(res.invited?.email).toBe(person.user.email);
    const token = res.invited!.token;
    expect((await listWorkspaces(person.request)).map((w) => w.id)).not.toContain(ws.id);

    // not acceptable while the address is unproven
    const early = await person.request.post(`/api/invites/${token}/accept`);
    expect(early.status()).toBe(403);
    expect((await early.json()).code).toBe("email_unverified");
    expect((await listWorkspaces(person.request)).map((w) => w.id)).not.toContain(ws.id);

    // verifying joins them to nothing; they accept
    const [msg] = await waitForMail(person.request, person.user.email);
    expect((await verify(person.request, tokenIn(msg))).status()).toBe(200);
    expect((await listWorkspaces(person.request)).map((w) => w.id)).not.toContain(ws.id);
    expect((await person.request.post(`/api/invites/${token}/accept`)).status()).toBe(200);
    expect((await listWorkspaces(person.request)).find((w) => w.id === ws.id)?.role).toBe("editor");
    expect((await membersOf(request, "workspaces", ws.id)).pending).toHaveLength(0);
    expect(account).toBeTruthy();
  });

  test("a verified account gets a workspace invitation to accept, as on an instance without email", async ({ account, request, makePerson }) => {
    const ws = await createWorkspace(request, "Team");
    const person = await makePerson("verified");
    const [msg] = await waitForMail(person.request, person.user.email);
    await verify(person.request, tokenIn(msg));

    const res = await inviteRaw(request, "workspaces", ws.id, person.user.email, "viewer");
    expect(res.added).toBeUndefined();
    expect(res.invited?.existing).toBe(true);
    expect((await listWorkspaces(person.request)).map((w) => w.id)).not.toContain(ws.id);
    expect((await person.request.post(`/api/invites/${res.invited!.token}/accept`)).status()).toBe(200);
    expect((await listWorkspaces(person.request)).find((w) => w.id === ws.id)?.role).toBe("viewer");
    expect(account).toBeTruthy();
  });

  test("sharing a mindmap with an unverified account waits for verification; a verified one has it at once", async ({ account, request, makePerson }) => {
    const board = await createBoard(request, "Shared");
    const person = await makePerson("sharee");

    const res = await inviteRaw(request, "boards", board.id, person.user.email, "viewer");
    expect(res.added).toBeUndefined();
    expect(res.invited?.email).toBe(person.user.email);
    expect((await listBoards(person.request)).map((b) => b.id)).not.toContain(board.id);
    expect((await person.request.post(`/api/invites/${res.invited!.token}/accept`)).status()).toBe(403);

    const [msg] = await waitForMail(person.request, person.user.email);
    await verify(person.request, tokenIn(msg));
    const other = await createBoard(request, "Shared too");
    const now = await inviteRaw(request, "boards", other.id, person.user.email, "viewer");
    expect(now.added?.role).toBe("viewer");
    expect((await listBoards(person.request)).map((b) => b.id)).toContain(other.id);
    // the earlier one is now theirs to accept
    expect((await person.request.post(`/api/invites/${res.invited!.token}/accept`)).status()).toBe(200);
    expect((await listBoards(person.request)).map((b) => b.id)).toContain(board.id);
    expect(account).toBeTruthy();
  });

  test("an invite that arrived before the account existed cannot be accepted before verification, and still needs an accept after", async ({ account, request, playwright, baseURL }) => {
    const ws = await createWorkspace(request, "Team");
    const person = newUser("late");
    const sent = await inviteRaw(request, "workspaces", ws.id, person.email);
    const token = sent.invited!.token;

    const c = await playwright.request.newContext({ baseURL });
    await register(c, person);
    expect((await listWorkspaces(c)).map((w) => w.id)).not.toContain(ws.id);
    // signing in again changes nothing
    await c.post("/api/auth/login", { data: { email: person.email, password: person.password } });
    expect((await listWorkspaces(c)).map((w) => w.id)).not.toContain(ws.id);
    expect((await c.post(`/api/invites/${token}/accept`)).status()).toBe(403);

    const [msg] = await waitForMail(c, person.email);
    expect((await verify(c, tokenIn(msg))).status()).toBe(200);
    expect((await listWorkspaces(c)).map((w) => w.id)).not.toContain(ws.id);
    expect((await c.post(`/api/invites/${token}/accept`)).status()).toBe(200);
    expect((await listWorkspaces(c)).map((w) => w.id)).toContain(ws.id);
    await c.dispose();
    expect(account).toBeTruthy();
  });

  test("an unverified account can still use its own space", async ({ account, request }) => {
    expect(account).toBeTruthy();
    const ws = await listWorkspaces(request);
    expect(ws.some((w) => w.personal)).toBe(true);
    expect((await request.get("/api/boards")).status()).toBe(200);
  });
});
