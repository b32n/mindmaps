# TODO

Working state as of 2026-09-16. Production is several features behind local.

---

## 1. Blocking: ship what is built

Production runs an older build. Everything below is built, typechecked and
tested locally but not deployed. **The order matters.**

```bash
# 1. migration first. Remote is at 18 of 19.
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

**Why migration before deploy.** `0019_board_metadata` adds `description`,
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
