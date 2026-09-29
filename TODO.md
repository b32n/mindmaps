# TODO

Working state as of 2026-09-16. Production is several features behind local.

---

## 0. Artefacts (v0) — built, not deployed

The `sheet` node type works end to end: an agent creates one through MCP or a
person clicks the sheet button in the dock, the payload lands in R2, the
pointer and the text snapshot land in D1, the board renders a summary without
touching R2, and `/sheet/:id` opens the real Spindle editor behind a lazy
boundary (413 kB, its own chunk, never loaded by a board with no sheets).
Verified by driving the running app: typing a cell goes Unsaved -> Saved,
reaches R2, and rebuilds the D1 snapshot with the new value in the right row.

**One fix here must ship.** `sheetSnapshot` parsed cell keys as `"row:col"`
indices. That is only true of a workbook that has never been opened: once it
round-trips through the editor, Spindle rekeys cells by stable row and column
ids and carries the positions in `rowOrder`/`colOrder`. The old parser dropped
every cell, so the first edit to any sheet would have silently emptied its
snapshot and made it invisible to `recall`. Now reads both shapes.

**Delete is deferred, not destructive.** `0020_r2_trash` adds a trash table.
Deleting a node files its R2 object rather than removing it; undo takes it back
out; the cron reaps whatever is past the 7 day window and still referenced by
nothing. This fixed a worse bug than it looks: delete used to destroy the
payload, and the undo that followed found an empty pointer and wrote a *blank
workbook* over it, so the sheet came back on the board looking fine and empty.
Restoring past the window now returns 410 and says so on the board instead of
silently handing back an empty grid.

Image nodes go through the same door, which also closes the opposite leak: they
previously never deleted their R2 object at all. Note the remaining gap —
images pasted *inside* a card's document are still orphaned when the card is
deleted, because nothing parses the markdown for them on the way out.

**There is a trash now.** `0021_trash` archives the row itself, so deleting is
recoverable rather than merely survivable. A node delete stores the node and
the edges that died with it; a mindmap delete stores the whole subtree as one
entry, which closes what was the most destructive action in the app: it used to
take every sheet on the mindmap with it, leak every R2 object, and offer no way
back. Rail entry below the mindmap list. Restore, delete-for-good, empty.

An archive table rather than `deleted_at` on `nodes`: 41 queries read that
table and the failure mode of a missed filter is a deleted card surfacing in
`recall`. Moving the row out means no existing query changes.

Two things fall out of the window being real: the mindmap delete warning no
longer claims the delete cannot be undone, and `useHistory` now reports failed
undos instead of swallowing them.

**`doc` and `deck` are in**, which closes v0 of ARTEFACTS.md §6. Both work the
same way as sheets: minimal authoring format in, R2 payload plus a text snapshot
out, own lazy route, own dock button (D and K). Agents reach them through the
same `create_artefact` with `type`, and `get_artefact_schema` now takes a kind.
Speaker notes are indexed, so the argument written under a slide stays findable.

Bundle: each engine is its own chunk (sheet 301 kB, doc 271 kB, deck 163 kB) and
the main bundle grew 6 kB in total. A board with no artefacts downloads none of
them.

**HTML artefacts run in the mindbox**, which needs two things at deploy time
that nothing else in this repo has needed:

```bash
# 1. DNS. mindbox.b32n.io must resolve to the Worker, as a custom domain in the
#    Cloudflare dashboard, the same way mindmaps.b32n.io does.

# 2. The signing key. Without it the type is unavailable rather than insecure:
#    minting a frame URL 503s and /s/* refuses to serve.
cd worker && npx wrangler secret put MINDBOX_SECRET
```

Why a second hostname. The app origin holds a `HttpOnly; SameSite=Lax` session
cookie, and `HttpOnly` does nothing against same-origin
`fetch("/api/boards", {credentials:"include"})` — the browser attaches the
cookie itself. An author-written page on `mindmaps.b32n.io` could read every
card its owner has. These pages are usually written by agents, so a prompt
injection in anything an agent read is a way to author one. Isolation comes
from the hostname, the `sandbox="allow-scripts"` iframe with no
`allow-same-origin`, and `connect-src 'none'`.

Verified in the browser, not asserted: the frame's `window.origin` is `null`
(opaque) and `fetch` to the API fails. Signed URLs refuse a missing, tampered,
expired or replayed-onto-another-id signature.

`/s/*` had to be added to `run_worker_first`, or the SPA fallback answers with
index.html and an artefact renders as a copy of the app inside its own frame.

**Local development has none of this isolation.** `.dev.vars` points
MINDBOX_ORIGIN at localhost, because there is only one origin locally. Do not
point a local build at production data and open a page you did not write.

**Sharing is in** (`0022_shares`). A share is a row, not a signature: the
mindbox's owner-preview URLs are HMAC(nodeId.exp) and cannot be revoked without
rotating the secret and breaking every link at once. Link shares are
unguessable 160-bit tokens, revocable, optionally expiring, with a view count.

`GET /api/shared/:token` is the only path in the codebase that reads a user's
content without a session, so it is deliberately narrow: one artefact, its
title and its payload, nothing around it. Every refusal returns the same shape,
because distinguishing "no such token" from "revoked" from "expired" tells
someone probing which guesses were close.

Viewer at `/v/:token`, outside RequireAuth, with a lazy chunk per kind. Pages
render in the mindbox exactly as they do for their owner.

Verified with a real signed-out browser context (zero cookies): all four kinds
render, revocation takes effect on the next load, an expired share never
resolves, and a share token cannot be pointed at a different artefact.

Also verified that read-only holds where it matters: a guest typing into a
shared sheet changes nothing, and writes 401 without a session.

**Known, filed under cosmetic:** `SlidesEditor readOnly` still shows a working
"+ New slide" in the filmstrip. It only mutates the guest's local copy — there
is no save path in the viewer and the server rejects the write — but it invites
an edit that silently goes nowhere. Worth a fix in spindle-slides-react.

**Permissions, phase 1 and 2** (`0023_workspaces`). Access now arrives by four
routes, widest first: workspace membership, board share, artefact grant, link
share. Roles are owner > editor > viewer, and owner is never a membership row —
it lives in `workspaces.owner_id` so it cannot be revoked by editing a table
that grants lesser roles.

The personal workspace reuses the user's id. Vectors were already namespaced by
user id, so introducing workspaces needed **no re-index** — the difference
between a schema change and a migration over the whole corpus.

`access.ts` holds every rule: two SQL predicates and three role lookups.
Converting `ownsBoard`/`ownsNode` into role checks turned every call site into a
compile error, which is how all fourteen got classified by intent rather than
by grep.

Refusals now tell the truth: 404 when you cannot see it, 403 with the reason
when you can see it but may not do it. Answering "not found" to a viewer's edit
was a lie they could disprove by looking at the screen.

**MCP is converted too.** `ownedBoard`/`ownedNode` became
`writableBoard`/`readableBoard`/`writableNode`/`readableNode`, and all fifteen
call sites were classified by what the tool actually does. Agents now see and
write exactly what their user may, and a viewer's agent is told *"You have
view-only access to that mindmap"* rather than that it does not exist.

Vector namespaces moved from user to workspace. `indexCard` takes `namespace`
now, read from the card's own board rather than from the caller: a card shared
into your view still belongs to its owner's workspace, and filing it under
yours would leave a copy that revoking your access could not reach.

**The `?1` splice needs care.** Five queries broke on parameter numbering when
the predicate was spliced in, and every one failed at runtime with a clean
typecheck — FTS read the search string as a user id, the reorder UPDATE compared
`owner_id` to a row index, and the graph walk replaced a `?3`. Fixed by giving
`BOARD_READABLE` an explicit slot argument and numbering every placeholder in
the host query. Any further conversion should number placeholders explicitly
rather than mixing `?` with `?1`.

**Invitations and the members UI are in.** Inviting someone who already has an
account adds them immediately; inviting someone who does not leaves a row in
`invites` that is claimed when they sign in with that address. Claimed on
*every* sign-in, not just sign-up — someone invited after they already have an
account but before they next log in would otherwise be stranded forever.

Sharing lives in the mindmap settings dialog rather than behind its own button:
that dialog is already "everything about this mindmap", and who can see it
belongs in that list.

Owners only for workspaces and mindmaps. An editor who could invite could
invite a second account of their own and keep access after being removed.
Artefacts are the exception — anyone who can edit one can pass it on, because a
grant on a single artefact cannot widen into anything else.

**A bug worth remembering:** the starter board insert had no `workspace_id`, so
the trigger rejected it and every new account silently lost its starter board
while registration still returned 200. Caught because a new invited user could
see the team mindmap and nothing of their own. Ordering matters too — the
personal workspace has to exist before the starter board references it, and
`signIn` only created one afterwards.

**Recall is workspace-scoped, and the switcher is in.** One vector query for
the workspace you are in, one more per owner who board-shared across a
boundary, and granted artefacts scored by exact cosine over `node_chunks`
rather than by querying a namespace you cannot reach.

**Half-scoping was the trap.** Namespaces only cover the vector arm. Scoping
those and leaving FTS alone meant the same question returned personal cards
through keyword matching and hid them from the semantic pass — results
appearing and disappearing depending on which arm found them, which is worse
than either extreme. `IN_WORKSPACE` mirrors `recallScope` exactly so both arms
agree. Verified: the same query returns 1 in the team, 1 in personal, 2 across
everything.

Agents get the widened scope, because an agent has no notion of being anywhere.
A null workspace means every workspace the user belongs to — a fan-out bounded
by memberships rather than collaborators.

The switcher only appears with more than one workspace; a picker with a single
option is furniture. Current workspace lives in localStorage rather than the
URL: it is a lens, and a mindmap's address should not change because of which
workspace happened to be selected when the link was copied. Mindmaps shared
directly from elsewhere stay visible in every workspace, since they belong to
none you are a member of.

**Audit after the fact found two gaps, both fixed.** `createShare` still asked
`b.user_id`, so an editor could change an artefact but not publish a link to it
— and the refusal arrived as a 404, reading as "that artefact does not exist".
Link shares on an artefact are now a property of the artefact rather than of
whoever made them, so a second editor can see and revoke one they did not
create. And `MembersPanel` was only mounted for mindmaps, so a team workspace
could be created but never invited to without curl.

## 0b. Files and folders (0024) — built, not deployed

Two node types for bytes we did not author. `file` holds one, `folder` holds
many, both backed by one `files` table and one R2 prefix. Neither goes through
`putArtefact`: the body streams from the request into R2 and is never whole in
the isolate, which is what makes the 50 MB cap a constant to edit rather than an
architecture to replace. The real ceiling is the Workers request-body limit;
past that uploads want R2 multipart or a presigned PUT, and that is a change of
transport that touches neither the rows nor the permissions.

**The description is required, and that is the whole design.** Every other kind
earns its way into `recall` by deriving text from its payload. A zip derives
nothing. So a text-ish file under 256 kB is buffered and its head indexed, and
anything else is refused without a one-line description. Optional would mean
agents skip it, which ARTEFACTS.md §7 already names as the failure mode.

**Downloads leave by the mindbox.** Signed, expiring, `attachment` except for
raster images and PDFs, and never on the app origin — some uploads are documents
that run script, and the app origin is where the session cookie lives.

**Which turned up a live hole on the image path.** `/api/images` accepts
`image/svg+xml` and served it back from `mindmaps.b32n.io` with no CSP, no
`nosniff` and no ownership check. Upload one to your own account, send the link
to someone signed in, and it ran on the origin holding their cookie, free to
`fetch("/api/boards")`. Fixed in place rather than moved, because card documents
already link those URLs: the response now carries `default-src 'none'; sandbox`
and `nosniff`, which an `<img>` ignores and a navigated document does not.

**Undo needed the same care that 0020 needed.** File rows cascade with their
node, so both restore paths capture them: `archiveNode` and `archiveBoard` put
them in the trash payload, and client-side undo — which re-POSTs the node rather
than going through the trash — recovers them with `restoreFileRows`. That call
has to run *after* the node INSERT or the foreign key rejects it, which is how it
was first written and how it failed.

Verified against the running worker, not asserted: text upload extracts a
snippet into the body; a binary without a description is refused and with one
succeeds; both restore paths bring back rows, summary and bytes; a signature
repointed at another file is refused; 51 MB is refused without leaving a partial
row; a second user gets 404 on list, upload and delete, and an unsigned download
gets 403. `recall` finds the folder both by the PDF's description and by the
CSV's contents.

### Still pending on files

- **No drag-and-drop onto the canvas.** Dropping a file is the natural gesture
  and it is deliberately not wired: a binary needs a description, and the drop
  has nowhere to ask for one. Wants a small dialog rather than a `prompt()`.
- **No versions.** The key is `files/<nodeId>/<uploadId>` so that replacing a
  file writes a new object rather than overwriting one, but nothing reads the
  old keys yet.
- **A folder's snapshot stops at 60 files.** `MAX_CHUNKS` is 64, so past that
  the tail is not indexed. It says so in the body rather than going quiet, but a
  folder that large wants to be several.
- **No reparenting.** Moving a loose `file` into a `folder` is a convert-and-
  delete, not a move, because a file inside a folder has no node id.
- **MCP uploads cap at 1 MB.** Base64 through a tool call is context, not
  storage. Bigger files want the app, and the refusal says so.

### Still pending

- **Nothing is deployed.** `0023` is local only and is the largest migration so
  far: it backfills every board and adds triggers. Migration, then build, then
  deploy.
- **Trash is keyed by who deleted.** An editor deleting a card on a shared
  mindmap is the only person who can restore it; the owner cannot see it. Wants
  a second predicate on the trash list.
- **No workspace rename, delete, or leave.** The member DELETE route allows
  self-removal, so leaving works over the API but has no button.
- **`boards.position` and `pinned` are shared columns.** Two people dragging the
  same mindmap fight over one value. Wants `board_prefs`.
- **No artefact-grant UI.** The table, routes and `nodeRole` all support it;
  nothing mounts `MembersPanel kind="artefacts"`.
- **`list_mindmaps` spans every workspace.** Right for an agent with no notion
  of where it is, possibly surprising to a user who thinks in workspaces.
- **Sub-boards inherit nothing.** `boards.parent_id` children get a
  `workspace_id` from their creator, not from their parent. Fine today because
  nothing creates them, worth deciding before something does.

**Surfaced, not fixed:** `boards.position` and `boards.pinned` are columns on
the board, which was right when a board had one reader. Shared, they are a
shared preference — two people dragging the same mindmap fight over one column.
The fix is a `board_prefs(user_id, board_id, position, pinned)` table, which is
a migration and a merge rule rather than a filter change.

---

## 1. Blocking: ship what is built

Production runs an older build. Everything below is built, typechecked and
tested locally but not deployed. **The order matters.**

```bash
# 1. migrations first. Remote is at 21 of 23.
cd worker && npm run db:migrate:remote

# 2. then the code
cd ../web && npm run build
cd ../worker && npm run deploy

# 3. then the data repair, signed in at mindmaps.b32n.io (DevTools console)
#    pump until done:
let after = null, total = 0;
for (;;) {
  const r = await fetch("/api/remarkdown", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit: 100, ...(after ? { after } : {}) }),
  }).then((r) => r.json());
  total += r.rewritten;
  console.log(total, "rewritten", r.done ? "DONE" : "");
  if (r.done || !r.next) break;
  after = r.next;
}
```

**Why migrations before deploy.** `0019_board_metadata` adds `description`,
`labels` and `pinned`. The new code writes all three. Deploy first and board
creation and the settings dialog both 500.

**Why remarkdown after deploy.** `body` is the document now, not a search
projection. Production still holds 14 cards with `·` separators and 4 clipped
at exactly 500 characters, written by the old editor. Until this runs those
cards render truncated to a reader, which is worse than today where they only
search badly.

Expect a burst of Workers AI calls afterwards: every rewritten card is marked
dirty and the cron re-embeds it. Cents, but not silent.

**Verify after.**

```bash
npx wrangler tail                    # expect: "reindexed N edited cards"
```

Then open two or three of the cards that had `·` bodies. The conversion is
verified stable in tests, but those are the rows where `doc` and `body`
disagreed most, so they are where a surprise would show up.

---

## 2. Blocking: commit

`git log` says *"branch 'main' does not have any commits yet"*, with 73 changed
paths. The whole app, every migration, the landing pages.

```bash
git add -A && git commit -m "mindmaps: board, MCP brain, landing, markdown documents"
```

This deploy replaces the document editor and rewrites every card's `body`. With
no commits there is nothing to diff against and nothing to roll back to.

---

## 3. After the deploy settles

- [ ] **Drop `nodes.doc`.** Dead weight now, but it is the only copy of the
      pre-markdown documents. Keep until production markdown is confirmed good,
      then a one-line migration.
- [ ] **Delete the old Vectorize index.** `mindmaps-cards` (768-dim) was
      replaced by `mindmaps-chunks` (1024-dim).
      `npx wrangler vectorize delete mindmaps-cards`
- [ ] **Consider deleting the 60 test accounts.** 60 of 61 production users
      match `example.com` / `test` / `probe`, zero Google sign-ins. Cascades
      boards, nodes, chunks and tokens, so it is a deliberate call.

---

## 4. Retrieval quality

The pipeline is argued, not measured. This is the honest gap, and it is
admitted on `/brain` under "What is missing".

- [ ] **Build the eval set.** 30 to 50 hand-labelled `(query -> card that should
      win)` pairs, plus a runner reporting recall@5 and MRR.
      - Source queries from `recall_queries` (7 logged so far) rather than
        inventing them. Invented queries unconsciously match how you already
        know the cards are worded.
      - Label the answer that *should* win, never the current output. Generating
        from today's results freezes today's bugs as the target.
      - Include known-negatives: queries that should return nothing.
- [ ] **Then validate the reranker.** Cross-encoder reranking is a known win in
      the literature but has never been measured on this corpus. On the one
      probe I ran it ranked a literal keyword match above the card that actually
      answered the question, both at near-zero confidence. n=1, could be noise.
      It fails open, so disabling it is a one-line revert if it turns out to
      hurt.
- [ ] Only then: chunking changes, embedding model swaps, constant tuning.
      These change what gets indexed and need a full reindex, so they are the
      ones that most need a number.

---

## 5. Known gaps and smaller follow-ups

- [ ] **Label filtering in the rail.** Labels are stored and editable but do
      nothing yet. Filtering four boards is not a feature; this earns its place
      around twenty. Also wants a `label` argument on `list_mindmaps`.
- [ ] **`LinkPicker` could use `/api/recall`.** It drills board then card, and
      its own comment at `web/src/LinkPicker.tsx:17` says it does that "rather
      than searching". The endpoint now exists.
- [ ] **MCP prompts.** `prompts/list` returns `[]` (`worker/src/mcp.ts`).
      Shipping `/remember` and `/catch-up` would surface as slash commands in
      most harnesses.
- [ ] **Claude Code hooks.** The only deterministic way to make an agent recall
      at session start and write at session end. `SessionStart` calls `recall`,
      `Stop` writes a summary card. Everything else is encouragement.
- [ ] **Web-edit reindexing is cron-driven**, so a browser edit is findable by
      meaning within a minute rather than instantly. MCP writes are inline.
      Documented in MCP.md, acceptable, worth knowing.
- [ ] **Table editing is now raw markdown.** Production has 3 tables. They
      render fine and are awkward to hand-edit. If that becomes annoying, a
      small table helper in the raw editor is the fix, not bringing back a
      block editor.
- [ ] **`/api/reindex` and `/api/remarkdown` are per-account by design.** No
      all-users variant, because re-running inference over everyone's data is
      not something a web request should start. If real multi-user ever
      happens, that wants a queue or a cron sweep.

---

## Not doing

- **Seeding TODO or roadmap boards on signup.** Linear owns status and
  assignee, and a board that needs hand-updating to stay true is one you stop
  opening. The single `Start here` board is deliberately the only seeded one.
- **Dropping Vectorize for pure D1 brute force.** Viable today (biggest account
  is 26 cards, crossover is around 5,000) but the hybrid is already built and
  handles growth without thought. Revisit if a single account passes ~5,000
  cards.
