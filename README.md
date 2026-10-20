# mindmaps

A spatial surface for thinking. Mindmaps of cards that hold real documents,
connected by labelled links, and readable and writable by your AI agents over
MCP, so they remember between sessions.

**You own it.** It runs in your own Cloudflare account. Your data sits in your
database and your storage. There is no server of ours in the middle, no
telemetry, and no account with us. The free Cloudflare plan is enough.

## Install (about five minutes)

Pick whichever fits you. All three end at the same place: your own copy, at your
own address.

### 1. One click, no terminal

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/b32n/mindmaps)

Sign in to Cloudflare (or make a free account), click through, done. Cloudflare
copies this project into your GitHub, creates the database and storage, and
deploys it. Then open the address it gives you and create your account. The
first account is the owner.

### 2. Ask your agent to do it

Paste this into Claude Code, Codex, Cursor, or any agent that can run commands:

> Install mindmaps for me from https://github.com/b32n/mindmaps. Clone it and
> follow AGENTS.md. I'll need to approve a Cloudflare login in my browser.

### 3. One command

```bash
git clone https://github.com/b32n/mindmaps && cd mindmaps
npm install && npm run install:cloudflare
```

It signs you in, creates everything, deploys, and prints the command to connect
your agent. Re-run it any time to update. More options (your own domain, HTML
artefacts, troubleshooting) are in [INSTALL.md](./INSTALL.md).

- [DESIGN.md](./DESIGN.md): the board: structure, canvas decisions, data model
- [MCP.md](./MCP.md): the MCP server: letting agent harnesses read and write
  the board as durable memory between sessions
- [INSTALL.md](./INSTALL.md): installing, updating, custom domains, who can sign up

Not a coding tool. Code stays in your IDE.

## Stack

| | |
|---|---|
| Frontend | React + Vite, served as static assets by the Worker |
| Canvas | `@xyflow/react` (MIT) + `perfect-freehand` (MIT) ink layer |
| Backend | Cloudflare Workers: one Worker, one origin |
| Database | D1, via rerunnable migrations |
| Files and images | R2 |
| Search | Workers AI + Vectorize (optional; keyword search without) |
| Agents | None hosted. An MCP server; your harness is the agent. |

## Run locally

```bash
npm install
npm run db:migrate        # idempotent, safe to re-run
npm run dev               # API + MCP on :8787
npm run dev:web           # in a second terminal: the app on :5173
```

Local state lives in `.wrangler/` and optional secrets in `.dev.vars` (copy
`.dev.vars.example`). Nothing needs a Cloudflare login or any API key.

## Connect an agent harness (MCP)

The Worker exposes an MCP server so Claude Code, Cursor, or anything else that
speaks MCP can read and write your mindmaps as memory between sessions.

```bash
# Claude Code
claude mcp add --transport http mindmaps <your-url>/mcp

# Codex
codex mcp add mindmaps --url <your-url>/mcp
```

Cursor, in `~/.cursor/mcp.json` (or `.cursor/mcp.json` for one project):

```json
{ "mcpServers": { "mindmaps": { "url": "<your-url>/mcp" } } }
```

Anything else: point it at `<your-url>/mcp` as a **streamable
HTTP** MCP server. There is no bespoke integration per tool, just the spec.

(Locally: `http://localhost:8787/mcp`.)

**Several harnesses can share one brain.** Tokens are issued per client, not per
account, so Claude Code, Codex and Cursor can all be connected at once and read
the same boards. What one works out, the next one can recall. Settings lists
every harness holding a token and disconnects them one at a time.

### Make it use the memory without being asked

Connecting the server makes the tools available. It does not make an agent reach
for them. The server sends `instructions` on initialize and the tool
descriptions push the same way, but both are advisory: harnesses differ on
whether they inject them, models differ on whether they act.

A few lines in your own instruction file outranks all of that. Paste this into
`~/.claude/CLAUDE.md` (Claude Code), `~/.codex/AGENTS.md` (Codex), Settings →
Rules → User Rules (Cursor), or an `AGENTS.md` at your repo root for anything
else:

```markdown
## Memory

You have a persistent memory called mindmaps, connected over MCP. It outlives this session.

- Before starting anything non-trivial, call `recall` with what you are about to work on. Do it before reading files.
- When you finish something that took real digging, write it down with `add_to_mindmap` or `add_card`, and pass a stable `key` so running it again updates what is there instead of leaving a duplicate.
- Put it somewhere sensible. `recall` tells you which mindmap each match came from, so extend that one. If nothing matched, check `list_mindmaps` for a home before making a new one.
- Only use `create_mindmap` for a genuinely new subject, not for every new fact. A mindmap is something you will come back to over weeks. A card is one thing you learned. When unsure, add a card to a mindmap that already exists.
- Link what you write to whatever `recall` returned, using `link_cards` and a verb: blocks, explains, supersedes. Links can cross mindmaps.
```

Two of those bullets are doing the work. Recall has a natural trigger, since a
question turns up and the agent goes looking, but writing has none, so it has to
be tied to finishing a task or it never happens. And an agent told only to
"write it down" will either pile everything onto whichever board it saw first or
start a fresh mindmap per fact, so it needs to be told how to choose.

Note for Cursor: `.cursorrules` is deprecated and current builds read User Rules,
`.cursor/rules/*.mdc`, or `AGENTS.md`.

A new account starts with one mindmap, **Start here**, which carries that
command and doubles as the tour — a card that opens into a document, two cards
joined by a labelled link. It is written once at registration and says to delete
it, so deleting it is permanent. It is deliberately the only seeded board: a
board that needs hand-updating to stay true is a board you stop opening
(DESIGN.md §7), which rules out the usual TODO/roadmap starter set.

That's the whole setup. **No API key.** The first tool call returns a 401 with a
`WWW-Authenticate` challenge, your harness opens a browser, you sign in to the
board and approve, and it gets an OAuth token scoped to your account. Sign-in
uses the same password or Google account as the web app.

### Tools

| Tool | Scope | Does |
|---|---|---|
| `recall` | read | **start here** — search by wording and meaning, follow the links, get a ranked briefing |
| `list_mindmaps` | read | names, card counts, ids |
| `get_mindmap` | read | a whole map as markdown, with ids and checklist state |
| `get_card` | read | one card's full document |
| `search` | read | titles and documents across all maps, ranked by relevance |
| `get_context` | read | walk outward from a card through its links, across mindmaps |
| `create_mindmap` | write | a graph of nodes + labelled edges; positions computed here |
| `add_to_mindmap` | write | extend a map; new nodes land below existing ones |
| `relayout_mindmap` | write | re-arrange a whole map `right` or `down`, moving cards and re-attaching every link |
| `link_cards` | write | link two cards, **on the same mindmap or across two of them** |
| `update_link` | write | change a link's label or which sides it attaches to |
| `unlink_cards` | write | remove a link, by its id or the pair it joins |
| `add_card` | write | one card; takes `open_at` |
| `update_card` | write | replace title and/or document; takes `open_at` |
| `append_to_card` | write | add to a document without discarding it |

`create_mindmap` and `add_to_mindmap` also take `direction` (`right` or `down`),
which sets both the layout axis and which sides links attach to. Got it wrong?
`relayout_mindmap` turns the whole map round afterwards.

Pass a stable `key` to `create_mindmap` or `add_card` on anything you might
record again: a second call with the same key updates what is there instead of
leaving a near-duplicate behind. Positions you have arranged by hand survive,
and cards a later run omits are kept rather than deleted.

`open_at: "bottom"` marks a card as a running log, so it opens scrolled to the
end — the newest entries first. Per card, not per mindmap: one map holds both
task lists and reference cards.

Each mindmap has its own address — `/app/<id>`, plus `?card=<id>` for whatever
is open — so a reload lands you back where you were, Back and Forward retrace
your steps, and the link in the address bar is worth sending to someone.

**To link across mindmaps from the board**, drag out of a card's handle and
release on empty canvas. A picker offers either an existing card — drill into
any mindmap, then choose — or a new card created right there. A direction
toggle decides which way the arrow runs. Picking a card on another mindmap
creates the link and drops a stub pointing to it.

On the board, hovering a link shows two controls: flip it between side-to-side
and top-to-bottom, or remove it. Either endpoint can also be dragged onto a
different handle or card. Link labels counter-scale against zoom, so they stay
legible and clickable however far out you are.

### Board view state

A board reopens where you left it — pan, zoom, and the card you had open —
stored per browser in `localStorage`, because a viewport is tied to a screen
size and syncing it would let a 27" monitor decide what a laptop sees.

The home icon in the topbar manages a **home view**: a declared pan/zoom/open
card stored on the board itself. It decides how the board opens on a device
that has never seen it; after that your own position takes over, with "Go to
home view" to return. Both fall back to fit-to-content if the saved view has
gone stale — the card was deleted, or the region it framed is now empty.

### Revoking access

Settings (bottom of the rail) lists every harness holding a token, grouped by
app, with a Disconnect button. Tokens are also revocable directly:

Agents write prose as **markdown**; we convert it to the editor's block format
and keep a markdown projection for search and context. See
[MCP.md](./MCP.md) §4–5 for why that direction rather than the reverse.

```bash
curl -X POST <your-url>/oauth/revoke -d "token=<access or refresh token>"
```

## Deployment

See [INSTALL.md](./INSTALL.md). In short, `npm run install:cloudflare` the first
time, and again after every `git pull`.

One Worker serves the API, the MCP endpoint and the built React app from a
single origin. That is load-bearing, not tidiness: the OAuth consent screen
reads the board's session cookie, and splitting the app and API across two sites
would either drop that cookie (`SameSite=Lax`) or force it down to
`SameSite=None`.

Two things that bite only in production, both already handled:

- **`/register` is the app's sign-up page**, so the OAuth client-registration
  endpoint lives at `/oauth/register`.
- **PBKDF2 is capped at 100,000 iterations** on the production runtime;
  `worker/src/auth.ts` chains three rounds to reach 300,000. Read the comment
  there before changing it.

The OAuth issuer is `PUBLIC_ORIGIN` when set, otherwise the address the request
arrived on.

## Enable research

### Authenticating to Anthropic

Two options. The Worker accepts **either** — it picks the right header for each
(an OAuth token on `x-api-key` is rejected; it goes on `Authorization: Bearer`
with the `oauth-2025-04-20` beta).

**A. OAuth — preferred locally.** No long-lived key on your machine:

```bash
brew install anthropics/tap/ant
ant auth login                                   # browser, stores a profile
export ANTHROPIC_AUTH_TOKEN=$(ant auth print-credentials --access-token)
```

Put that in `.dev.vars`. The token is **short-lived and not
auto-refreshed** once copied out, so re-run `print-credentials` when calls start
failing with 401. Note `--access-token` is required — the bare command prints
JSON, not a token.

**B. API key.** Required for deploys (see below):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

> **Why the deployed Worker can't use OAuth.** `ant auth login` stores a profile
> on *your machine* and the CLI refreshes it; a Cloudflare Worker can't read
> that. The documented path for non-interactive workloads is Workload Identity
> Federation, which needs the platform to hand the workload an OIDC identity
> token — Cloudflare Workers don't expose one. So production uses an API key
> stored as a Worker secret, which at least means it never reaches the browser.
>
> Separately: this authenticates *the application*, not each end user. Managed
> Agents sessions bill to the org's credentials either way. Per-user OAuth
> (Linear, GitHub) is a different mechanism — vaults.

### Create the agent

```bash
npm run setup      # honours either credential; creates agent + environment ONCE
```

Put the printed IDs in `.dev.vars` (gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...        # or ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_AGENT_ID=agent_...
ANTHROPIC_ENVIRONMENT_ID=env_...
GITHUB_TOKEN=github_pat_...
```

**The GitHub token must be a fine-grained PAT with `Contents: Read` and nothing
else.** The agent can edit files inside its container, but with no write scope
`git push` fails — nothing escapes back into your repos. The token also never
enters the container; Anthropic's git proxy injects it after the request leaves
the sandbox.

For deploys, the same keys go in as secrets:

```bash
npx wrangler secret put ANTHROPIC_API_KEY   # etc.
```

## Database migrations

Migrations live in `worker/migrations/`, applied with wrangler and tracked in a
`d1_migrations` table. Every statement is also written idempotently
(`IF NOT EXISTS`), so re-applying against an already-migrated database is safe.

```bash
npx wrangler d1 migrations create DB add_something   # scaffold the next one
npm run db:migrate                                   # local
# production: applied by `npm run install:cloudflare` / `npm run deploy`
npm run db:seed                 # local demo data — register an account first
```

## Reindexing

Cards are embedded as passages with `@cf/baai/bge-m3`. Anything written before
that — or before chunking — is unfindable by meaning until re-embedded. One page
per request, because each card is a Workers AI call and a few hundred in one
request meets the subrequest ceiling and a CPU timeout at once:

```bash
# signed in to the app, pumping `next` until `done`
curl -s -X POST <your-url>/api/reindex \
  -b cookies.txt -H 'content-type: application/json' \
  -d '{"limit":25}'                       # then {"limit":25,"after":"<next>"}
```

Scoped to the calling account — there is no all-users variant, because "re-run
inference over everyone's data" is not something a web request should start.
Safe to re-run: indexing is idempotent by chunk id.

`db:seed` is destructive (it wipes boards and nodes) and every board it writes
is owned by the earliest account in the database, so sign up before running it.
A board with no owner is not a legal row — `0014_boards_require_owner` enforces
it with a trigger, after an earlier design where unowned boards were adopted by
whoever registered next.

## How it fits together

```
board (Pages) ──create session──▶ Anthropic (agent loop + container)
                                        │  clones declared repos, works
     Worker ◀──webhook: idled───────────┘
       └─ events.list(sessionId) → results back onto the board
```

- **Mindmap = board.** Repos are declared on it and inherited by its cards.
- **Card = node.** Opening one drills into its own board (same `nodes` table,
  `board_id` = the card's id). A card stays one line of text until you open it.
- **Research = a Claude session, one per card, resumed forever.** Sessions are
  event-sourced server-side, so resuming is just another `user.message` — there
  is no transcript to persist or restore.
