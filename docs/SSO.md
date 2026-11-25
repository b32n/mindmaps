# Single sign-on and verified domains

Policy lives **per organisation**, never site-wide. It applies in org mode (the
one organisation) and in multitenant mode (each organisation). A personal install
refuses all of it: the API answers 403 `team_spaces_disabled` and the app shows
none of it. See [MODES.md](MODES.md).

Everything below is in the organisation's workspace dialog (workspace menu, the
people icon): **Domains**, **Policy** and, for the owner, **Single sign-on**.

## Who can do what

| | owner | admin | editor / viewer | outsider |
|---|---|---|---|---|
| Add, verify, remove a domain | yes | yes | no | no |
| Policy (auto-join, default role, restrict invites) | yes | yes | no | no |
| Configure, test, enable and enforce SSO | yes | no | no | no |

SSO is the owner's alone: whoever picks the identity provider can sign in as
anyone on the organisation's domains, and an admin must not be able to become the
owner that way. A stranger and a missing workspace both get a 404.

## Verified domains

1. Add a domain (`example.com`). The app issues a random token.
2. Publish a DNS TXT record: name `_mindmaps-verify.example.com`, value
   `mindmaps-verify=<token>` (the settings show the exact strings).
3. Press **Verify**. The Worker asks a resolver over DNS-over-HTTPS (Cloudflare's
   JSON API at `https://cloudflare-dns.com/dns-query`; set `DOH_ENDPOINT` to use
   another) and looks for that value.

A domain is *held* by one organisation at a time: a unique index on active
verified rows decides a race. Several may *claim* it, but only the first to prove
it holds it. Removing a domain is soft (status and timestamps), after which
another organisation may verify it. A lookup that fails (the resolver is down,
SERVFAIL) is reported as such (502) and changes nothing; "no such record" is a 422.

## Policy

Policy applies to **verified domains only**.

- **Auto-join.** A signed-in person whose address is on a verified domain, **and
  whose address is proven**, is offered a **Join** button (a banner in the app) and
  joins with the default role the admin chose (viewer or editor). It is an explicit
  step, never silent. *Proven* means the session came through Google or through
  this organisation's SSO. Password-only accounts are unproven: anyone can type
  an address into a password form. They are told that proving it would unlock a
  join, and nothing more (the organisation is not named). When email verification
  from the email-setup work lands, a verified address will count as proven too.
- **Restrict invites.** Optional. Invitations may only go to addresses on a
  verified domain. The owner and admins are never locked out by it.

## SSO (OpenID Connect)

One OIDC provider per organisation. Configure **issuer** (https, no query),
**client ID** and **client secret**, and register the redirect URI shown in the
settings (`<your origin>/api/auth/sso/callback`) with the provider.

States: *not configured → saved → tested → on*. **Test** runs the real flow in the
owner's browser and must succeed before SSO can be turned on. Changing the issuer
or client ID resets it and asks for the secret again.

The flow is the authorization-code flow with PKCE (S256), `state` and `nonce`.
The id_token's signature is checked against the provider's JWKS (RS256 or ES256
only), then `iss`, `aud`, `exp`, `nonce`, and `email_verified` must be true.

**Signing in.** On the login page, type your work email and choose **Sign in with
SSO**: the address's domain names the organisation, and its provider does the rest.
A person is matched to an existing account by email, or an account is created
subject to the mode's sign-up rules (in org mode, someone their provider vouches
for on a verified domain may have an account; having one joins nothing, that is
**Join** or an invitation). The provider's subject is stored in a link table.

### Enforce SSO

When on, people whose address is on one of the organisation's verified domains
reach **that organisation** only through its SSO. A password or Google session
gets 403 `sso_required` for its workspace, its mindmaps and nodes, and they are
left out of lists and search. Other organisations and the person's personal
mindmaps are unaffected. People with addresses elsewhere (a contractor) are not
subject to it. It can be turned on only while SSO is on.

MCP respects it: the consent page does not offer that workspace to a session that
did not come through the SSO, a tampered form is refused, and an existing connection
is locked out the moment enforcement is turned on (and back in when it is off).
A connection made from an SSO session carries that proof, including across
token refresh.

### Break-glass

If the provider is down or misconfigured, the **owner** (only) keeps the settings
of their organisation reachable from a password session: Policy and SSO, so
enforcement can be switched off. Content stays locked until it is. Admins have no
such path. If the owner cannot reach the app at all, switch it off in D1:

    npx wrangler d1 execute <db> --remote --command \
      "UPDATE org_policies SET enforce_sso = 0 WHERE workspace_id = '<id>'"

## The client secret

The client secret is stored encrypted (AES-256-GCM, bound to the organisation)
and is never returned by any API response; the settings only know that one is
stored. The key is the Worker secret `SSO_SECRET_KEY` if you set it
(`npx wrangler secret put SSO_SECRET_KEY`, any long random string). If you do not,
one is generated on first use and kept in the database next to the ciphertext. That
keeps the secret out of logs, column dumps and partial exports, but not from someone
who can read the whole database; set the Worker secret to separate the two. Changing
it later means entering the client secret again.

## Reference

API: `GET /api/workspaces/:id/security`, `POST .../domains`,
`POST .../domains/:id/verify`, `DELETE .../domains/:id`, `PUT .../policy`,
`PUT|DELETE .../sso`, `POST .../sso/test|enable|enforce`, `GET /api/join-offers`,
`POST .../join`, `POST /api/auth/sso/start`, `GET /api/auth/sso/callback`.
Migration: `0032_sso_domains.sql` (additive; new tables carry status and
created_at/updated_at, nothing is hard-deleted).
