# Deployment modes

Every mindmaps instance runs in one of three modes, set by the `MINDMAPS_MODE`
variable on its Worker.

| Mode | What it is for |
|---|---|
| `personal` | Your own install: just you, plus the people you invite one by one. |
| `org` | A team or company running its own instance. |
| `multitenant` | The hosted service: many unrelated customers on one instance. Hidden and advanced; self-hosters do not need it. |

## What each mode does

The Worker reads the setting (`worker/src/mode.ts`), and every decision that
depends on it is made in one place on each side: `worker/src/policy.ts` and
`web/src/policy.ts`. `GET /api/auth/me` returns it as `mode`, the web app
exposes it as `useMode()` (and as `data-mindmaps-mode` on `<html>`), and the MCP
`initialize` and `server/discover` results carry it in `_meta["mindmaps/mode"]`.

| | personal | org | multitenant (and unset) |
|---|---|---|---|
| Workspace switcher, "New workspace", People for a team space | hidden | as before | as before |
| `GET /api/workspaces` | your personal home only | as before | as before |
| `POST /api/workspaces` | 403 `team_spaces_disabled` | as before | as before |
| A mindmap created into a named workspace | 403 `team_spaces_disabled` | as before | as before |
| Inviting someone into a team space | 403 `team_spaces_disabled` | as before | as before |
| Mindmap list, artefact list, recall (app and MCP), `search` | the personal home, plus what was shared with you | as before | as before |
| MCP consent page | no workspace picker; connects to the personal home | picker when you have more than one workspace | as org |
| MCP tools | no `workspace` argument; `list_mindmaps` does not name workspaces | as before | as before |
| Sharing (people, public links) | untouched | as before | as before |

**multitenant is exactly what every install did before modes existed.** The
hosted service is pinned to it (below), so none of this changes there.

**org keeps today's shared-workspace behaviour.** One organisation per instance
is the intent; first-run setup, create-organisation, single sign-on and the
organisation lifecycle (rename, close, leave, accepting an invite) are separate,
later work, and nothing here offers or implies them.

### Personal

Personal is one person's instance. There is no team-space concept in the app, the
API or MCP. Sharing is not part of that and is untouched:

- someone with no account is invited by email, signs up, and gets the mindmap
  (as editor or viewer); an artefact can be given to anyone through a public
  read-only link, no account needed;
- another person on the same instance gets a mindmap or an artefact by email,
  whichever workspace either of you is in;
- a mindmap shared with you shows in your list and opens by its id, wherever it
  lives.

### Switching an install to personal

Switching an install that already has team spaces to personal **hides them; it
deletes, moves and migrates nothing.** Every row stays as it is (the workspace,
its members, its mindmaps and cards, shares, agent connections). Switch back to
org or multitenant and they are listed again, with everything in them.

What "hidden" covers, exactly:

- **Listed nowhere.** Not in the switcher (which is gone), `GET /api/workspaces`,
  the mindmap and artefact lists, recall and search in the app, or `list_mindmaps`,
  `search` and `recall` over MCP. A card in a hidden space never shows up in a
  result, nor as a linked card ("connects to").
- **Nothing new in them.** Creating a workspace, creating a mindmap in one by
  `workspace_id`, inviting a person into one, and an agent choosing one (the
  `workspace` argument is gone; `create_mindmap` writes to the personal home) are
  all refused or ignored. An agent connected to a team space before the switch
  keeps working, in the personal home, and goes back to the team space when the
  mode is switched back.
- **A mindmap already shared with someone keeps working for them**, even when it
  sits in a hidden team space. Sharing is not removed or weakened by hiding: the
  person it was shared with still has it in their list, opens it by its id, and
  keeps the role they were given. The owner of that mindmap does not see it in
  their own list while the space is hidden, but can still open it by its id and
  can still share it again.
- **Hiding is not an access boundary.** A direct request by id for something you
  could already read is answered as it always was, including for the members of a
  hidden team space. Personal mode removes the *offer*, not the data or the
  rights; if you need people kept out of a space, remove them from it first.
- **Account deletion is still guarded.** Owning a team space that other people are
  in blocks deleting your account in every mode (`GET /api/account/delete-blockers`
  is unchanged). In personal mode the settings dialog says the space is hidden and
  to switch the instance to org to manage it, instead of pointing at a menu that
  is not there. Ownership transfer, role changes and removing members still work
  through the API.

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
deploy. No migration is involved and no data is touched: switching to `personal`
hides team spaces and switching back shows them again (see above).
