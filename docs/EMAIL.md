# Email

mindmaps can send email through Cloudflare Email Sending. It uses it for two
things: confirming an address, and resetting a password. Nothing else is sent:
no newsletters, no notifications, no tracking.

Email is optional. Without it the app works as it always did, and the two
features say they are unavailable (see "Without email").

## Turning it on

The installer does it. It needs a domain on your Cloudflare account (a
`*.workers.dev` address cannot send mail).

```
npm run install:cloudflare -- --domain notes.example.com          # sends from mindmaps@notes.example.com
npm run install:cloudflare -- --mail-domain example.com           # your app is elsewhere; send from example.com
npm run install:cloudflare -- --mail-from hello@example.com       # choose the address too
npm run install:cloudflare -- --no-email                          # no email (also removes it from an install that has it)
```

Interactively it asks for the sending domain (default: your app's domain) and the
address. With `--yes` and a `--domain` it uses `mindmaps@<domain>`; with `--yes`
and no domain it skips email and says so.

What it does for the domain, in order:

1. finds the Cloudflare zone that holds it;
2. enables Email Sending for it (the `email/sending/subdomains` API);
3. adds any DNS records Cloudflare lists for it (MX, SPF, DKIM and DMARC) that
   are not already there;
4. writes the `[[send_email]]` binding and `MAIL_FROM`, `MAIL_FROM_NAME`,
   `MAIL_DOMAIN` to `wrangler.local.toml`, then deploys.

Steps 1 to 3 need an API token: the installer uses `CLOUDFLARE_API_TOKEN` if set,
and otherwise tries the `wrangler login` token. Make one with **Email Sending:
Edit**, **Zone: Read** and **DNS: Edit**. If the token is missing or lacks a
permission, the installer cannot check the domain, **does not turn email on**, and
prints what to do instead:

- Dashboard → Compute → Email Service → Email Sending → **Onboard Domain** →
  choose the domain (the dashboard adds the DNS records), then
- re-run with `--mail-skip-check`, e.g.
  `npm run install:cloudflare -- --mail-from hello@example.com --mail-skip-check`,
  which writes the email config without the check.

It stays off until the domain is known to be ready, because with verification on
and no mail arriving, an invited person could not join (below).

Re-running is safe. A re-run without email flags keeps the sender the install has
and never switches email off because it could not re-check; flags change it;
`--no-email` removes it. The hosted service's host stays pinned to multitenant
whatever the email flags say.

A Deploy to Cloudflare button install starts without email (the committed
`wrangler.toml` has no binding). Run the installer once with `--mail-domain` to add it.

### What the Worker reads

| Setting | Meaning |
|---|---|
| `[[send_email]] name = "EMAIL"` | the Email Sending binding |
| `MAIL_FROM` | sender address; email is off when it is empty |
| `MAIL_FROM_NAME` | display name (default `mindmaps`) |
| `MAIL_DOMAIN` | the sending domain; for the installer's re-runs |
| `PUBLIC_ORIGIN` / `APP_ORIGIN` | the origin the links in mail point at. Set it with a custom domain (the installer does); otherwise it is the address the request arrived on |
| `CLIENT_IP_HEADER` | header with the client's address for rate limits, default `cf-connecting-ip` |

Sending needs the Workers Paid plan to reach arbitrary recipients (Cloudflare's
rule, not ours).

## Confirming an address

A password sign-up is emailed a link to `/verify-email?token=…`. (Sign-up does not
sign anyone in where email is on, and answers the same for an address that is taken:
see [SIGNUP.md](SIGNUP.md).) The link:

- works once and expires after 24 hours;
- is stored only as a SHA-256 hash, in `email_tokens`, and is never deleted: its
  `status` moves from `active` to `used`, `superseded` (a newer link was sent),
  `revoked` (the account was deleted or its password reset) or `expired` (marked by
  the scheduled sweep once past its time, see SIGNUP.md);
- is confirmed by pressing a button on the page, not by opening it, so a mail
  scanner that fetches links cannot use it up.

Asking for another link (the banner in the app, or `POST /api/auth/resend-verification`)
retires the previous one. It is limited to 3 an hour per account.

Google counts as verifying: when Google reports the address as verified, the
account is verified at once and no email is sent.

### What an unverified account can and cannot do

Can: sign in, use its own personal space, create and edit its own mindmaps,
connect agents over MCP, and invite other people.

Cannot: **claim or accept invitations addressed to its email.** An invite for an
address waits as a pending invite, whether the address already had an account or
signs up later. It cannot be accepted until the address is verified; after that it
is the person's to accept, and joins them to nothing until they do. This closes
the takeover where someone registers another person's address to inherit the
workspaces they were invited to. Being invited to an unverified account likewise
leaves a pending invite rather than adding the account.

It also means: if someone registered an address they do not own, then the real
owner signs in with Google or resets the password, the account is theirs: Google
linking to an unverified password account **removes the password and ends its
sessions**; a completed reset replaces the password and ends all sessions.

### Existing accounts

Every account that exists when the migration (`0033_email_auth.sql`) runs is
marked verified (`email_verified_via = 'grandfathered'`). They were using invites
long before verification existed, and un-verifying them would lock people out.
An address squatted before this release therefore stays trusted; a password
reset by the real owner fixes that.

## Resetting a password

`/forgot-password` asks for an address. The answer is the same whether or not an
account exists (and the rate limit counts the address either way), so it does not
reveal who is registered. If there is an account, it is mailed a link to
`/reset-password?token=…` that works once and expires after one hour.

Using it checks the new password against the usual policy first (a weak one does
not spend the link), then sets it and:

- marks the address verified (the link proved it),
- signs the account out of every browser session,
- revokes every MCP/OAuth token and pending authorisation code.

It does not sign anyone in; the person signs in with the new password.

## Limits

Counted in D1 (`rate_limits`), fixed windows, keyed by hashed address and by
client address:

| What | Limit |
|---|---|
| Sign-up | 10 an hour per client |
| "Someone tried to sign up with your address" mails | 3 an hour per address |
| Sign-in, failures only | 10 per 15 minutes per address; 30 per client |
| Resend verification | 3 an hour per account; 20 per client |
| Request a password reset | 3 an hour per address; 20 per client |
| Use a reset link | 20 an hour per client |
| Confirm an address | 30 an hour per client |

Over a limit the answer is `429` with `code: "rate_limited"` and `Retry-After`.
Sign-in counts only failures, so a correct password is never locked out by its own
successes, but a locked address stays locked for the window even for the right
password. The per-client limits are skipped when the request carries no client
address. Rows are reused in place; a scheduled sweep marks the ones whose window has
passed and removes counters a week after that (SIGNUP.md, "Housekeeping"). Every limit is
counted before any password hash is spent.

## Without email

When `MAIL_FROM` or the binding is missing:

- `GET /api/auth/me` has `emailEnabled: false`;
- sign-up works and sends nothing, signs the new account in, and still answers `409`
  for a taken address (there is nobody to tell instead; SIGNUP.md explains the cost);
  the app shows no banner and no "Forgot your password?" link;
- `POST /api/auth/forgot-password` and `/resend-verification` answer `501` with
  `code: "email_unconfigured"`; the `/forgot-password` page says email is not set
  up and to ask whoever runs the instance;
- links already issued are refused as invalid;
- **invites are accepted as before**, with no verification required. Nobody could
  ever verify, so enforcing it would only stop invited people joining. The takeover
  above is therefore open on an instance without email, exactly as it was before
  this feature. That is the reason to turn email on.

If email is turned on later, accounts created while it was off are unverified and
see the banner; memberships they already hold are untouched.

If a send fails (Cloudflare refuses, the domain is not ready), the request that
asked for it still succeeds and the failure is logged without the message; the
person can ask again.

## Not covered yet

- Changing the email on an account.
- A CAPTCHA on sign-in. Turnstile guards sign-up, forgot-password and
  resend-verification ([SIGNUP.md](SIGNUP.md)); sign-in relies on the limits above,
  which slow a single source but do not stop a distributed one.

## Tests

(Sign-up, Turnstile and housekeeping specs are listed in [SIGNUP.md](SIGNUP.md).)

`e2e/email` runs against a Worker whose `MAIL_TRANSPORT` is `capture`: nothing is
sent, messages are kept in R2 and read back through `GET /api/_mail?to=…`, which
answers `404` unless that transport is set. Never set it on a real install. A fake
Google (`e2e/support/fake-google.mjs`) stands in for Google's token endpoints.
