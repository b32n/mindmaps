import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "../fixtures";
import { ExpiryWorker } from "../support/expiry";
import { tokenIn, waitForMail } from "../support/mail";
import { newUser } from "../support/users";

// The scheduled sweep of the two technical tables (docs/SIGNUP.md, "Housekeeping"):
// expired rows are marked, not deleted; only rate-limit counters a week past their
// expiry are removed. A private Worker (own state) runs the cron handler on
// demand, and rows are written straight into its database so each case has the
// exact age it needs.

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Minute 0 and minute 3 of an hour: the sweep is due on every tenth minute. */
const DUE = Date.UTC(2031, 0, 1, 12, 10, 0);
const NOT_DUE = Date.UTC(2031, 0, 1, 12, 13, 0);

let worker: ExpiryWorker;
test.beforeAll(async () => {
  worker = new ExpiryWorker("wrangler.test-mail.toml");
  await worker.start();
});
test.afterAll(async () => {
  await worker?.dispose();
});

const keyOf = (limit: string, subject: string) => createHash("sha256").update(`${limit}:${subject.toLowerCase()}`).digest("hex");

interface Rate { key: string; status: string; count: number; expired_at: number | null; window_start: number; window_ms: number | null }
const rates = (worker_: ExpiryWorker, prefix: string) =>
  worker_.query<Rate>(`SELECT key, status, count, expired_at, window_start, window_ms FROM rate_limits WHERE key LIKE '${prefix}%' ORDER BY key`);
const byKey = (rows: Rate[]) => Object.fromEntries(rows.map((r) => [r.key, r]));

const tag = `hk${randomUUID().slice(0, 8)}`;
const k = (name: string) => `${tag}-${name}`;
const tokenId = (name: string) => `${tag}-tok-${name}`;

test("the sweep marks what has expired, keeps what is still live, and removes only old rate-limit counters", async () => {
  const now = Date.now();
  const rate = (name: string, o: { start: number; ms: number | null; status?: string; expired?: number | null }) =>
    `INSERT INTO rate_limits (key,count,window_start,window_ms,status,expired_at,created_at,updated_at)
     VALUES ('${k(name)}', 4, ${o.start}, ${o.ms ?? "NULL"}, '${o.status ?? "active"}', ${o.expired ?? "NULL"}, ${o.start}, ${o.start});`;
  const tok = (name: string, status: string, expiresAt: number, extra = "") =>
    `INSERT INTO email_tokens (id,user_id,kind,email,token_hash,status,expires_at,created_at,updated_at${extra ? ",used_at" : ""})
     VALUES ('${tokenId(name)}','u-${tag}','verify','${tag}-${name}@example.test','${tokenId(name)}-hash','${status}',${expiresAt},${expiresAt - DAY},${expiresAt - DAY}${extra ? `,${extra}` : ""});`;

  // rate limits: windows of 15 minutes and an hour, and two rows written by a Worker
  // that does not record its window (window_ms NULL: the sweep assumes an hour)
  const statements = [
    rate("live-15", { start: now - 5 * MIN, ms: 15 * MIN }),
    rate("over-15", { start: now - 20 * MIN, ms: 15 * MIN }),
    rate("live-60", { start: now - 40 * MIN, ms: HOUR }),
    rate("over-60", { start: now - 90 * MIN, ms: HOUR }),
    rate("unknown-live", { start: now - 30 * MIN, ms: null }),
    rate("unknown-over", { start: now - 2 * HOUR, ms: null }),
    // already expired: kept for a week
    rate("expired-6d", { start: now - 7 * DAY, ms: HOUR, status: "expired", expired: now - 6 * DAY }),
    rate("expired-8d", { start: now - 9 * DAY, ms: HOUR, status: "expired", expired: now - 8 * DAY }),
    // email tokens
    tok("active-past", "active", now - HOUR),
    tok("active-live", "active", now + HOUR),
    tok("used-past", "used", now - HOUR, `${now - 2 * HOUR}`),
    tok("superseded-past", "superseded", now - HOUR),
    tok("active-ancient", "active", now - 400 * DAY),
  ];
  await worker.execute(statements.join("\n"));
  const [usersBefore] = await worker.query<{ n: number }>(`SELECT count(*) AS n FROM users`);

  // not a due minute: nothing happens
  await worker.scheduled(NOT_DUE);
  const idle = byKey(await rates(worker, tag));
  expect(Object.values(idle).map((r) => r.status).sort()).toEqual(
    ["active", "active", "active", "active", "active", "active", "expired", "expired"],
  );
  const idleTokens = await worker.query<{ id: string; status: string }>(`SELECT id, status FROM email_tokens WHERE id LIKE '${tag}-tok-%'`);
  expect(idleTokens.filter((t) => t.status === "expired")).toHaveLength(0);

  // a due minute
  const before = Date.now();
  await worker.scheduled(DUE);
  const after = byKey(await rates(worker, tag));

  // marked expired, with a time, and kept
  for (const name of ["over-15", "over-60", "unknown-over"]) {
    expect(after[k(name)], name).toMatchObject({ status: "expired", count: 4 });
    expect(after[k(name)].expired_at, name).toBeGreaterThanOrEqual(before);
  }
  // still inside their window: untouched
  for (const name of ["live-15", "live-60", "unknown-live"]) {
    expect(after[k(name)], name).toMatchObject({ status: "active", expired_at: null });
  }
  // a week of retention: six days stays, eight days goes
  expect(after[k("expired-6d")]).toMatchObject({ status: "expired" });
  expect(after[k("expired-8d")]).toBeUndefined();

  const tokens = Object.fromEntries(
    (await worker.query<{ id: string; status: string; used_at: number | null; updated_at: number }>(
      `SELECT id, status, used_at, updated_at FROM email_tokens WHERE id LIKE '${tag}-tok-%'`,
    )).map((t) => [t.id, t]),
  );
  // expired ones are marked, with a time, and never deleted; the rest keep what they were
  expect(tokens[tokenId("active-past")].status).toBe("expired");
  expect(tokens[tokenId("active-past")].updated_at).toBeGreaterThanOrEqual(before);
  expect(tokens[tokenId("active-ancient")].status).toBe("expired");
  expect(tokens[tokenId("active-live")].status).toBe("active");
  expect(tokens[tokenId("used-past")]).toMatchObject({ status: "used" });
  expect(tokens[tokenId("used-past")].used_at).not.toBeNull();
  expect(tokens[tokenId("superseded-past")].status).toBe("superseded");
  expect(Object.keys(tokens)).toHaveLength(5);

  // nothing that holds user data was touched
  const [usersAfter] = await worker.query<{ n: number }>(`SELECT count(*) AS n FROM users`);
  expect(usersAfter.n).toBe(usersBefore.n);
});

test("running the sweep twice changes nothing the second time", async () => {
  const first = await worker.query<{ n: number; e: number | null }>(
    `SELECT count(*) AS n, max(expired_at) AS e FROM rate_limits WHERE key LIKE '${tag}%'`,
  );
  await worker.scheduled(DUE + 10 * MIN);
  const second = await worker.query<{ n: number; e: number | null }>(
    `SELECT count(*) AS n, max(expired_at) AS e FROM rate_limits WHERE key LIKE '${tag}%'`,
  );
  expect(second).toEqual(first);
});

test("a counter that was marked expired starts again from one when its address is used again", async () => {
  const email = `${tag}-again@example.test`;
  const key = keyOf("forgot_email", email);
  const now = Date.now();
  await worker.execute(
    `INSERT INTO rate_limits (key,count,window_start,window_ms,status,expired_at,created_at,updated_at)
     VALUES ('${key}', 3, ${now - 2 * HOUR}, ${HOUR}, 'expired', ${now - HOUR}, ${now - 2 * HOUR}, ${now - HOUR})`,
  );
  const c = await worker.client();
  expect((await c.post("/api/auth/forgot-password", { data: { email } })).status()).toBe(200);
  await c.dispose();
  const [row] = await worker.query<Rate>(`SELECT key, status, count, expired_at, window_start, window_ms FROM rate_limits WHERE key = '${key}'`);
  expect(row).toMatchObject({ status: "active", count: 1, expired_at: null, window_ms: HOUR });
});

test("the sweep does not change what a limit allows: a window that has not passed still blocks", async () => {
  const c = await worker.client();
  const u = newUser("still-blocked");
  for (let i = 0; i < 10; i++) await c.post("/api/auth/login", { data: { email: u.email, password: "x" } });
  expect((await c.post("/api/auth/login", { data: { email: u.email, password: "x" } })).status()).toBe(429);
  await worker.scheduled(DUE + 20 * MIN);
  // the sweep reads each row's own window against the real clock, so a lockout that is still running survives it
  const c2 = await worker.client();
  expect((await c2.post("/api/auth/login", { data: { email: u.email, password: "x" } })).status()).toBe(429);
  await c.dispose();
  await c2.dispose();
});

test("a link whose row was marked expired is refused", async () => {
  const c = await worker.client();
  const u = newUser("expired-link");
  await register(c, u);
  const [msg] = await waitForMail(c, u.email);
  await worker.execute(`UPDATE email_tokens SET status = 'expired' WHERE email = '${u.email}'`);
  const c2 = await worker.client();
  const res = await c2.post("/api/auth/verify-email", { data: { token: tokenIn(msg) } });
  expect(res.status()).toBe(400);
  await c.dispose();
  await c2.dispose();
});

test("rows an older Worker wrote (no window recorded) are swept, and its upsert still works on the migrated table", async () => {
  // The statement the previous release ran on every hit: it names no new column.
  const key = `${tag}-old-worker`;
  const t = Date.now() - 3 * HOUR;
  await worker.execute(
    `INSERT INTO rate_limits (key,count,window_start,created_at,updated_at) VALUES ('${key}',1,${t},${t},${t})
     ON CONFLICT(key) DO UPDATE SET count = count + 1, updated_at = ${t};`,
  );
  const [row] = await worker.query<Rate>(`SELECT key, status, count, expired_at, window_start, window_ms FROM rate_limits WHERE key = '${key}'`);
  expect(row).toMatchObject({ status: "active", window_ms: null, expired_at: null });
  await worker.scheduled(DUE + 30 * MIN);
  const [swept] = await worker.query<Rate>(`SELECT key, status, count, expired_at, window_start, window_ms FROM rate_limits WHERE key = '${key}'`);
  expect(swept.status).toBe("expired");
});

test("the migration only adds: nullable columns and indexes, nothing dropped, rewritten or deleted", () => {
  const sql = readFileSync(fileURLToPath(new URL("../../worker/migrations/0034_signup_hardening.sql", import.meta.url)), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
  const alters = sql.match(/ALTER TABLE[^;]*;/gi) ?? [];
  expect(alters).toHaveLength(2);
  for (const a of alters) {
    expect(a).toMatch(/ADD COLUMN \w+ INTEGER;$/i);
    expect(a).not.toMatch(/NOT NULL/i);
  }
  for (const stmt of sql.match(/CREATE[^;]*;/gi) ?? []) expect(stmt).toMatch(/IF NOT EXISTS/i);
});
