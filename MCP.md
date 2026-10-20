# MCP Server — design notes

**Built.** `worker/src/mcp.ts` (protocol + tools), `worker/src/oauth.ts` (auth),
`worker/src/markdown.ts` (prose conversion), `worker/src/layout.ts` (placement).
See the README for how to connect a harness.

This document is the reasoning behind the decisions, kept so we don't re-derive
them. Everything is revisable, but the *reasons* are the valuable part — read
those before changing a conclusion. §7 records which open questions were
resolved and which are still open.

---

## 1. What it is

The board exposes an MCP server. Agent harnesses — Claude Code, Cursor, anything
that speaks MCP — install it and use the board as **durable memory between
sessions**.

Two directions, both load-bearing:

```
agent session ──[capture]──▶  board     a long conversation becomes a mind map:
                                        nodes, edges, documents you can look at

board ──[recall]──▶ agent session       a mindmap becomes structured context
                                        for a new session
```

The product framing that follows: the board is not "a tool with an AI feature".
It is the thing that survives when a session ends. Agent sessions are amnesiac;
this is where what you learned persists, in a form a human can also read and
rearrange spatially.

## 2. Why this shape, and what it dissolves

We arrived here after exploring four other designs. Each died on a specific
constraint, and it's worth recording them so they don't get re-proposed:

| Approach | Why it died |
|---|---|
| **Managed Agents** (Anthropic-hosted sandbox) | Billed to the org's API account. Cannot draw on a user's Claude subscription — those are separate products. |
| **Claude Agent SDK with subscription auth** | Officially supports third-party apps using a user's subscription (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`). But the Agent SDK is a harness *you host* — needs Node with filesystem and subprocess. We don't want to host agents. |
| **Local companion on the user's machine** | Satisfies subscription billing and needs no hosting, but research only runs while their laptop is awake. Rejected. |
| **Brokers** (OpenRouter, proxies) | Brokers bill their own credits. Community proxies that bridge OAuth tokens into an OpenAI-compatible API were blocked by Anthropic for third-party harnesses (4 Apr 2026). Building on them means building on a workaround. |

Being an MCP server instead removes every one of those problems at once:

- **No agent hosting.** The harness is the agent.
- **No LLM billing.** We never call a model. The user's harness runs on their
  own subscription; our cost is zero.
- **No Anthropic auth.** We authenticate the *user to our board*, nothing more.
- **No repo mounting, no GitHub PAT, no PCI question.** The harness already has
  the code context. Source never touches our infrastructure.
- **Multi-user is ordinary app auth.** No credential brokering.

This is the third significant pivot in the project, but unlike the previous two
it *removes* complexity rather than relocating it, and it's the first design
where nothing is fighting a platform constraint.

## 3. Tool surface

Deliberately small. Every tool schema is context tax on every session — the
whole server should stay in the low thousands of tokens.

### Read

| Tool | Returns |
|---|---|
| `list_mindmaps` | names, status, card counts |
| `get_mindmap(id)` | the mindmap as structured context: cards with documents, checklist state, notes, and labelled edges between them |
| `get_card(id)` | one card's full document |
| `search(query, mindmap?)` | matches across titles, documents and notes; ids plus snippets |

### Write

| Tool | Does |
|---|---|
| `create_mindmap(name, nodes[], edges[])` | the headline one: agent hands over a graph, we lay it out |
| `add_to_mindmap(id, nodes[], edges[])` | extend an existing map |
| `add_card` / `update_card` / `append_to_card` | `append_to_card` is the workhorse — "add these findings to the tokenization card" |

`get_mindmap` deserves more care than it sounds: it's a payload going into
someone's context window. Markdown, clearly structured, **ids attached** so the
agent can write back to specific cards, and a depth/size cap so a large
mindmap doesn't blow the budget.

## 4. Prose: markdown vs blocks

This was the longest discussion. The conclusion has a shape worth preserving:
**structure is JSON, prose is markdown.**

### The agent authors graph structure as JSON

Which nodes exist, their type, which edges connect them, what the edge labels
say. That's semantic, only the agent knows it, and no converter could infer it
from prose. Models are good at schema-conformant JSON under a strict tool
schema. No argument here — this is what `create_mindmap` is.

### The agent authors card prose as markdown

Not because models can't emit block JSON — they can. Four reasons:

1. **Markdown is a pre-trained compression of the block vocabulary.** Every
   model already knows headings, bullet lists, numbered lists, checklists,
   quotes, code blocks, tables, links, images, bold and italic. That's most of
   BlockNote's block set for **zero context tokens**. Handing agents BlockNote
   JSON inverts this — now you're teaching a bespoke schema no model has seen,
   which means either a large schema in context or malformed blocks. *This is
   the strongest argument; the others are supporting.*

   | BlockNote block | Markdown | Cost to teach |
   |---|---|---|
   | paragraph, heading | text, `#` | 0 |
   | bulletListItem, numberedListItem | `-`, `1.` | 0 |
   | checkListItem | `- [ ]` | 0 |
   | quote, codeBlock | `>`, ` ``` ` | 0 |
   | table, image | `\| … \|`, `![](url)` | 0 |

   **Caveat learned the hard way:** advertising a block type in the tool schema
   is not the same as implementing it. Tables were listed here from the start
   but had no parser in the markdown→blocks direction, so an agent's table
   silently collapsed into one run-on paragraph of literal pipes. Anything named
   in `CONTENT_DESC` needs a parser, a serialiser, *and* a test that opens the
   result in the real editor.

2. **Contract stability.** The block format is BlockNote's private
   representation — `props.textColor`, `content[].styles`, per-block `id`. If
   agents author it directly, our MCP contract is welded to a third-party
   editor's schema. Swap editors and every agent-written document breaks, along
   with every habit agents have formed. Markdown is a stable contract; blocks
   are an implementation detail that happens to be visible today.

3. **Cost.** A checklist item is ~40 tokens as blocks, ~8 as markdown. On a
   20-card map, on the agent's budget.

4. **Failure mode.** Malformed blocks render as a blank card (this actually
   happened while hand-writing seed data). Malformed markdown degrades to
   slightly-wrong text.

### But accept both

`content` is a union — markdown string, or `{ blocks: [...] }`:

```jsonc
{ "title": "Tokenization gaps",
  "content": "## Findings\n- [ ] Vault rotation unclear" }

{ "title": "Tokenization gaps",
  "content": { "blocks": [ /* … */ ] } }
```

Markdown documented as the recommended form; blocks available when an agent
needs something markdown can't express. It's a discriminated union — cheap — and
it means reality settles the question rather than us guessing.

An agent can also **mix**: markdown for the prose, blocks for the one element
that needs to be a custom type.

### The residue markdown can't express

Block *attributes* — colour, alignment, image width — and any **custom** block
type we add later (a Linear ticket embed, a chart). Two outs, neither requiring
a vocabulary dump: a small extension syntax for the ones that recur, e.g.

```markdown
> [!risk] Rotation cadence is undocumented
> The QSA will ask. Nobody owns this yet.
```

…which we map to a styled block in our own converter; or the blocks form for
that specific element.

## 5. Storage: what the database holds

**BlockNote JSON is the source of truth. Markdown is a derived projection.**

```
nodes.doc   →  BlockNote blocks   — truth; what the editor reads and writes
nodes.body  →  markdown           — regenerated on every save
```

Markdown-as-truth was considered and rejected: it's lossy for colours,
alignment, image props and nested structures, so every save would round-trip
markdown → blocks → markdown and degrade the document a little each time.
Silent, cumulative loss is the worst failure mode available.

Blocks-as-truth alone is also wrong, because blocks are useless for everything
that isn't the editor. The markdown projection feeds:

- **search** — you can't sensibly query `content[].styles`; markdown in a column
  makes D1 FTS5 straightforward
- **the MCP `get_mindmap` payload** — wanted as markdown anyway
- **the collapsed-card preview** — strip markdown syntax at render time so
  `## Findings` doesn't show literal hashes
- **migration insurance** — if we ever leave BlockNote, this column *is* the
  export

**Today's state:** `body` currently holds a plain-text join with `·` separators
(`docToText`). Fine for a preview, useless for search or context. Upgrading it to
real markdown is the change to make when we build this.

**Consequence to remember:** when an agent writes markdown, we convert to blocks,
store blocks as truth, then regenerate the markdown projection. The agent's
markdown is *normalised*, not preserved byte-for-byte. Correct — agent-written
and human-written cards converge on one representation instead of drifting into
two — but it means an agent can't round-trip its own formatting exactly.

*The one thing that would flip this decision:* if documents ever needed to be
files in a git repo rather than rows in D1, markdown-as-truth wins, because
diffability would be the whole point.

## 6. Vocabulary discipline

We designed a `kind` field (`risk | decision | question | finding | task`)
mapping to CSS treatment, so agents could express semantics and the *board*
decides appearance. Rationale: agents are good at semantics and bad at design
systems — three separate runs will pick three different reds, and no single run
can see the others.

**Decision: don't ship it initially.** It was invented without evidence that
those five categories recur in real work. Ship the minimum surface, use it, and
add categories when they emerge from actual usage.

The general principle: **every piece of vocabulary is a tax on every session.**
Prefer enums (self-documenting, closed, ~40 tokens in the schema) over
conventions explained in prose (open-ended, unenforceable, and the actual source
of "giant context" problems). But prefer *nothing* until usage demands it.

## 6a. One noun: mindmap

"Workstream" was replaced by "mindmap" everywhere — UI, API, docs. The old noun
came from a design where a board carried `repos` and `linear_ids` so agent
sandboxes could mount them; that design is superseded, and those columns are
dropped (migration 0007).

The rename also simplifies this server's surface. `create_map(workstream_id, …)`
mixed two vocabularies; `create_mindmap(name, nodes[], edges[])` and
`add_to_mindmap(id, …)` use one. Fewer nouns is fewer schema tokens per session,
which is the discipline §6 argues for.

Worth knowing: "workstream" quietly forbade things you'd want in a brain — you
wouldn't open a *workstream* for "what I learned about the QSA process", but you
would open a mindmap for it.

## 7. Questions, and how they were answered

**Resolved:**

- **Auto-layout** — `worker/src/layout.ts`. Layered: edges give depth, each
  layer is a column, siblings stack down it. Depth is the *longest* path from
  a root, not the shortest, or a node depending on both a root and a deep node
  would sit level with the root and its arrow would point backwards. Cycles are
  expected ("blocks" and "informs" between the same pair), so the traversal is
  iterative with a relaxation cap rather than recursive.

  Ordering within a column is a separate phase from coordinates: alternating
  median sweeps in rank space, scored on the finished drawing and keeping the
  best candidate seen — including the agent's own input order and the single
  forward pass this file used to do. Scoring coordinates rather than ranks is
  deliberate; a rank-space count scores a long edge slicing across four columns
  as free and cannot see what the centring passes do afterwards, and both were
  measurable regressions on real graphs. Disconnected components are laid out
  separately and stacked, instead of interleaving their rows in shared columns.

- **Placing new work on an existing map** — `placeBlock` in the same file.
  Edges whose far end is a card already on the board are classified out before
  layout sees them, so "attach these findings to that card" places the new work
  *beside* that card; it used to be dropped, and the card landed at the bottom
  of the map with a line drawn all the way back. The block then spirals out
  from there into space that is actually free, preferring the flow direction
  and avoiding landing behind its own parent.

  The old rule was "strictly below everything already present", which is safe
  and turns a board into a long vertical ribbon with its right half empty: six
  `add_card` calls on a seven-card map used to extend it 2,100px downward.
  Below everything is now the last resort rather than the rule.

  What must never move is a card a **human** placed, which is narrower than
  "anything already present" and is the distinction that was missing. A drag or
  a positioned create sets `data.placed = "hand"` server-side (`index.ts`), and
  those cards are obstacles forever. A component in which *every* card was
  machine-placed is rebuilt along with the new nodes, so a map an agent has
  been extending stays tidy. `relayout_mindmap` is the one tool that overrules
  the flag, and it clears it: its whole contract is "rearrange this map", and
  honouring the flag would make it a no-op on exactly the boards that need it.

- **Auth and transport** — Streamable HTTP at `POST /mcp`, OAuth 2.1 with PKCE
  S256, no API keys. We are both authorization server and resource server. See
  §9. Tokens are opaque, stored only as SHA-256 hashes, and carry the RFC 8707
  audience so one minted for us can't be replayed elsewhere.

- **Search** — `LIKE` over the markdown projection, capped at 25 hits, as
  planned. FTS5 is the upgrade when it hurts; it can't hurt without real data.

- **Size caps on `get_mindmap`** — 60 cards and 4,000 characters per document,
  with a footer telling the agent to use `get_card` or `search` for the rest.
  Ink strokes and images are excluded entirely: they carry no text and would be
  pure noise in a context window. `include_documents: false` returns just the
  shape of the map for when the agent only needs to know what exists.

- **Heading collision** — cards are `##` in the payload, so a document's own
  `##` would be indistinguishable from the next card. Document headings are
  demoted two levels on the way out.

**Still open:**

- **Scope granularity.** Two scopes (`mindmaps:read`, `mindmaps:write`). Nothing
  yet lets a user grant access to *one* mindmap rather than all of them, which
  is the obvious next ask once this is shared with anyone.

- **Where per-card settings live.** `open_at` went into the existing
  `nodes.data` JSON blob rather than a new column — no migration, and it is
  already plumbed end to end. If a third or fourth card setting appears, that
  blob becomes an unversioned schema by accident; worth promoting to something
  explicit before then.

- ~~**Token management UI.**~~ **Done.** Settings lists connected harnesses with
  a Disconnect button, grouped by client rather than by token — refresh rotation
  mints a row per refresh, so a raw token list showed the same laptop a dozen
  times.

## 8. Protocol and auth as built

**Two protocol eras.** The current revision (`2026-07-28`) dropped the
`initialize` handshake in favour of `server/discover`, dropped protocol-level
sessions, and dropped the GET stream. Shipped clients haven't all followed, so
both eras are supported — they're different method names over one dispatcher,
so the cost is a few lines. `GET`/`DELETE /mcp` return 405, as the spec directs
a modern-only server to do.

Every tool is a couple of D1 queries, so responses are always a single JSON
object rather than an SSE stream. The spec lets the server choose per request,
and there is no progress to report on a 3ms query.

**Header validation.** `Mcp-Method` and `MCP-Protocol-Version` mirror body
fields. A *mismatch* is rejected with `-32020` — that's the whole point of the
rule, since an intermediary routing on the header and a server executing on the
body must not be able to disagree. *Absence* is tolerated: rejecting a request
that merely omits a header would lock out older clients for no security gain,
because a missing header can't disagree with anything.

**OAuth, no API keys.** RFC 9728 protected-resource metadata, RFC 8414
authorization-server metadata, RFC 7591 dynamic client registration, RFC 8707
resource indicators, RFC 9207 issuer identification. PKCE S256 required;
`plain` refused. Registration is open, which is safe because a `client_id`
grants nothing on its own: every code is bound to a PKCE verifier and every
token needs a real user to approve it at the consent screen.

Three details worth not losing:

- The authorization code is **burned before validation**, so a leaked code
  can't be retried until something lines up.
- `redirect_uri` is validated against the registered list **before** we are
  willing to redirect anywhere, including for protocol errors. Redirecting an
  error to an unvalidated URI is the classic open redirect.
- Refresh tokens **rotate**: redeeming one revokes the access token it came
  with, so a stolen refresh token stops working the moment the real client next
  refreshes.

## 8a. The graph, unified (phase 1 of the brain work)

Edges used to carry `board_id`, which encoded an assumption: both ends live on
the same canvas. That made mindmaps islands, and islands cannot be a brain —
the connections worth having are the ones between topics you had not noticed
were related. DESIGN.md §3 assumed a card could span two mindmaps from the
start; migration 0011 is the schema finally allowing it.

An edge is now a relationship between two cards, full stop. It renders on any
board where either end is present: both ends visible is a normal link, one end
visible is a **stub** — a dashed signpost naming the far card and its mindmap,
clickable to jump. Deliberately not a ghost card: a card here would claim the
far one lives on this canvas, a lie the layout would then have to maintain.

Ownership is derived rather than stored (users → boards → nodes → edges), so
there is no denormalised `user_id` to drift, and both endpoints are checked —
a link spanning two mindmaps is only yours if you own both.

Two things fell out of the rebuild that were worth having anyway:

- **Real foreign keys** on `source_id`/`target_id` with `ON DELETE CASCADE`.
  `edges` never had them, which is exactly why 0005 existed to sweep up orphans
  by hand and why the node-delete path removed links explicitly. Both retired.
- **`get_card` now lists what a card connects to**, with the mindmap each
  neighbour lives on. The labels are the reasoning — `blocks`, `informs`,
  `supersedes` — and reading a single card used to lose them entirely, which
  made the graph invisible unless you loaded a whole board.

### Why this changes the case for traversal

An earlier read of this called multi-hop traversal speculative. That was
conditioned on islands: inside one mindmap every path is short and already
visible on the canvas, so traversal tells you nothing you cannot see. In a
unified graph the valuable paths are precisely the ones that leave the map you
started in. Traversal is now the mechanism by which the brain surprises you,
which is phase 2.

### Multi-membership is deliberately absent

The same card on two mindmaps is a *curation* feature, not a recall one, and it
is what forces the confusing "remove from this view" versus "delete everywhere"
distinction on users. Cards can already reach each other; do this only if
curation turns out to matter.

## 8b. Retrieval (phase 2)

**`recall(query)` is the front door**, listed first so it is the tool an agent
meets first. It searches by wording *and* meaning, follows the links out from
what it finds, marks superseded cards, and returns a bounded ranked briefing.

One tool rather than four primitives, on the §6 argument: every schema is
context tax on every session, and search → expand → rank assembled inside the
model is work it will do inconsistently. `get_context(id, depth)` sits
underneath for when the agent already knows what it wants.

Ranking blends relevance (bm25), **adjacency** — a card the graph reaches from
another match is more likely to be the one you meant — and a gentle recency
tiebreak. Superseded cards sink by a fixed penalty rather than being hidden;
the reasoning that led to them is often the point.

### Search

FTS5 with porter stemming replaced `LIKE '%q%'`, so "rotating" finds
"rotation". Two things worth keeping:

- **Queries are quoted per token before reaching MATCH.** `-`, `*`, `:`, `"`
  and bare AND/OR/NOT are FTS5 operators, so raw user text is a syntax error
  waiting to happen rather than a search.
- **Stopwords are dropped in the widened `any` pass.** FTS5's porter tokenizer
  has no stoplist, so an OR query for "who is accountable for the manual
  process" ranked by whichever card contained "the" most often. That is noise
  wearing relevance's clothes, and worse than no result because it looks like
  an answer. This was caught by a test that appeared to pass — the card was
  found, but on "the", not on meaning.

### Retrieval pipeline

Four retrievers, fused by rank, then reranked by a cross-encoder:

```
strict keyword (all terms) ─┐
loose keyword (any term)  ─┤
semantic (passage vectors)─┼─► RRF ─► supersession ─► top 24 ─► cross-encoder ─► top 8
graph adjacency           ─┤
recency                   ─┘
```

**Fusion is by rank, not score.** bm25 is unbounded and corpus-dependent;
cosine sits in 0..1. The earlier fusion added them with hand-tuned multipliers
(`semantic x8`, `strict +4`, `graph +1.5`, `superseded -6`) chosen to make the
units roughly line up — constants nobody measured, that could not be measured
without an eval set, and that the move to bge-m3 would have invalidated on its
own. RRF uses only the position within each list, so units cancel: `Σ w/(60+rank)`.
A card several retrievers agree on beats one that a single retriever loves,
which is the right bias when each is individually unreliable.

Supersession is a **multiplier** (`x0.3`) rather than a subtraction, because RRF
scores live in a narrow band where any fixed penalty is either a no-op or
annihilating depending on how many retrievers agreed.

**The cross-encoder runs last, over a shortlist of 24.** Everything upstream
compares the query to a card without ever looking at the two together. A
cross-encoder reads both at once, which is why it is worth a second inference
call — and why it cannot run over a corpus. It scores the *winning passage*, not
the head of the document, which is what makes it work on long cards.

Two things that bite:

- **Supersession has to be reapplied after reranking.** The cross-encoder
  judges relevance and knows nothing about a card having been replaced, so a
  superseded card that answers the question perfectly climbs straight back to
  the top. Applied by partitioning, not arithmetic: bge-reranker-base returns
  small positives, so a `-1` multiplier works today and silently *promotes* the
  demoted against any model emitting raw logits.
- **If the reranker is unavailable the fusion order stands.** That order was the
  whole answer until now and remains a good one.

### Semantic index

Workers AI (`@cf/baai/bge-m3`, **1024 dims**) into Vectorize, written on every
card save — one vector per passage, not per card. This does not breach the
founding constraint: §2 rejected designs that billed **agent inference** to us.
Embedding our own cards is infrastructure, like D1 and R2, and no model is ever
run on the user's behalf. The reranker is the same category again.

bge-m3 replaced bge-base-en-v1.5, which was English-only and 768-dim. Two
consequences worth knowing before touching this:

- **It needed a new Vectorize index.** Dimensions are fixed at creation, so
  `mindmaps-cards` could not be reused; `mindmaps-chunks` replaces it.
- **bge-m3 returns `response`, not `data`.** Both are `number[][]`, so the type
  system cannot catch the difference — reading the wrong key yields `undefined`,
  which the indexer would treat as "skip this card", silently and forever. Both
  keys are read. (In practice the response carries both, but the schema only
  promises `response`.)

**Two write paths, two indexing strategies.** MCP writes index inline; browser
edits mark `nodes.index_dirty` and a once-a-minute cron sweeps them.

|  | when | why |
|---|---|---|
| MCP write | inline | an agent records something and recalls it moments later — that is the workflow. It does not write a character at a time. |
| browser edit | ≤60s, swept | the editor commits on a 400ms debounce, so inline indexing would embed every pause mid-sentence |

Before this, `indexCard` was reachable only from MCP, so a card edited in the web
app kept vectors describing its previous text — findable by wording, answered by
meaning from prose it no longer contained. Worse after chunking, because a
shortened card also kept the passages it had lost.

Marking is deliberately narrow: only `title`, `body` and `doc` set the flag. A
drag sends `x/y` on every drop and a resize sends `w/h`; marking on those would
queue an inference call for moving a card across the canvas. The flag is cleared
*after* the embedding succeeds, so an interrupted sweep retries rather than
losing the edit silently.

Deleting a card now also removes its vectors. Chunk rows cascade with the node,
but Vectorize knows nothing about a D1 delete — orphaned vectors keep returning
a card that no longer exists, surviving retrieval and dying at the D1 join, so
the symptom is a recall that quietly returns fewer results than it found.

**A card is usually its title.** A card is one line of text until you open it,
and a note keeps its whole content in `title` with an empty `body` — 132 of 230
cards on the production database. Indexing `body` alone made the majority of the
corpus unfindable by meaning, a regression invisible to any test written against
a card that happens to have prose. `chunksFor` falls back to the title.

**Vectorize indexing is asynchronous**, and there is no synchronous mode to
switch on. An upsert goes through a write-ahead log and becomes queryable
later: we measured ~75s, and Cloudflare's 2026-07-01 WAL improvement quotes
median under 30s and p99 under 2 minutes. Treat those as the floor, not a
hiccup — do not write a test that upserts and queries seconds apart and
conclude semantic search is broken.

This was originally accepted as "findable by wording immediately, by meaning a
minute later". It is no longer, because of *when* it bites. The workflow this
brain exists for is: write down what you just learned, keep working, then ask
what you know — all inside one session, minutes apart, which is exactly the
window where Vectorize has the old answer or none. The lag is least visible in
a benchmark and most visible in the one workflow the product is for.

So the recent tail no longer depends on Vectorize. `nodes.embedding` keeps the
768-float vector next to the card (0015), and `similarIds` runs two passes
against the same query vector:

| pass | covers | how |
|---|---|---|
| Vectorize | everything | ANN query, `namespace` = user |
| fresh | last 10 minutes | exact cosine in the Worker over `nodes.embedding` |

Same metric on the same scale, so they merge without reconciliation, and the
fresh score wins every collision — a card edited inside the window has a vector
in Vectorize describing what it *used* to say. A linear scan is the right
algorithm precisely because the window bounds it: an approximate index earns
its keep over a corpus, not over a tail of single-digit rows.

Two things that were not obvious and are load-bearing:

- **D1 returns BLOBs as `number[]`, not `ArrayBuffer`.** `unpackVector` handles
  both. Assuming `ArrayBuffer` fails as "the fresh pass silently returns
  nothing", which ranks among the hardest bugs to notice in a ranking system.
- **Ownership is an `EXISTS`, not a `JOIN`.** Written as a join the planner
  drove off `boards`, walked every node the user owns and sorted them in a temp
  b-tree. `EXISTS` makes the time range the driving scan against
  `idx_nodes_embedded_at` and reduces ownership to a primary-key probe.

The stored vector is also the rebuild path: re-populating a fresh Vectorize
index reads these back instead of re-running inference over every card.

Both bindings are optional. Without them `recall` falls back to keyword-only
and says so in its output, because an agent that gets nothing back needs to
know whether the brain has no memory of a topic or merely could not look.

### Idempotency

The failure this closes is the one that made the brain get *worse* with use:
run "summarise this session" twice and you got two overlapping mindmaps, then
three. Every repeat degraded the memory.

A stable `key` makes a write mean "ensure this is recorded" rather than "append
this again":

| | scope | example |
|---|---|---|
| `boards.idem_key` | per user | `pci-2026-notes` |
| `nodes.idem_key` | per mindmap | `vault-rotation` |

Node keys are scoped to a board for a specific reason: agents already pass
throwaway keys like `a`/`b`/`n0` to wire edges within one call, and making
those persist globally would turn every second call into a collision. Per
board, `a` on one mindmap is simply a different thing from `a` on another.

NULLs are distinct in a SQLite unique index, so unkeyed writes are
unconstrained and behave exactly as they always did — which is what makes this
safe to add to a live tool surface.

Three rules that took thought:

- **Positions are never overwritten.** The user may have arranged the board by
  hand since; an agent restating what it knows must not rearrange their desk.
- **`data` is preserved** — `open_at` and the original author survive a re-run.
  A repeat states the content, not who first wrote it.
- **Omission is not deletion.** A second summary that happens to leave a card
  out is not evidence the user wants it gone. Silently dropping recorded
  thinking is the one unrecoverable mistake a brain can make, so removal stays
  an explicit act and merges only add or update.

Links match on the pair of cards, so a re-run relabels rather than stacking a
second arrow between the same two.

### Supersession and provenance

A link labelled `supersedes` (or `replaces`, or the common misspelling
`supercedes`) is treated as structure: the superseded card is marked in
`get_card`, `get_context` and `recall`, and sinks in ranking. No schema — it
uses what agents already write.

`nodes.data.by` records which connected harness wrote a card, resolved to a
name on read. The cheapest possible version of Graphiti's episode lineage: not
which conversation produced it, but at least what did.

## 9. What this still deletes from the current build

**Not done yet — deliberately left alone.** The research path is dead code now
that we never call a model, but deleting it is a separate, destructive change
and it isn't in the way. Kept for a decision, not forgotten:

- `ThreadSection.tsx`
- `sessions` and `events` tables
- `worker/src/anthropic.ts`
- `worker/scripts/setup.mjs`
- the Managed Agents integration and its beta headers
- `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` handling

The card detail panel loses its thread section and becomes title + document.
R2 stays — it's still used for pasted images.

---

## Sources for the platform facts above

- [Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  — subscription auth, third-party app support, per-plan credits (Pro $20,
  Max 5× $100, Max 20× $200, Team Standard $20, Team Premium $100, Enterprise
  $200); credits scheme paused 15 Jun 2026, usage currently draws on standard
  subscription limits
- [Claude Code with Pro/Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [Authentication](https://platform.claude.com/docs/en/manage-claude/authentication)
  — API key, Workload Identity Federation, App Attest. **No third-party OAuth.**
- [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)
  — usage groups by `api_key_id`; cost groups by `workspace_id`; all
  organization-scoped
