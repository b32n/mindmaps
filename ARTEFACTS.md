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

---

## 3. Storage

No new tables. `nodes.type` is already open and `nodes.data` is already JSON.

```
type      'sheet' | 'doc' | 'deck'      alongside card | note | image | stroke
data      the Spindle *Data payload
body      derived text snapshot
title     the artefact's name, same column cards use
```

Retrieval currently filters `type IN ('card','note')` in six places
(`mcp.ts` ×4, `index.ts` ×2). Those become `IN ('card','note','sheet','doc','deck')`.
Chunking needs no change: it splits `body`, which is text either way.

**Open question.** `WorkbookData` for a large model could be hundreds of
kilobytes in a D1 row. Cards are ~2 kB. Worth measuring a realistic sheet before
committing to the column; R2 with a pointer in `data` is the fallback, at the
cost of a second fetch on open.

---

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
