# mindmaps — Design

A hosted, spatial surface for thinking: mindmaps of cards that carry real
documents, connected by labelled links.

**This is not a coding tool.** Code is written in the local IDE. This is where
the thinking about it lives — and, via [MCP.md](./MCP.md), where agent sessions
leave what they learned behind.

---

## 1. Problem

Running many mindmaps at once produces a matrix: mindmaps × (Linear
projects, repos, people, docs, open questions). Existing tools cover slices:

| Tool | Free-flowing / visual | Live tickets + PRs | Code context | AI research threads |
|---|---|---|---|---|
| Linear | no | yes, natively | no | no |
| Notion | yes-ish | partial sync | no | no |
| Obsidian | yes | no | weak | no |
| Miro / FigJam | yes | dead data | no | no |

Nothing joins a spatial thinking surface to live ticket state *and* durable
research threads with code context. That join is the product.

## 2. Ownership boundaries (decide once, enforce forever)

- **Linear owns**: status, assignee, cycle, estimate, priority. Rendered here,
  never written. One-way in.
- **GitHub owns**: code and history. **Read-only.** Clone-scoped token, no push.
- **This board owns**: thinking. Sketches, options, the "why", the map of how
  work relates, and research threads.
- **Writes out**: none in v1. Creating a Linear ticket from a selection is a
  post-v1 candidate, and would be the only write.

**Corollary that keeps the tool alive:** nothing on a board may require manual
updating. Ticket cards, PR cards, and session cards refresh themselves. The day
you have to go touch the board to keep it accurate is the day you stop opening it.

## 3. Structure

One nested-canvas structure, two renderers — not a hierarchy *and* a canvas
fighting each other.

- A **mindmap is a board**.
- On it: cards, notes, images, links between cards.
- Opening a card zooms into **its own board**.
- A "list view" is a projection of the same nodes, sorted, with checkboxes.

A card stays one line of text until you open it; the board materialises lazily,
so most cards cost nothing. A card can be linked into a second board, which is
the escape hatch for a mindmap that spans two projects.

## 4. Research: remote Claude sessions

> **SUPERSEDED — see [MCP.md](./MCP.md).** This section describes hosting agents
> ourselves via Anthropic's Managed Agents. It is billed to the org's API
> account and cannot draw on a user's Claude subscription, which became a hard
> requirement. The direction now is to expose an MCP server and let the user's
> own harness be the agent. Kept here because the constraints it documents
> (read-only repo access, session persistence, the credential model) still
> explain how we got to MCP.


Uses Anthropic **Managed Agents** (beta `managed-agents-2026-04-01`). Anthropic
runs the agent loop *and* hosts the per-session container. No compute on our
infrastructure and none on the laptop.

### Object mapping

| Board concept | API object |
|---|---|
| Agent persona (researcher, code-tracer) | Agent — created once, versioned |
| A card's research thread | Session (`sesn_...`) — one per card, resumed forever |
| "Ship to Claude" | `events.send({type: "user.message"})` |
| Results back on the board | `agent.message` events + `/mnt/session/outputs/` files |
| A user's connected accounts | Vault (`vlt_...`) |

### Multi-repo is native

A session takes multiple `github_repository` resources. Repos are cached, so
repeat sessions against the same repo start faster.

```js
resources: [
  { type: "github_repository", url: "https://github.com/org/a",
    mount_path: "/workspace/a", authorization_token: token,
    checkout: { type: "branch", name: "main" } },
  { type: "github_repository", url: "https://github.com/org/b",
    mount_path: "/workspace/b", authorization_token: token },
]
```

Repos are declared **per mindmap** and inherited by its cards. Cards under a
mindmap with no repos skip the mount and start instantly — most cards
(Linear/doc/web research) need no code at all.

### Read-only guarantee

- Token scope is `Contents: Read`. The agent may edit files in its container;
  `git push` fails. Nothing escapes back into our repos.
- The token **never enters the container** — Anthropic's git proxy injects it
  after the request leaves the sandbox. Container code cannot read or exfiltrate
  it, including code the model itself writes.
- Toolset narrowed: `edit` disabled. `write` stays (needed to produce
  deliverables in `/mnt/session/outputs/`).

```js
tools: [{
  type: "agent_toolset_20260401",
  default_config: { enabled: true },
  configs: [{ name: "edit", enabled: false }],
}]
```

### Session persistence and resume

Sessions are stateful, persistent, and event-sourced. Every message, tool call,
and result is a durable event. **Resume = send another `user.message` to the same
session ID.** No transcript files to persist or restore. Sessions also compact
context and cache prompts automatically, so a long-lived card thread neither
degrades nor becomes expensive.

The container is tied to the session, so a resumed card keeps its checkout. Clone
cost is once per card, not once per question.

### Getting results back

The agent writes to `/mnt/session/outputs/`. Retrieve with:

```js
client.beta.files.list({ scope_id: session.id,
                         betas: ["managed-agents-2026-04-01"] })
```

Both beta headers are required on that call (SDK adds the Files one; we add the
Managed Agents one). There is a 1–3s indexing lag after the session idles —
retry once.

### Credentials — Vaults

A vault is a credential store Anthropic manages, with `metadata` for our own
user ID. Attach at session create with `vault_ids`. Anthropic **auto-refreshes
OAuth tokens** via the stored refresh token, and secrets are substituted at
egress — never visible in the sandbox.

**Trap:** hosted MCP servers (Linear, Notion) want **OAuth bearer tokens, not
native API keys**. A Linear `lin_api_...` key will not authenticate their MCP
server. Budget for a real OAuth flow per connector.

### Rejected alternative

GitHub MCP server read-only (API search/read, no clone) — lighter, no clone
latency, source never written to a sandbox filesystem. But cross-file tracing is
much weaker and git history (`git log`, `git blame`) is off the table. Keep as
the fallback for any repo that fails a compliance review, so those repos get
*something* rather than nothing.

## 5. Stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite on **Cloudflare Pages** |
| Canvas | **`@xyflow/react`** (React Flow) — MIT, nodes are arbitrary React components |
| Ink | **`perfect-freehand`** (MIT) — SVG layer sharing React Flow's viewport transform |
| Backend | **Cloudflare Workers** |
| Database | **D1** |
| Blobs (images, outputs) | R2 |
| Realtime (later) | Durable Objects |
| Agent runtime | Anthropic Managed Agents — no compute of ours |

### Canvas library decision — DECIDED, one-way door

**Hard constraint: no licence fees, MIT/free only.**

**`@xyflow/react` (MIT, v12.11.6) as the single canvas, plus an ink layer built
on `perfect-freehand` (MIT) that shares React Flow's viewport transform.**

One viewport. No nested canvases. Responsibilities:

| Need | Provided by |
|---|---|
| Infinite pan/zoom, selection, multi-drag, undo | React Flow |
| Live cards (Linear / PR / session) | React Flow custom nodes — React components |
| Shapes, text, images, sticky notes | React Flow node types |
| Arrows, dependencies | React Flow edges |
| **Freehand ink** | **Our SVG layer + `perfect-freehand`** |

Rejected: **tldraw**. Best technical fit — real whiteboard *and* React-component
custom shapes — but SDK 4.0 put production use behind a licence (watermark on the
free hobby tier, ~$6k/yr commercial). Ruled out on the no-licence constraint.

Rejected: **Excalidraw alone**. Best sketching, but it is a canvas renderer, not
a DOM composition layer. Live interactive cards — the actual product — would mean
fighting the library indefinitely.

Rejected: **Excalidraw embedded as a `sketch` node**. Considered as a hybrid, but
it boxes drawing inside rectangles, which is not the Miro-feel the product needs
when drawing is a primary mode. It also nests two viewport systems, which fight
over wheel/pointer events.

### The one thing we build ourselves

Ink, and only ink. React Flow already covers shapes, text, images, arrows,
selection, and undo, so the gap is narrower than a general whiteboard:

- pen with pressure (`perfect-freehand` → SVG path)
- eraser with stroke hit-testing
- colour / width
- stroke persistence and undo integration

Estimate: a few solid days. This is the single largest piece of bespoke UI in the
project and the main execution risk — validate it early.

### Webhooks, not SSE

Workers cannot hold a long-lived SSE stream with heartbeats. Register an HTTPS
endpoint and subscribe to `session.status_idled` / `session.status_terminated`.

```
board (Pages) ──create session──▶ Anthropic (agent loop + container)
                                        │  clones N repos, works
     Worker ◀──webhook: idled───────────┘
       └─ events.list(sessionId) → new nodes on the board
```

Three rules:
1. Pass the **raw** body to `client.beta.webhooks.unwrap()` — Cloudflare's
   `.json()` re-serialises and breaks the HMAC.
2. **Dedupe on event ID** — retries reuse it.
3. After three failed attempts an event is **dropped with no signal**. Treat
   webhooks as a fast path; reconcile with `sessions.list` on a schedule.

## 6. Data model (D1)

```
mindmaps   id, name, status, parent_id, linear_project_ids,
              repos (json), created_at, updated_at
nodes         id, board_id, type, title, body, x, y, w, h, data (json)
              type ∈ note | card | image | ticket | pr | session
edges         id, board_id, source_id, target_id, label
sessions      id, node_id, anthropic_session_id, status, created_at
events        id, session_id, anthropic_event_id (unique), type, payload, at
```

`nodes.data` holds type-specific fields (Linear issue id, PR number, session id).
A card's own board is `nodes WHERE board_id = <card id>` — same table, no second
structure.

## 7. Failure mode to design against

This becomes a second place to maintain, and dies. Mitigations, in order of
importance:

1. It must be **cheaper than a doc** to put something on.
2. It must **pull, not require push** — cards self-refresh.
3. The research threads must be good enough to open the board for on their own.

## 8. Compliance note

Repo mounting is per-session and opt-in — nothing is cloned that a mindmap
does not explicitly declare. `bank-cde-carddata` and `cde-configuration` (PCI
cardholder data environment) stay off the mount list until signed off. Read-only
scope makes this a much weaker question than write access would, but it is still
a PCI scoping conversation, not a technical one. Config decision, not
architectural.

## 9. v1 scope

**In:** boards + nested cards, node/edge persistence, one card dispatching a real
multi-repo research session, results back as nodes, webhook receiver.

**Out:** freehand drawing, realtime multiplayer, Linear write-back, PR creation,
GitHub MCP, per-user auth (single-tenant first).

## 10. Superseded direction

The research path in §4 is no longer what we're building. See
[MCP.md](./MCP.md) for the current direction and the four approaches that were
explored and rejected on the way to it.

## 11. Open questions

- One general research agent, or several personas (researcher / code-tracer /
  reviewer) selectable per card?
- Which two repos to test cross-repo tracing against — ideally a pair where the
  answer is already known, so output quality can be judged.
- OAuth flow per connector: build Linear first, or start with GitHub-only?


## Board view state

Two layers, stored in different places on purpose:

| | where | why |
|---|---|---|
| last position | `localStorage`, per browser | a viewport is tied to a screen size; syncing it would let one monitor decide what another sees |
| home view | `boards.home_view`, server | a deliberate statement about how a board should open, worth carrying to a new device |

Precedence: local state if this browser has any, else the home view, else
fit-to-content.

Both restore paths are guarded, because a saved view goes stale — the card it
had open gets deleted, or the region it framed empties out as things move.
`viewShowsContent` checks the saved rectangle still intersects some node and
falls back to fit if not. Stranding someone on blank canvas with no explanation
is worse than being less specific.

**Timing trap worth remembering:** restoring has to wait for
`useNodesInitialized`. Before it fires React Flow has measured nothing, so a
restore and React Flow's own `fitView` both run against an empty canvas and the
fit lands last — the viewport silently reverts. The `fitView` prop is therefore
off entirely; `Board.tsx` fits or restores itself once the nodes are ready.


## Linking across mindmaps, from the canvas

Drag out of a handle and release on empty canvas. That gesture is already how
you make a link; the only difference is where you let go, so it teaches itself
the first time you drop in the wrong place — and it adds no permanent chrome to
a card that already carries a delete button, an Open button, chips and four
handles.

The picker offers two answers to "connect this to what?":

- **Select from a mindmap** — drill board, then card. Browsing beats searching
  at this scale: you rarely recall an exact title, and seeing what is on another
  board is half the point when you are looking for a connection between topics.
  Each list has a type-to-filter box for when a board is large.
- **Create a card here** — a new card at the drop point, already linked. Worth
  having on its own merits, independent of cross-mindmap work.

A direction toggle sits above both, because direction changes what the sentence
means rather than just which way an arrow points — `blocks` is not symmetric.
It is chosen before the target for the same reason.

Cards already linked to the source are shown but disabled. Refusing after the
click is worse than showing the state before it.

**Known rough edge:** "create a card here" places the card at the drop point,
which can land under a stub created earlier from the same handle. Both are
draggable, and the collision only happens if you drop in nearly the same spot
twice, so it is left alone rather than fixed with an offset that would make
placement less predictable.


## Mindmaps have addresses

`/app/:boardId`, with the open card as `?card=:nodeId`. The split that makes
this coherent:

- **The URL owns *what* you are looking at** — the mindmap, and the card. Both
  are shareable facts about the thing itself.
- **localStorage owns *how*** — pan and zoom. A viewport measured on one screen
  means nothing on another, so it stays on the device that measured it.
- **`home_view` stays the declared default** — applied when the URL names no
  card, and still the right home for a link someone else opens.

The URL wins on arrival: someone who followed a link asked for something
specific, and it outranks whatever was open here last time. The viewport still
comes from the saved view, because the card is named and the position is not.

Writes to `?card=` are `replace`, not `push`. Opening a card is reading, not
travelling — a history entry per card would turn Back into an undo button for
scrolling. Switching mindmap does push, so Back retraces the mindmaps you
actually moved between.

`/app` with no id still resolves, landing on the first mindmap. The sign-in
redirect goes through it, and so do older links.

A board only mounts once its id is known to be one of yours. A URL is user
input now — anyone can type one — and handing an unknown id to the board meant
a fetch that 404s and an uncaught error on the way to the redirect that was
going to fix it anyway.
