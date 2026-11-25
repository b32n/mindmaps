# Sign-up hardening

What stands between the internet and the unauthenticated write paths (sign-up,
forgot-password, resend-verification, sign-in): not revealing who has an account,
an optional bot check (Cloudflare Turnstile), limits that run before any costly
work, and a sweep that keeps the bookkeeping tables small. [EMAIL.md](EMAIL.md)
covers the mail these rely on.

Everything here is optional except the first item's behaviour, which follows from
whether the instance can send email. An instance that sets up neither email nor
Turnstile behaves as it always did.

## Sign-up does not say who has an account

`POST /api/auth/register` for an address that already has an account used to answer
`409 An account with that email already exists.`, which lets anyone ask "is this
person registered here?" about any address. What it does now depends on email.

### Email configured

Sign-up gives **the same answer for a new address and a taken one**: status `200`,
body `{"ok":true,"confirm":"email"}`, the same headers, and **no session in either
case** (a cookie on one and not the other would be the same leak).

- A new address gets its account and the confirmation email (`docs/EMAIL.md`).
- A taken address changes nothing. Its owner is sent "Someone tried to sign up with
  your email address", with links to sign in and to reset the password. The message
  holds nothing about the person who asked and no token. At most three of these go
  to one address an hour, so the form cannot be used to flood an inbox; past that
  nothing is sent and the answer is still the same.
- The password hash is computed for both, so the time taken says nothing either.
- Closed sign-up (`ALLOW_SIGNUPS` unset) answers `403` to a stranger whether or not
  they hold an account.

Because nobody is signed in by sign-up any more, the web app shows "Check your
email" and the person signs in (an unconfirmed account can sign in; what it cannot
do is claim invitations, see EMAIL.md). The person who re-registers an address they
forgot they had gets the notice, with a way back in, in their own inbox.

### Email not configured

There is nobody to tell, so the instance keeps the old answer: `409` for a taken
address, and a new account is signed in at once. **This is the one place the
question "does this address have an account?" can still be asked.** It is bounded
by the sign-up limit (10 an hour per client) and, if switched on, Turnstile; and
most instances without email are closed (`personal`/`org`: sign-up needs an
invite), where a stranger gets `403` first. If that matters to you, set up email.
The hosted service has it.

### The other endpoints

Checked for the same leak; nothing else needed changing except timing:

| Endpoint | Behaviour |
|---|---|
| Sign-in | One message and status (`401 Email or password is incorrect.`) for an unknown address, a wrong password and a Google-only account; `429` for a locked address whether or not it exists. A missing account now costs a password hash too (a fixed decoy hash), so it is not visibly faster than a wrong password. |
| Forgot password | Same `200` for a known and an unknown address; the mail goes out after the response; the address is counted either way. |
| Resend verification | Needs a session, so says nothing to a stranger. |
| Reset / confirm links | One message for wrong, used, expired and never-issued links. |

## Turnstile

Off unless **both** `TURNSTILE_SITE_KEY` (a plain variable, public) and
`TURNSTILE_SECRET_KEY` (a Worker **secret**) are set. With either missing, every
endpoint behaves exactly as without it, and `GET /api/auth/me` has
`turnstileSiteKey: null`. When on, `me` returns the site key (and only that) and the
web app shows the widget on:

| Page | Endpoint | When it is checked |
|---|---|---|
| Create account | `POST /api/auth/register` | after the rate limit and the cheap input checks (address shape, password policy), before any database lookup or password hash |
| Forgot password | `POST /api/auth/forgot-password` | after the rate limit, before the lookup |
| The "Resend email" banner | `POST /api/auth/resend-verification` | after the rate limit; pressing the button shows the widget, solving it sends the mail |

Sign-in, confirming an address and using a reset link are not checked: the limits
cover them and there is no free account to create.

The browser sends the widget's token as `turnstileToken` in the JSON body. The
Worker never trusts it: it posts it to Siteverify
(`https://challenges.cloudflare.com/turnstile/v0/siteverify`) with the secret, the
client's address (`CLIENT_IP_HEADER`, default `cf-connecting-ip`) and a fresh
idempotency key. Answers:

| Case | Status | `code` |
|---|---|---|
| No token, or one that is empty, not text or over 2048 characters | `400` | `turnstile_required` |
| Siteverify says no (wrong, expired or already used: a token works once) | `400` | `turnstile_failed` |
| Siteverify cannot be reached (one retry, same idempotency key, 5 s each) | `503` | `turnstile_unavailable` |

An outage of the check is a refusal, not an open door. Over the rate limit a request
is refused (`429`) before Siteverify is asked, so a flood cannot spend subrequests.
Taken and new addresses are refused identically, so the check does not undo the
enumeration fix.

### Turning it on

The installer does it (below), or by hand:

1. Cloudflare dashboard → Turnstile → Add widget → your hostname → Managed. Copy the
   site key and the secret.
2. Put the site key in `wrangler.local.toml` under `[vars]`:
   `TURNSTILE_SITE_KEY = "<site key>"`.
3. `npx wrangler secret put TURNSTILE_SECRET_KEY` and paste the secret.
4. Deploy.

Adding the key without the secret leaves the check off (so a half-finished setup
never locks sign-up). Removing either turns it off again.

### The installer

```
npm run install:cloudflare -- --domain notes.example.com --turnstile          # make a widget for the domain
TURNSTILE_SECRET_KEY=<secret> npm run install:cloudflare -- --turnstile-site-key <site key>   # use one you made
npm run install:cloudflare -- --no-turnstile                                   # none (also removes it from an install that has it)
```

- **Default.** The hosted service's mode (`multitenant`, and anything served from
  `mindmaps.b32n.io`) gets a widget without being asked, with `--yes` too. `personal`
  and `org` are asked (default no); `--yes` means no. With no domain there is no
  hostname to make a widget for, so it is skipped and says how to add one later.
- **What it does.** Finds or creates a managed widget named `mindmaps (<host>)` in
  your account through the Cloudflare API (`/accounts/{id}/challenges/widgets`),
  writes the site key to `wrangler.local.toml`, deploys, and **then** hands the
  secret to `wrangler secret put TURNSTILE_SECRET_KEY` on standard input. The secret
  is never printed, logged, written to a file or put on a command line. If the
  widget exists from an earlier run but the config lost its key, the installer
  rotates that widget's secret to get a usable one (secrets cannot be read back).
- **The token.** It uses `CLOUDFLARE_API_TOKEN`, else the `wrangler login` token. The
  token needs **Account: Turnstile: Edit**. If it is missing or lacks that, the
  installer does not turn Turnstile on and prints the dashboard route and the
  `--turnstile-site-key` command instead, like email.
- **`--turnstile-site-key`** is for a widget made in the dashboard. Its secret is
  read from the `TURNSTILE_SECRET_KEY` environment variable, never a flag, because
  command lines end up in shell history and process lists. It is refused if the
  variable is empty.
- **Re-runs** keep the key the install has, make no second widget and do not ask for
  the secret again. `--no-turnstile` removes the key from the config; the stored
  secret stays unused in your account (delete it with `wrangler secret delete
  TURNSTILE_SECRET_KEY` if you like).
- If storing the secret fails, the installer says so and the check stays off until
  you run `npx wrangler secret put TURNSTILE_SECRET_KEY`.

### Trying it without Cloudflare

Cloudflare publishes test keys that always pass or always fail, for local work:

| Site key | Behaviour |
|---|---|
| `1x00000000000000000000AA` | always passes |
| `2x00000000000000000000AB` | always blocks |
| `3x00000000000000000000FF` | forces an interactive challenge |

| Secret key | Siteverify answers |
|---|---|
| `1x0000000000000000000000000000000AA` | always passes |
| `2x0000000000000000000000000000000AA` | always fails |
| `3x0000000000000000000000000000000AA` | "token already spent" |

Siteverify's address is `TURNSTILE_VERIFY_URL`, default Cloudflare's; only the test
suite points it elsewhere (a local stand-in, `e2e/support/fake-turnstile.mjs`).
Never set it on a real install.

## Limits come before the work

Every limit (EMAIL.md, "Limits") is counted before anything expensive:

- **Sign-up** counts the client first, then validates, then checks Turnstile, then
  looks the address up, then hashes. An over-limit request is refused with no
  lookup, no Siteverify call and no hash.
- **Sign-in** reads the address and client counters first; a locked address or client
  is refused with no password hash (even for the right password). Failures are counted
  after the hash, so up to the limit (10 per address, 30 per client, per 15 minutes)
  attempts do cost one hash each. One caveat: a burst of requests that all arrive
  before the first failure is recorded can each get past the check.
- **Forgot password, resend, reset and confirm** count before they touch anything else.

A new limit, `notice_email` (3 an hour per address), keeps sign-up from being used to
mail-bomb the owner of an address.

## Housekeeping

`rate_limits` and `email_tokens` are written by unauthenticated requests, so they must
not grow for ever. The Worker's cron (every minute, for the reindex) also runs a sweep
every tenth minute (`worker/src/housekeeping.ts`), at most 500 rows per statement, so a
backlog clears over a few runs:

| Table | What the sweep does |
|---|---|
| `rate_limits` | A counter whose window has passed is marked `status = 'expired'` with `expired_at`. A later hit revives it (`active`, count restarts). A row that has been **expired for 7 days is deleted.** |
| `email_tokens` | An `active` link past `expires_at` is marked `status = 'expired'`. **Never deleted.** |

Counters record their window length in `rate_limits.window_ms` (new, nullable). A row
written by an older Worker has none, and the sweep assumes the longest window (an
hour) for it. Nothing about what a limit allows changes: the check reads `window_start`
as before, and a limit that is still running is never marked.

**The one hard delete, and why.** The project rule is that tables holding user data
are never hard-deleted. `rate_limits` is the exception because it is purely technical:
a row is a hash of `"<limit>:<address or client address>"` and a count, nothing refers
to it, and it has no value after its window. A hash of an email address is
pseudonymous personal data (an address can be guessed and hashed), so keeping the rows
for ever would be the worse choice, and marking alone could not bound the table. Seven
days after a row expired it is removed; the window is `RATE_RETENTION_MS` in
housekeeping.ts. `email_tokens` rows name an address and are the audit trail of links
sent to it, so they are only marked.

The migration (`0031_signup_hardening.sql`) is additive: two nullable columns and two
indexes. The Worker before this one keeps running on a migrated database.

Cron needs no setup: the trigger is already in `wrangler.toml` (and so in installs).
The test Workers have no cron trigger; the suite calls the handler through wrangler's
local `/cdn-cgi/handler/scheduled`.

## Tests

`e2e/email/enumeration.spec.ts` (same answers, owner notice, hash accounting),
`e2e/email/housekeeping.spec.ts` (the sweep, on a private Worker),
`e2e/email/turnstile-off.spec.ts` and `e2e/tests/auth/signup-hardening-off.spec.ts`
(unchanged behaviour without it), `e2e/turnstile/` (the check on, against a local
Siteverify and a stand-in widget script) and `e2e/installer/turnstile.spec.ts`. The
specs read where password hashes are spent through `GET /api/_probe/hash`, which
answers `404` unless `HASH_PROBE=1` (test configs only, like the mail capture).
