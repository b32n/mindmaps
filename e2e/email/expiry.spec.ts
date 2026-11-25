import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "../fixtures";
import { ExpiryWorker } from "../support/expiry";
import { tokenIn, waitForMail } from "../support/mail";
import { newUser, strongPassword } from "../support/users";

// What the shared Worker cannot show: a link that has aged out, what is (and is
// not) kept in the database, and a rate-limit window that has passed. A private
// Worker (own port, own state) is stopped while rows are backdated.

test.describe.configure({ mode: "serial" });
// starting workerd is slow, and these restart it
test.setTimeout(240_000);

let worker: ExpiryWorker;
test.beforeAll(async () => {
  worker = new ExpiryWorker("wrangler.test-mail.toml");
  await worker.start();
});
test.afterAll(async () => {
  await worker?.dispose();
});

const HOUR = 3_600_000;

test("a verification link expires after 24 hours", async () => {
  const c = await worker.client();
  const u = newUser("expiry-verify");
  await c.post("/api/auth/register", { data: { email: u.email, password: u.password, name: u.name } });
  const [msg] = await waitForMail(c, u.email);
  await c.dispose();

  await worker.execute(`UPDATE email_tokens SET expires_at = ${Date.now() - 1000} WHERE email = '${u.email}'`);
  const c2 = await worker.client();
  const res = await c2.post("/api/auth/verify-email", { data: { token: tokenIn(msg) } });
  expect(res.status()).toBe(400);
  expect((await res.json()).code).toBe("invalid_link");
  await c2.dispose();
});

test("the expiry that is set is 24 hours for verification and one hour for a reset", async () => {
  const c = await worker.client();
  const u = newUser("expiry-ttl");
  const before = Date.now();
  await c.post("/api/auth/register", { data: { email: u.email, password: u.password, name: u.name } });
  await waitForMail(c, u.email);
  await c.post("/api/auth/forgot-password", { data: { email: u.email } });
  await waitForMail(c, u.email, 2);
  await c.dispose();

  const rows = await worker.query<{ kind: string; ttl: number }>(
    `SELECT kind, expires_at - created_at AS ttl FROM email_tokens WHERE email = '${u.email}'`,
  );
  const ttl = Object.fromEntries(rows.map((r) => [r.kind, r.ttl]));
  expect(ttl.verify).toBe(24 * HOUR);
  expect(ttl.reset).toBe(HOUR);
  expect(Date.now()).toBeGreaterThanOrEqual(before);
});

test("a reset link expires after an hour", async () => {
  const c = await worker.client();
  const u = newUser("expiry-reset");
  await c.post("/api/auth/register", { data: { email: u.email, password: u.password, name: u.name } });
  await c.post("/api/auth/forgot-password", { data: { email: u.email } });
  const all = await waitForMail(c, u.email, 2);
  const msg = all.find((m) => m.subject === "Reset your password")!;
  await c.dispose();

  await worker.execute(`UPDATE email_tokens SET expires_at = ${Date.now() - 1000} WHERE email = '${u.email}' AND kind = 'reset'`);
  const c2 = await worker.client();
  const fresh = strongPassword();
  expect((await c2.post("/api/auth/reset-password", { data: { token: tokenIn(msg), password: fresh } })).status()).toBe(400);
  // the old password is still the one in force
  expect((await c2.post("/api/auth/login", { data: { email: u.email, password: u.password } })).status()).toBe(200);
  await c2.dispose();
});

test("only a hash of each token is stored, and used tokens are kept with their status", async () => {
  const c = await worker.client();
  const u = newUser("stored");
  await register(c, u);
  const [msg] = await waitForMail(c, u.email);
  const token = tokenIn(msg);
  await c.post("/api/auth/resend-verification");
  await waitForMail(c, u.email, 2);
  const [, second] = await waitForMail(c, u.email, 2);
  expect((await c.post("/api/auth/verify-email", { data: { token: tokenIn(second) } })).status()).toBe(200);
  await c.dispose();

  const rows = await worker.query<{ token_hash: string; status: string; used_at: number | null; created_at: number; updated_at: number }>(
    `SELECT token_hash, status, used_at, created_at, updated_at FROM email_tokens WHERE email = '${u.email}' ORDER BY created_at`,
  );
  expect(rows).toHaveLength(2);
  for (const r of rows) {
    expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.token_hash).not.toBe(token);
    expect(r.token_hash).not.toBe(tokenIn(second));
    expect(r.created_at).toBeGreaterThan(0);
    expect(r.updated_at).toBeGreaterThanOrEqual(r.created_at);
  }
  expect(rows.map((r) => r.status)).toEqual(["superseded", "used"]);
  expect(rows[1].used_at).toBeGreaterThan(0);

  const [user] = await worker.query<{ email_verified_at: number; email_verified_via: string }>(
    `SELECT email_verified_at, email_verified_via FROM users WHERE email = '${u.email}'`,
  );
  expect(user.email_verified_via).toBe("email");
  expect(user.email_verified_at).toBeGreaterThan(0);
});

test("a rate-limit window that has passed lets the address try again", async () => {
  const c = await worker.client();
  const u = newUser("window");
  for (let i = 0; i < 10; i++) await c.post("/api/auth/login", { data: { email: u.email, password: "x" } });
  expect((await c.post("/api/auth/login", { data: { email: u.email, password: "x" } })).status()).toBe(429);
  await c.dispose();

  await worker.execute(`UPDATE rate_limits SET window_start = window_start - ${16 * 60_000}`);
  const c2 = await worker.client();
  expect((await c2.post("/api/auth/login", { data: { email: u.email, password: "x" } })).status()).toBe(401);
  // the row is reused, not appended to or deleted
  const rows = await worker.query<{ n: number }>(`SELECT count(*) AS n FROM rate_limits`);
  expect(rows[0].n).toBeGreaterThan(0);
  await c2.dispose();
});

test("accounts that existed before email verification are grandfathered as verified", async () => {
  // Rewind to the state a database is in just before the migration: the columns
  // exist but an old account was created without a mark. Re-running the backfill
  // statement from the migration must mark it, and must leave a newer mark alone.
  const c = await worker.client();
  const u = newUser("old");
  await c.post("/api/auth/register", { data: { email: u.email, password: u.password, name: u.name } });
  await c.dispose();
  const [before] = await worker.query<{ v: number | null }>(`SELECT email_verified_at AS v FROM users WHERE email = '${u.email}'`);
  expect(before.v).toBeNull();

  await worker.executeFile(backfillFile());
  const [after] = await worker.query<{ v: number | null; via: string }>(
    `SELECT email_verified_at AS v, email_verified_via AS via FROM users WHERE email = '${u.email}'`,
  );
  expect(after.v).not.toBeNull();
  expect(after.via).toBe("grandfathered");
});

/** The backfill statement out of the migration itself, in a temp file (the ALTERs around it cannot be run twice). */
function backfillFile(): string {
  const migration = readFileSync(fileURLToPath(new URL("../../worker/migrations/0030_email_auth.sql", import.meta.url)), "utf8");
  const statement = migration.match(/^UPDATE users[^;]*;/m)?.[0];
  if (!statement) throw new Error("no backfill statement in the migration");
  const file = join(mkdtempSync(join(tmpdir(), "mindmaps-backfill-")), "backfill.sql");
  writeFileSync(file, statement);
  return file;
}
