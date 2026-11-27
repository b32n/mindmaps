import { expect, test } from "@playwright/test";
import { register } from "../fixtures";
import { ExpiryWorker } from "../support/expiry";
import { waitForMail } from "../support/mail";
import { newUser } from "../support/users";

// Turnstile is optional: on only when the site key AND the secret are set. The
// email Worker has neither, and must behave as it did before the check existed.

test.describe("neither set (the email Worker)", () => {
  test("the app is told there is no check", async ({ request }) => {
    expect((await (await request.get("/api/auth/me")).json()).turnstileSiteKey).toBeNull();
  });

  test("sign-up, forgot-password and resend-verification work with no token, and ignore one", async ({ playwright, baseURL }) => {
    const c = await playwright.request.newContext({ baseURL });
    const u = newUser("ts-off");
    await register(c, u);
    expect((await c.post("/api/auth/forgot-password", { data: { email: u.email } })).status()).toBe(200);
    expect((await c.post("/api/auth/forgot-password", { data: { email: u.email, turnstileToken: "junk" } })).status()).toBe(200);
    expect((await c.post("/api/auth/resend-verification")).status()).toBe(200);
    expect((await waitForMail(c, u.email, 4)).length).toBeGreaterThanOrEqual(4);
    const v = newUser("ts-off-2");
    expect((await c.post("/api/auth/register", { data: { email: v.email, password: v.password, turnstileToken: { not: "text" } } })).status()).toBe(200);
    await c.dispose();
  });
});

// Half a configuration is not a configuration: neither a lone site key (the widget
// would show and nothing could check it) nor a lone secret turns the check on.
test.describe("only one of the two set", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  for (const [label, vars] of [
    ["only the site key", { TURNSTILE_SITE_KEY: "e2e-site-only" }],
    ["only the secret", { TURNSTILE_SECRET_KEY: "e2e-secret-only" }],
    ["a blank secret", { TURNSTILE_SITE_KEY: "e2e-site-only", TURNSTILE_SECRET_KEY: " " }],
  ] as const) {
    test(`${label}: the check is off`, async () => {
      const worker = new ExpiryWorker("wrangler.test-mail.toml", vars);
      try {
        await worker.start();
        const c = await worker.client();
        const me = await (await c.get("/api/auth/me")).json();
        expect(me.turnstileSiteKey).toBeNull();
        const u = newUser("ts-half");
        const res = await c.post("/api/auth/register", { data: { email: u.email, password: u.password } });
        expect(res.status()).toBe(200);
        expect((await c.post("/api/auth/forgot-password", { data: { email: u.email } })).status()).toBe(200);
        await c.dispose();
      } finally {
        await worker.dispose();
      }
    });
  }
});
