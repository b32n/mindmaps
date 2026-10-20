# TODO

Open work, as of 2026-10. What has already shipped is in `git log`; design
rationale is in DESIGN.md and ARTEFACTS.md.

---

## 1. Before the first public release

- [ ] **Run the installer end to end** on a clean Cloudflare account
      (`npm run install:cloudflare`), and via the Deploy to Cloudflare button.
- [ ] **Publish the repo** at the URL the README and `package.json` point to.
- [ ] **Existing installs:** `npm run deploy` applies migrations before
      deploying. Migration `0023_workspaces` is the largest (it backfills every
      board and adds triggers), so back up with `wrangler d1 export` first.

---

## 2. Cleanup after upgrading an older install

- [ ] **Drop `nodes.doc`.** Dead weight since documents became markdown in
      `body`, but it is the only copy of the pre-markdown documents. Drop it
      once your markdown is confirmed good.
- [ ] **Delete the old Vectorize index.** `mindmaps-cards` (768-dim) was
      replaced by `mindmaps-chunks` (1024-dim):
      `npx wrangler vectorize delete mindmaps-cards`

---

## 3. Retrieval quality

The pipeline is argued, not measured. This is the honest gap, and it is
admitted on `/brain` under "What is missing".

- [ ] **Build the eval set.** 30 to 50 hand-labelled `(query -> card that should
      win)` pairs, plus a runner reporting recall@5 and MRR.
      - Source queries from `recall_queries` rather than inventing them.
        Invented queries unconsciously match how you already know the cards are
        worded.
      - Label the answer that *should* win, never the current output.
      - Include known-negatives: queries that should return nothing.
- [ ] **Then validate the reranker.** Cross-encoder reranking is a known win in
      the literature but has not been measured on this corpus. It fails open, so
      disabling it is a one-line revert.
- [ ] Only then: chunking changes, embedding model swaps, constant tuning.
      These need a full reindex, so they most need a number.

---

## 4. Files and folders

- [ ] **Drag-and-drop onto the canvas.** Dropping works on the file page, where
      a file is staged while its description is written. Dropping straight onto
      the board still has nowhere to ask for one; it wants the same staging
      step, not a `prompt()`.
- [ ] **Versions.** Keys are `files/<nodeId>/<uploadId>`, so replacing a file
      writes a new object, but nothing reads the old keys yet.
- [ ] **Folder snapshot stops at 60 files** (`MAX_CHUNKS` is 64). It says so in
      the body, but a folder that large wants to be several.
- [ ] **Reparenting.** Moving a loose `file` into a `folder` is a
      convert-and-delete, not a move.
- [ ] **MCP uploads cap at 1 MB.** Base64 through a tool call is context, not
      storage. Larger files go through the app.
- [ ] **Larger uploads.** The cap is 50 MB streaming into R2; beyond the Workers
      request-body limit it needs R2 multipart or a presigned PUT.
- [ ] **Images pasted inside a card's document** are orphaned in R2 when the card
      is deleted, because nothing parses the markdown for them.

---

## 5. Workspaces, sharing, trash

- [ ] **Trash is keyed by who deleted.** An editor deleting a card on a shared
      mindmap is the only person who can restore it; the owner cannot see it.
- [ ] **No workspace rename, delete, or leave button.** Leaving works over the
      API (the member DELETE route allows self-removal).
- [ ] **`boards.position` and `pinned` are shared columns**, so two people
      dragging the same mindmap fight over one value. Wants a
      `board_prefs(user_id, board_id, position, pinned)` table and a merge rule.
- [ ] **No artefact-grant UI.** The table, routes and `nodeRole` support it;
      nothing mounts `MembersPanel kind="artefacts"`.
- [ ] **`list_mindmaps` spans every workspace.** Right for an agent, possibly
      surprising to a user who thinks in workspaces.
- [ ] **Sub-boards inherit nothing.** `boards.parent_id` children take their
      `workspace_id` from their creator, not their parent. Decide before
      anything creates them.
- [ ] **`SlidesEditor readOnly` still shows "+ New slide"** in the filmstrip. It
      only changes the guest's local copy, but invites an edit that goes
      nowhere. Fix belongs in spindle-slides-react.

---

## 6. Smaller follow-ups

- [ ] **Label filtering in the rail.** Labels are stored and editable but do
      nothing yet. Also wants a `label` argument on `list_mindmaps`.
- [ ] **`LinkPicker` could use `/api/recall`.** It drills board then card rather
      than searching (see the comment in `web/src/LinkPicker.tsx`).
- [ ] **MCP prompts.** `prompts/list` returns `[]` (`worker/src/mcp.ts`).
      Shipping `/remember` and `/catch-up` would surface as slash commands.
- [ ] **Claude Code hooks.** The only deterministic way to make an agent recall
      at session start and write at session end.
- [ ] **Web-edit reindexing is cron-driven**, so a browser edit is findable by
      meaning within a minute rather than instantly. MCP writes are inline.
- [ ] **Table editing is raw markdown.** If that becomes annoying, add a small
      table helper to the raw editor rather than bringing back a block editor.
- [ ] **`/api/reindex` and `/api/remarkdown` are per-account by design.** For a
      many-user install this wants a queue or a cron sweep.

---

## Notes for contributors

- **Number SQL placeholders explicitly** when splicing the access predicates
  (`BOARD_READABLE`, `IN_WORKSPACE`) into a query. Mixing `?` with `?1` broke
  five queries at runtime with a clean typecheck.
- **Scope both arms of recall.** Vector namespaces only cover the semantic arm;
  `IN_WORKSPACE` must mirror `recallScope` so FTS and vector search agree.
- **Anything that serves user bytes** goes out via the mindbox with a signed URL
  or the sandbox CSP, never raw on the app origin where the session cookie lives.

## Not doing

- **Seeding TODO or roadmap boards on signup.** A board that needs hand-updating
  to stay true is one you stop opening. The single `Start here` board is
  deliberately the only seeded one.
- **Dropping Vectorize for pure D1 brute force.** Viable under ~5,000 cards per
  account, but the hybrid is built and handles growth. Revisit if that changes.
