# Artefacts — Design

Sheets, documents and decks as first-class nodes, edited with
[Spindle](https://github.com/b32n/spindle) and stored as plain JSON.

Status: design, nothing built. v0 is artefacts without sharing; v1 adds it.

---

## 1. Why this belongs here

An agent can already write markdown into memory, or files into a repo. There is
nowhere good for it to produce a **shareable artefact** — a cost model, a
printable scope document, a deck for Tuesday — that a person then opens,
adjusts and sends on. Drive is human-first with AI bolted on afterwards.

The differentiator is not the editors. It is that the artefact sits **in the
graph**, joined by labelled links to the thinking that produced it:

```
Auth consolidation  ──produced──▶  Migration cost model      (sheet)
August incident     ──explains──▶  Postmortem                (doc)
PCI 2026            ──presents──▶  QSA walkthrough           (deck)
```

Folders cannot say that. `recall` already walks those links, so asking what you
know about the auth work returns the reasoning *and* the model that came out of
it.

**Positioning stays "a brain".** Artefacts are what the brain produces. The
Drive framing is real but secondary, and the landing page does not change in
v0.

---

## 2. Why the second representation is fine here

MCP.md §5 and the markdown migration removed `nodes.doc` because it was a
*duplicate*: block JSON and markdown were two encodings of the same content and
could disagree. They did, and cards edited in the browser lost everything past
500 characters.

An artefact is different. A spreadsheet is not expressible as markdown without
losing the thing that makes it a spreadsheet. So:

```
nodes.data   the artefact. WorkbookData | DocumentData | DeckData. Authoritative.
nodes.body   a text snapshot, for FTS and embeddings. Derived, never authored.
```

The rule that keeps this honest is the one already enforced for cards
(`bodyFromDoc` in `worker/src/index.ts`): **`body` is computed server-side on
every write and a `body` sent by a client is ignored.** One direction, one
implementation, no possibility of drift.

### What the snapshot contains

| type | snapshot |
|---|---|
| sheet | sheet names, then each sheet's non-empty text cells row by row, formulas as their text |
| doc | the prose: headings and paragraphs in order, tables flattened |
| deck | slide titles, body text, and speaker notes |

Numbers are included but carry little retrieval signal; the labels around them
are what makes a model findable. "Which sheet had the RTO targets" has to work.

**Without this the brain has holes.** You search for something you know you
made, get nothing, and stop trusting recall generally. That is worse than not
having artefacts at all.

### Indexing the raw JSON instead does not work

Measured with bge-m3 on two unrelated sheets, an infrastructure cost model and
an apple cultivar table:

| | as raw JSON | as snapshot |
|---|---|---|
| separation between the right and wrong sheet | **0.046** | **0.199** |
| the two unrelated sheets against each other | **0.848** | 0.362 |
| characters embedded | 1,272 | 119 |

0.848 between a cost model and a planting table means they are very nearly
indistinguishable. Around 85% of a workbook's JSON is scaffolding that every
sheet shares — `styleId`, `formatId`, `rowCount`, `frozenRows`, `"key":"0:0"` —
so the vector encodes "this is a Spindle workbook" and the content is noise on
top of it. A separation of 0.046 is not a ranking.

Three further reasons beyond the vectors:

- FTS would index JSON keys, so a keyword search for `format` returns every
  sheet in the account.
- The chunker splits on paragraphs and sentences. JSON has neither, so passages
  would cut through `{"key":"3:2","cell":{"value":`.
- `recall` prints the matched passage. A fragment of raw JSON is not an answer.

---

## 3. Storage

Three stores, each holding the thing it is good at.

```
D1   nodes.data   {"r2":"artefacts/<nodeId>","kind":"sheet","sheets":2,"cells":412}
     nodes.body   derived text snapshot            -> FTS + node_chunks
R2   artefacts/<nodeId>     the WorkbookData JSON, fetched only by the editor
Vectorize                   passage vectors, exactly as for cards today
```

### Why the payload goes to R2, not a D1 column

Not the size ceiling. D1 allows 2 MB per row or string, and the 100 KB SQL
statement cap applies to statement text rather than bound parameters, so a
realistic sheet would fit.

The reason is **structural separation**. The board load is:

```sql
SELECT n.* FROM nodes n WHERE n.board_id = ?
```

Every column of every node. With the payload in D1, keeping megabytes of
spreadsheet out of a board load depends on nobody ever writing `SELECT *` —
and that line is already in the codebase. With the payload in R2 it cannot be
loaded by accident: the board gets a pointer, the editor route fetches the
object.

R2 is not a new dependency either; images already use it.

**The cost, which must be paid this time.** `IMAGES` objects are never deleted
when their node is deleted, so there is an orphan leak in production today.
Artefacts must delete `artefacts/<nodeId>` in the node DELETE path, next to the
existing `removeCards` call that clears Vectorize.

**Write order: R2 first, then D1.** A failed D1 write leaves an orphan object
that the next save overwrites. The reverse leaves a pointer to nothing.

`data` keeps a small summary so a collapsed node can render "2 sheets · 412
cells" without a round trip to R2.

### Why the snapshot cannot live in Vectorize

Vectorize stores vectors and returns ids and scores. It is not a text store.
A snapshot that lives only there loses:

- **FTS.** bm25 needs the text in SQLite, so artefacts would be findable by
  meaning but never by wording.
- **Rank fusion.** RRF needs every retriever ranking the same candidates.
  Artefacts would appear in one list out of five.
- **The fresh window.** The exact-cosine pass that covers Vectorize's write lag
  reads `node_chunks.embedding` out of D1.
- **The passage.** `recall` prints the matched text from `node_chunks.text`.

So the snapshot is text in `nodes.body`, chunked into `node_chunks` exactly as a
card is, and its vectors go to Vectorize. That is not a change; it is the
existing pipeline, and artefacts simply have to enter it.

### Retrieval

Six queries filter `type IN ('card','note')` (`mcp.ts` x4, `index.ts` x2).
Those widen to include the artefact types. Chunking needs no change: it splits
`body`, which is text either way.

## 4. Agent authoring

This decides whether the feature lands. If an agent cannot produce a useful
sheet in one call, you will end up filling them in by hand and it is Drive with
extra steps.

Spindle is already shaped for this. The slides docs say a deck is "plain JSON —
easy to author by hand, generate with an LLM, or diff", and `setData()`
normalises hand-authored input, filling in missing ids and fractional indices.

### The tool surface

Every tool schema is context tax on every session (MCP.md §6), so the full
`WorkbookData` shape — style pools, format pools, eleven config fields, filters,
sort orders — must not live in a tool description. Two layers instead:

**`create_artefact` / `update_artefact`** take a *minimal* authoring format and
the server expands it with defaults. For a sheet that is little more than:

```json
{
  "type": "sheet",
  "mindmap_id": "…",
  "title": "Migration cost model",
  "sheets": [{
    "name": "Q3",
    "rows": [
      ["Service", "Cost", "Notes"],
      ["bank-platform", 1200, "excludes egress"],
      ["Total", "=SUM(B2:B3)", ""]
    ]
  }]
}
```

Anything richer is reachable by passing a full `data` payload instead.

**`get_artefact_schema(type)`** returns the full TypeScript shape on demand.
This keeps the always-loaded surface small while leaving styles, frozen panes
and themes available to an agent that wants them.

MCP resources are arguably the spec-native home for a schema, and
`resources/list` currently returns `[]`. But harness support for resources is
uneven where tool support is universal, so: ship the tool, and expose the same
thing as a resource for harnesses that read them.

---

## 5. Editors

One route per artefact, lazy-loaded by type, so a board that contains no decks
never downloads the deck editor.

```
/app/:boardId?card=:nodeId     opens a card in place, as today
/artefact/:nodeId              full-window editor for sheet | doc | deck
```

A collapsed artefact node on the board shows title, type and a small summary
(sheet dimensions, page count, slide count) rather than an editor. Opening one
is a route change, not an in-card expansion: these want the whole window, and
it keeps the board's bundle unchanged.

Bundle discipline learned from the Milkdown swap, which applies directly here:

- import from the narrowest entry point; aggregate entry points defeat
  tree-shaking even when features are disabled in config
- import per-feature CSS, never a theme's aggregate stylesheet
- pin serialiser options so a human edit does not rewrite what an agent wrote

---

## 6. Scope

**v0 — artefacts, no sharing.**

- [ ] `sheet` node type end to end: schema, minimal authoring format, snapshot,
      graph links, lazy editor route
- [ ] retrieval filters widened, snapshot regenerated on write
- [ ] `create_artefact`, `update_artefact`, `get_artefact_schema`
- [ ] then `doc` and `deck`, which should be mostly repetition

Sheets first, not because they matter most, but because they are the thinnest
slice that proves every hard part: agent authorship of structured content,
retrieval over a derived snapshot, and the lazy editor route. If an agent writes
a sheet that recall then finds and links to the card that motivated it, the
pattern is proven.

**v1 — publishing.** Share links, print, download as xlsx/docx/pptx.

Worth knowing before starting v1: **every query in the worker filters on the
owning account and there is no sharing of any kind today.** Public links mean
expiry, revocation, possibly passwords, and a render path that works with no
session. That is a real body of work, and it is the part that makes these
artefacts rather than files, so it should not be half-done.

---

## 7. What would make this a bad idea

Recorded so the decision can be revisited honestly.

- **The snapshot turns out to be useless for retrieval.** If "the Q3 model"
  cannot be found by meaning, the artefacts are a filing cabinet bolted to a
  brain. Test this early with a real sheet, not a toy one.
- **Agents create empty artefacts.** If the authoring format is awkward, agents
  will make the node and leave it blank. Design the format before the UI and try
  it against a real agent session.
- **It becomes the product.** Artefacts are a bigger idea than mindmaps and
  could quietly take over the roadmap. The brain is the thing; this serves it.
