# Security policy

Thank you for taking the time to look at Mindmaps. If you think you have found a
security problem, please tell us privately first so it can be fixed before it is
public.

## Supported versions

Mindmaps is deployed from this repository, so only the latest code is supported:

| Version | Supported |
| --- | --- |
| `main` (the latest commit, and what the hosted instance runs) | yes |
| Anything older, including old forks and old self-hosted deploys | no, update to `main` |

If you run your own instance, `npm run deploy` brings it up to date (see
[INSTALL.md](INSTALL.md)).

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for `b32n/mindmaps`:

**https://github.com/b32n/mindmaps/security/advisories/new**

That opens a private advisory that only the maintainers can see. Please do not
open a public issue or pull request for a vulnerability, and do not post it
anywhere public until it has been fixed.

The same address is published as the `Contact` in
[`/.well-known/security.txt`](https://mindmaps.b32n.io/.well-known/security.txt)
(RFC 9116) on the hosted instance.

### What to include

The more of this you can give, the faster it can be looked at:

- what is affected: the hosted instance (`mindmaps.b32n.io`) or the code, and the
  commit or date if you know it
- what you found and why it matters (what an attacker gains)
- steps to reproduce, or a small proof of concept
- any requests, responses or logs that show it, with your own data rather than
  anyone else's
- whether you plan to publish, and your deadline if you have one

You do not need to have a fix, but one is welcome.

## What to expect

This is a small open-source project, so these are intentions, not guarantees:

- we aim to acknowledge a report within a few working days
- we aim to tell you whether we consider it a vulnerability, and what happens
  next, within a couple of weeks
- we will keep you informed while it is fixed, and credit you in the advisory if
  you would like that
- we would like to agree a disclosure date with you, and will ask for a
  reasonable window to ship a fix first

There is no bug bounty.

## Scope

In scope:

- the code in this repository (the Worker, the web app, the MCP server and the
  OAuth endpoints, the installer)
- the hosted instance at `https://mindmaps.b32n.io`

Out of scope:

- **Self-hosted instances.** Each is run by its operator, on their own Cloudflare
  account, with their own configuration. Report a problem in the *code* here; for
  a problem with a particular deployment, contact whoever runs it.
- vulnerabilities in Cloudflare, GitHub, Google or other third-party services
  themselves: report those to the vendor
- denial of service, volumetric or rate-based testing, and automated scanning
  that generates heavy traffic
- social engineering or physical attacks against maintainers or users
- missing best-practice headers or settings with no demonstrable impact,
  reports from automated scanners without a working exploit, and issues that
  need an already-compromised device or browser

## Safe harbour

If you act in good faith under this policy we will not pursue or support legal
action against you for your research. Good faith means you:

- only test against accounts and data you own or have explicit permission to
  use; create your own account on the hosted instance if you need one
- do not access, change, keep or share other people's data beyond what is
  strictly needed to show the problem, and stop and report if you come across it
- do not degrade the service for others, and do not run denial-of-service tests
- do not use a finding to move laterally, persist, or exfiltrate data
- give us a reasonable chance to fix the problem before disclosing it

This is the maintainers' statement about the project and the hosted instance. It
cannot bind other people's self-hosted instances or third-party services, and it
is not legal advice.
