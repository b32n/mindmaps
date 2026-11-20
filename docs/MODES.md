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
the setting existed, so existing installs, including the hosted service, are
unchanged until you set it.

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

- **Installer** (`npm run install:cloudflare`): asks "personal or org?" and
  writes the answer to `wrangler.local.toml`. Non-interactively:
  `--mode personal|org|multitenant`; with `--yes` and no `--mode` a first
  install is `personal`. `multitenant` is never offered in the prompt, only by
  `--mode multitenant`. Re-running the installer keeps the mode the install
  already has (an install from before modes existed stays unset, so it stays
  multitenant) unless you pass `--mode`. `--dry-run` shows what it would write
  without signing in to anything.
- **By hand**: under one `[vars]` table in the Worker's config:

  ```toml
  [vars]
  MINDMAPS_MODE = "personal"
  ```

  or in the Cloudflare dashboard: *Workers & Pages → your Worker → Settings →
  Variables and Secrets*. Redeploy after editing the file.
- **Deploy to Cloudflare button**: the committed `wrangler.toml` leaves the
  variable unset, so a button install starts as `multitenant` (unchanged
  behaviour). Set it to `personal` or `org` as above after the deploy. The
  installer's `personal` default applies to the CLI path only for now:
  committing `personal` to `wrangler.toml` would also change any deployment
  built straight from that file, the hosted service included.

## Changing it later

Edit the value (or re-run `npm run install:cloudflare -- --mode org`) and
deploy. No migration is involved and no data is touched. Since nothing is
enforced yet, switching today changes only what is reported.
