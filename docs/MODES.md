# Deployment modes

Every mindmaps instance runs in one of three modes, set by the `MINDMAPS_MODE`
variable on its Worker.

| Mode | What it is for |
|---|---|
| `personal` | Your own install: just you, plus the people you invite one by one. |
| `org` | A team or company running its own instance. |
| `multitenant` | The hosted service: many unrelated customers on one instance. Hidden and advanced; self-hosters do not need it. |

## What is enforced today

**Nothing yet.** This release only adds the setting and passes it along, so
changing it has no visible effect and deploying it is safe:

- the Worker reads and validates it (`worker/src/mode.ts`);
- `GET /api/auth/me` returns it as `mode`, and the web app exposes it as
  `useMode()` (and as `data-mindmaps-mode` on `<html>`);
- the MCP `initialize` and `server/discover` results carry it in
  `_meta["mindmaps/mode"]`. No tool schema changes.

A later release makes the app and MCP server honour it. What is decided for
that, so you can plan around it:

- **Personal keeps today's sharing.** External viewers and editors (email-code
  sign-in), other people in the same workspace, and people in other workspaces
  all keep working. Personal mode will not remove any of them.
- **Switching an install to personal later hides team spaces; it deletes
  nothing.** Switch back and they return.
- **SSO and a sign-in domain policy** ship before the modes are launched.

## If it is unset, or empty

The Worker behaves as `multitenant`. That is how every install behaved before
the setting existed, so existing installs are unchanged until you set it. (The
committed `wrangler.toml` now sets `personal`, which is what a Deploy-button
install gets; see below. An install that has its own `wrangler.local.toml`
without a mode stays unset on a re-run.)

## If it is invalid

A value that is not one of the three (a typo such as `personnal`, a different
case such as `Personal`) is refused rather than guessed at. The Worker answers
**every request with HTTP 500**, JSON `{ "error": "MINDMAPS_MODE is \"personnal\", which is not a mode. Use one of: personal, org, multitenant …", "code": "invalid_mode" }`,
and logs the same line. That covers the API, sign-in and sign-up, the MCP and
OAuth endpoints; the scheduled re-indexing skips its run. The app's page still
loads, because static files are served without reaching the Worker, and its
sign-in form shows the message. Fix the value and deploy. Surrounding
whitespace is ignored; nothing else is normalised.

(It fails closed on purpose: falling back to `multitenant` would quietly run a
mistyped `personal` or `org` install in the most permissive mode.)

## How it is set

- **Deploy to Cloudflare button**: the committed `wrangler.toml` sets
  `MINDMAPS_MODE = "personal"` under `[vars]`, so a button install is
  `personal`. Change it as below after the deploy.
- **Installer** (`npm run install:cloudflare`): asks "personal or org?" and
  writes the answer to `wrangler.local.toml`, replacing the committed default
  (the generated file has exactly one `MINDMAPS_MODE`). Non-interactively:
  `--mode personal|org|multitenant`, which overrides the default and the
  question; with `--yes` and no `--mode` a first install is `personal`.
  `multitenant` is never offered in the prompt, only by `--mode multitenant`.
  Re-running the installer keeps the mode the install already has unless you pass
  `--mode`. An install from before modes existed has none set and gets none
  written, so it stays multitenant (the template's `personal` is not copied in).
  `--dry-run` shows what it would write without signing in to anything.
- **By hand**: under one `[vars]` table in the Worker's config:

  ```toml
  [vars]
  MINDMAPS_MODE = "personal"
  ```

  or in the Cloudflare dashboard: *Workers & Pages → your Worker → Settings →
  Variables and Secrets*. Redeploy after editing the file.

## The hosted service is pinned to multitenant

The hosted service, `mindmaps.b32n.io` (one named constant, `HOSTED_HOST` in
`scripts/lib/install-config.mjs`), must stay multitenant now that the committed
default is `personal`. It is pinned in two places. The hosted Worker is not
deployed by CI; it is deployed from a `wrangler.local.toml`, by one of these:

- **The installer.** When the install is that host (`--domain mindmaps.b32n.io`,
  or an existing `wrangler.local.toml` whose `PUBLIC_ORIGIN`, `APP_ORIGIN` or
  `[[routes]]` pattern is that host, with or without `https://`), it writes
  `MINDMAPS_MODE = "multitenant"` explicitly, also when that install had no mode
  before and also under `--yes`. `--mode multitenant` is accepted; `--mode
  personal` or `--mode org` is refused with an error before anything is signed
  in to or written, and the prompt does not ask. A re-run without `--domain`
  keeps the host.
- **`npm run deploy`** (`scripts/deploy.mjs`). It deploys with
  `--config wrangler.local.toml` when that file exists (otherwise it would take
  the committed `personal` default and no database IDs). For the hosted host it
  also passes `--var MINDMAPS_MODE:multitenant`, and it refuses to run if the
  config says `personal` or `org`. Any other install keeps the mode its own
  config sets.

Not covered: a raw `wrangler deploy` that uses only the committed
`wrangler.toml`, or a different value set in the Cloudflare dashboard (a
deploy replaces dashboard variables unless `--keep-vars` is used).

## Changing it later

Edit the value (or re-run `npm run install:cloudflare -- --mode org`) and
deploy. No migration is involved and no data is touched. Since nothing is
enforced yet, switching today changes only what is reported.
