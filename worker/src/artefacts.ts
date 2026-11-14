/**
 * Artefacts: sheets, and later documents and decks.
 *
 * Three stores, each holding what it is good at (ARTEFACTS.md §3):
 *
 *   D1   nodes.data   a pointer and a small summary
 *        nodes.body   a derived text snapshot, which is what the brain reads
 *   R2   artefacts/<nodeId>   the payload, fetched only by the editor
 *
 * The payload is in R2 rather than a D1 column for one reason: the board load
 * is `SELECT n.*`, so keeping megabytes of spreadsheet out of it would depend
 * on nobody ever writing `SELECT *` again. That line is already in the
 * codebase. R2 makes it impossible rather than merely discouraged.
 */

import { ARTEFACT_SCHEMAS, SHEET_SCHEMA } from "./artefact-schema";
import { FILE_TYPES } from "./files";

export interface ArtefactEnv {
  DB: D1Database;
  ARTEFACTS: R2Bucket;
}

export type ArtefactKind = "sheet" | "doc" | "deck" | "html";

/**
 * Node types that live in R2 and carry a derived snapshot.
 *
 * `deck` rather than `slides`: the artefact is a deck, and that is the noun an
 * agent reaches for. It is backed by `@b32nio/spindle-slides-*` on the web side.
 */
export const ARTEFACT_TYPES: readonly string[] = ["sheet", "doc", "deck", "html"];

export const isArtefact = (type: string): type is ArtefactKind =>
  ARTEFACT_TYPES.includes(type);

/**
 * The node types the brain reads, as a SQL list.
 *
 * Six queries filter on this — FTS, the dense pass, the graph walk, board
 * listings — and the first time it was widened, for `sheet`, each one had to be
 * found by hand. A constant means adding a kind is one edit to ARTEFACT_TYPES
 * rather than six greps, and a missed site means a kind that is silently
 * unsearchable.
 */
export const INDEXABLE_SQL = ["card", "note", ...ARTEFACT_TYPES, ...FILE_TYPES]
  .map((t) => `'${t}'`)
  .join(",");

/**
 * Just the artefact kinds, for the listing that shows them on their own.
 *
 * Files and folders belong in this list and not in `ARTEFACT_TYPES`, and the
 * split is load-bearing. To a person and to `recall` a file is an artefact: it
 * is a thing you come back to, it has a snapshot, it appears in the artefacts
 * list. To `putArtefact` it is not, because it has no JSON payload to parse and
 * no derived format to write back. Folding them into `ARTEFACT_TYPES` would
 * make `isArtefact` true for a file and hand the PUT route bytes it would try
 * to `JSON.stringify`.
 */
export const ARTEFACT_SQL = [...ARTEFACT_TYPES, ...FILE_TYPES]
  .map((t) => `'${t}'`)
  .join(",");

/**
 * Refuses a payload that would not survive the round trip.
 *
 * D1 caps a row at 2 MB and R2 is effectively unbounded, so this is about
 * keeping a single artefact from becoming something nobody can open rather
 * than a storage limit. Failing loudly on write beats a card that loads
 * forever.
 */
const MAX_PAYLOAD_BYTES = 4_000_000;

export const artefactKey = (nodeId: string) => `artefacts/${nodeId}`;

// ---------------------------------------------------------------------------
// Minimal authoring format
// ---------------------------------------------------------------------------

/**
 * What an agent actually sends.
 *
 * The full `WorkbookData` shape — style pools, format pools, eleven config
 * fields, filters, sort orders — is far too much to put in a tool description
 * that every session pays for (MCP.md §6). This covers the case that matters:
 * named sheets of rows. Anything richer is reachable by passing a complete
 * `data` payload instead, with the shape available from `get_artefact_schema`.
 */
export interface SheetInput {
  name?: string;
  rows?: unknown[][];
}

type CellValue = string | number | boolean | null;

interface Cell {
  value: CellValue;
  formula?: string;
}

/** A blank grid big enough that a new sheet does not look broken. */
const MIN_ROWS = 100;
const MIN_COLS = 26;

/**
 * Expand rows into Spindle's `WorkbookData`.
 *
 * Cells are sparse: empty values are omitted rather than stored, which is what
 * keeps a mostly-blank grid small. A string beginning `=` is kept as a formula
 * with a null value, because the value is Spindle's to compute — writing one
 * here would be a guess that goes stale the moment anything it references
 * changes.
 */
export function sheetFromInput(title: string, sheets: SheetInput[]): unknown {
  const list = sheets.length ? sheets : [{ name: "Sheet1", rows: [] }];

  return {
    id: crypto.randomUUID(),
    name: title || "Untitled sheet",
    activeSheetId: "s0",
    defaultRowHeight: 24,
    defaultColWidth: 110,
    stylePool: { header: { bold: true } },
    sheets: list.map((s, si) => {
      const rows = Array.isArray(s.rows) ? s.rows : [];
      const cells: Array<{ key: string; cell: Cell }> = [];
      let widest = 0;

      rows.forEach((row, ri) => {
        const cols = Array.isArray(row) ? row : [];
        widest = Math.max(widest, cols.length);
        cols.forEach((raw, ci) => {
          if (raw === null || raw === undefined || raw === "") return;
          const cell: Cell =
            typeof raw === "string" && raw.startsWith("=")
              ? { value: null, formula: raw }
              : { value: raw as CellValue };
          // A first row of labels is the overwhelmingly common shape, and bold
          // headers are what make a sheet readable at a glance.
          cells.push({ key: `${ri}:${ci}`, cell: ri === 0 ? { ...cell, styleId: "header" } as Cell : cell });
        });
      });

      return {
        id: `s${si}`,
        name: s.name || `Sheet${si + 1}`,
        cells,
        config: {
          defaultRowHeight: 24,
          defaultColWidth: 110,
          // A header row that scrolls away is the single most common
          // annoyance in a spreadsheet, and rows[0] is a header in practice.
          frozenRows: rows.length > 1 ? 1 : 0,
          frozenCols: 0,
          showGridLines: true,
        },
        rowCount: Math.max(rows.length, MIN_ROWS),
        colCount: Math.max(widest, MIN_COLS),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface Sheet {
  name?: string;
  cells?: Array<{ key: string; cell: Cell }>;
  /** `[position, id]` pairs. Present once a workbook has been through the editor. */
  rowOrder?: Array<[number, string]>;
  colOrder?: Array<[number, string]>;
}

/**
 * Turn a `rowOrder`/`colOrder` list into id -> position.
 *
 * Spindle keys cells by stable row and column *ids*, not by index, so that
 * inserting a row above a cell does not rewrite every key below it. The
 * position is carried separately in these lists.
 */
function positionsOf(order: Array<[number, string]> | undefined): Map<string, number> | null {
  if (!Array.isArray(order)) return null;
  const at = new Map<string, number>();
  for (const pair of order) {
    if (Array.isArray(pair) && typeof pair[1] === "string" && Number.isFinite(pair[0]))
      at.set(pair[1], pair[0]);
  }
  return at;
}

/**
 * A key part to a position.
 *
 * Two shapes reach here. A workbook built by `sheetFromInput` has never been
 * opened, so its keys are plain `"row:col"` indices and it carries no order
 * lists. One that has been saved from the editor has id keys and the lists to
 * resolve them. Reading only the second shape silently emptied the snapshot of
 * every freshly authored sheet; reading only the first emptied it the moment
 * anyone typed in one.
 */
function resolve(part: string | undefined, at: Map<string, number> | null): number | null {
  if (part === undefined) return null;
  if (at) {
    const pos = at.get(part);
    if (pos !== undefined) return pos;
  }
  const n = Number(part);
  return Number.isFinite(n) ? n : null;
}

/**
 * The text a sheet contributes to the brain.
 *
 * Labels, not numbers. "Which sheet had the RTO targets" has to work, and the
 * words around a figure are what make it findable; the figure itself carries
 * almost no retrieval signal. Formulas are included as their text because
 * `=SUM(Recovery!B2:B9)` names a thing.
 *
 * Indexing the raw JSON instead was measured and does not work: two unrelated
 * sheets scored 0.848 cosine against each other, because most of a workbook's
 * JSON is scaffolding every sheet shares. See ARTEFACTS.md §2.
 */
export function sheetSnapshot(payload: unknown): string {
  const wb = payload as { name?: string; sheets?: Sheet[] };
  const out: string[] = [];
  if (wb?.name) out.push(String(wb.name));

  for (const sheet of wb?.sheets ?? []) {
    if (sheet?.name) out.push(String(sheet.name));

    const rows = positionsOf(sheet?.rowOrder);
    const cols = positionsOf(sheet?.colOrder);

    // Group by row so the snapshot reads left-to-right the way the sheet does.
    // A column-major dump would put a header miles from the value under it and
    // embed as noise.
    const byRow = new Map<number, Array<[number, string]>>();
    for (const entry of sheet?.cells ?? []) {
      const [rk, ck] = String(entry?.key ?? "").split(":");
      const r = resolve(rk, rows);
      const c = resolve(ck, cols);
      if (r === null || c === null) continue;
      const v = entry.cell?.formula ?? entry.cell?.value;
      if (v === null || v === undefined || v === "") continue;
      if (!byRow.has(r)) byRow.set(r, []);
      byRow.get(r)!.push([c, String(v)]);
    }

    for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
      const line = byRow
        .get(r)!
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
        .join(" ");
      if (line.trim()) out.push(line);
    }
  }

  return out.join("\n").trim();
}

/** A one-line description for a collapsed node, so the board needs no R2 read. */
export function sheetSummary(payload: unknown): { sheets: number; cells: number } {
  const wb = payload as { sheets?: Array<{ cells?: unknown[] }> };
  const sheets = wb?.sheets ?? [];
  return {
    sheets: sheets.length,
    cells: sheets.reduce((n, s) => n + (s?.cells?.length ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * A block, as an agent writes one.
 *
 * Spindle's `Block` union carries ids, style pool references, inline content
 * arrays and seven block types. This is the subset worth putting in a tool
 * description: a heading, a paragraph, a list item, a rule. Anything richer
 * goes through a full `data` payload.
 *
 * A bare string is a paragraph, because that is what most lines are and making
 * the common case wordy is how authoring formats go unused.
 */
export interface DocBlockInput {
  heading?: string;
  /** 1-6. Defaults to 2: a document's own title is the node title. */
  level?: number;
  text?: string;
  bullet?: string;
  number?: string;
  rule?: boolean;
}

/** Letter portrait with one-inch margins, matching DEFAULT_PAGE_CONFIG. */
const PAGE_CONFIG = {
  size: { w: 816, h: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96, header: 48, footer: 48 },
  orientation: "portrait",
};

const runs = (text: string) => [{ type: "text", text: String(text) }];

/**
 * Expand blocks into Spindle's `DocumentData`.
 *
 * One section: a document that needs more than one is a document being laid out
 * rather than written, and that is the editor's job, not an agent's.
 */
export function docFromInput(title: string, blocks: Array<DocBlockInput | string>): unknown {
  const out: unknown[] = [];

  for (const raw of blocks) {
    const b: DocBlockInput = typeof raw === "string" ? { text: raw } : raw ?? {};
    const id = crypto.randomUUID();

    if (b.heading !== undefined) {
      const level = Math.min(6, Math.max(1, Math.round(b.level ?? 2)));
      out.push({ id, type: "heading", level, content: runs(b.heading) });
    } else if (b.bullet !== undefined) {
      out.push({ id, type: "list-item", listType: "bullet", level: 0, content: runs(b.bullet) });
    } else if (b.number !== undefined) {
      out.push({ id, type: "list-item", listType: "numbered", level: 0, content: runs(b.number) });
    } else if (b.rule) {
      out.push({ id, type: "horizontal-rule" });
    } else if (b.text !== undefined) {
      out.push({ id, type: "paragraph", content: runs(b.text) });
    }
  }

  // A document with no blocks still needs somewhere for the cursor to land.
  if (!out.length) out.push({ id: crypto.randomUUID(), type: "paragraph", content: [] });

  return {
    id: crypto.randomUUID(),
    title: title || "Untitled document",
    sections: [{ id: crypto.randomUUID(), pageConfig: PAGE_CONFIG, blocks: out }],
    defaultPageConfig: PAGE_CONFIG,
    textStylePool: {},
    paragraphStylePool: {},
  };
}

/** Flatten a block's inline content to its text. */
function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((run) => {
      const r = run as { type?: string; text?: string; alt?: string };
      if (r?.type === "text" || r?.type === "link") return r.text ?? "";
      // An image contributes its alt text or nothing. A src is a URL, and URLs
      // embed as noise.
      if (r?.type === "image") return r.alt ?? "";
      return "";
    })
    .join("");
}

/**
 * The text a document contributes to the brain.
 *
 * Nearly all of a document *is* text, so unlike a sheet this is close to a
 * straight read. Headings are kept inline rather than marked up: the embedding
 * has no use for `##`, and the words are the signal either way.
 */
export function docSnapshot(payload: unknown): string {
  const doc = payload as {
    title?: string;
    sections?: Array<{ blocks?: Array<Record<string, unknown>> }>;
  };
  const out: string[] = [];
  if (doc?.title) out.push(String(doc.title));

  for (const section of doc?.sections ?? []) {
    for (const block of section?.blocks ?? []) {
      const type = String(block?.type ?? "");
      if (type === "table") {
        // Row by row, the same reasoning as a sheet: a column-major dump puts a
        // header miles from the value under it.
        for (const row of (block.rows as Array<{ cells?: Array<{ content?: unknown }> }>) ?? []) {
          const line = (row?.cells ?? []).map((c) => inlineText(c?.content)).join(" ").trim();
          if (line) out.push(line);
        }
        continue;
      }
      const line = inlineText(block?.content).trim();
      if (line) out.push(line);
    }
  }

  return out.join("\n").trim();
}

export function docSummary(payload: unknown): { blocks: number; words: number } {
  const doc = payload as {
    sections?: Array<{ blocks?: Array<Record<string, unknown>> }>;
  };

  // Counted from the blocks rather than from the snapshot, because the snapshot
  // opens with the title: a brand new empty document would otherwise announce
  // itself as "2 words" on the strength of being called "Untitled document".
  let words = 0;
  let blocks = 0;
  for (const section of doc?.sections ?? []) {
    for (const block of section?.blocks ?? []) {
      blocks++;
      const text = inlineText(block?.content).trim();
      if (text) words += text.split(/\s+/).filter(Boolean).length;
    }
  }
  return { blocks, words };
}

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

/** A slide, as an agent writes one. */
export interface SlideInput {
  title?: string;
  bullets?: string[];
  /** Speaker notes. Indexed like everything else, so they are findable. */
  notes?: string;
}

/** Matches DEFAULT_SLIDE_SIZE in spindle-slides-core. */
const SLIDE_W = 1280;
const SLIDE_H = 720;

const richText = (lines: string[], list: "none" | "bullet") => ({
  type: "doc",
  content: lines.map((line) => ({
    type: "paragraph",
    attrs: { listType: list },
    content: line ? [{ type: "text", text: String(line) }] : [],
  })),
});

/**
 * Expand slides into Spindle's `DeckData`.
 *
 * Deliberately partial: ids, z-order indices, the theme and the slide size are
 * all filled in by `normalizeDeckData` when the editor loads it. Generating
 * them here would mean reimplementing fractional indexing in the Worker and
 * pinning a theme that the library is entitled to change.
 *
 * Two text boxes per slide, laid out on the 1280x720 stage: a title band and a
 * body. Not a layout engine — a starting point someone can drag.
 */
export function deckFromInput(title: string, slides: SlideInput[]): unknown {
  const list = slides.length ? slides : [{ title: title || "Untitled deck" }];

  return {
    id: crypto.randomUUID(),
    title: title || "Untitled deck",
    slideSize: { w: SLIDE_W, h: SLIDE_H },
    slides: list.map((s) => {
      const elements: unknown[] = [];

      if (s?.title) {
        elements.push({
          type: "text",
          x: 80, y: 64, w: SLIDE_W - 160, h: 120, rotation: 0,
          richText: richText([s.title], "none"),
          bodyStyle: { vAlign: "middle", fontSize: 40, bold: true, fontFamily: "major" },
        });
      }

      const bullets = (s?.bullets ?? []).filter((b) => typeof b === "string" && b.trim());
      if (bullets.length) {
        elements.push({
          type: "text",
          x: 80, y: 216, w: SLIDE_W - 160, h: SLIDE_H - 300, rotation: 0,
          richText: richText(bullets, "bullet"),
          bodyStyle: { vAlign: "top", fontSize: 22, fontFamily: "minor" },
        });
      }

      return {
        elements,
        ...(s?.notes ? { notes: richText(String(s.notes).split("\n"), "none") } : {}),
      };
    }),
  };
}

/** Pull the words back out of a rich text doc. */
function richTextToLines(doc: unknown): string[] {
  const d = doc as { content?: Array<{ content?: Array<{ text?: string }> }> };
  return (d?.content ?? [])
    .map((para) => (para?.content ?? []).map((r) => r?.text ?? "").join("").trim())
    .filter(Boolean);
}

/**
 * The text a deck contributes to the brain.
 *
 * Slide by slide, in the order they are presented, with speaker notes included:
 * the notes are usually where the actual argument is written down, and leaving
 * them out would make the most quotable part of a deck the least findable.
 */
export function deckSnapshot(payload: unknown): string {
  const deck = payload as {
    title?: string;
    slides?: Array<{ elements?: Array<{ type?: string; richText?: unknown }>; notes?: unknown }>;
  };
  const out: string[] = [];
  if (deck?.title) out.push(String(deck.title));

  for (const slide of deck?.slides ?? []) {
    for (const el of slide?.elements ?? []) {
      // Text and shapes both carry a body; an image or a line carries none.
      if (el?.richText) out.push(...richTextToLines(el.richText));
    }
    if (slide?.notes) out.push(...richTextToLines(slide.notes));
  }

  return out.join("\n").trim();
}

export function deckSummary(payload: unknown): { slides: number } {
  const deck = payload as { slides?: unknown[] };
  return { slides: (deck?.slides ?? []).length };
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

/**
 * An HTML artefact is a single document, stored as one string.
 *
 * No separate body/css/js fields. An agent writing a page writes a page, and
 * splitting it into three would only mean reassembling it here and guessing at
 * the order.
 */
export function htmlFromInput(title: string, html: string): unknown {
  const body = String(html ?? "").trim();
  return {
    title: title || "Untitled page",
    // A document with no doctype renders in quirks mode, which is a surprising
    // way for someone's careful layout to come out wrong.
    html: body.startsWith("<!") || body.startsWith("<html")
      ? body
      : `<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${body}`,
  };
}

/**
 * The text an HTML page contributes to the brain.
 *
 * Visible text only. Script and style bodies are stripped rather than indexed:
 * they are code, and code embeds as noise that drowns the handful of words the
 * page is actually about. Comments go for the same reason.
 *
 * This is not sanitisation and must never be mistaken for it — the page is
 * served verbatim under a CSP in the mindbox (mindbox.ts). This only
 * decides what the search index sees.
 */
export function htmlSnapshot(payload: unknown): string {
  const raw = String((payload as { html?: unknown })?.html ?? "");

  const titled = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? "";

  const text = raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // Alt text describes what an image shows, so it is worth keeping even
    // though the tag around it is not.
    .replace(/<img[^>]*\balt=["']([^"']*)["'][^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');

  const lines = [titled, text]
    .join("\n")
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Dedupe adjacent repeats: a title that also appears in an <h1> would
  // otherwise be embedded twice and count double.
  const out: string[] = [];
  for (const line of lines) if (line !== out[out.length - 1]) out.push(line);

  return out.join("\n").trim();
}

export function htmlSummary(payload: unknown): { bytes: number; scripted: boolean } {
  const raw = String((payload as { html?: unknown })?.html ?? "");
  return {
    bytes: raw.length,
    // Worth surfacing on the board: a page that runs code is a different thing
    // to open than a page that only draws.
    scripted: /<script[\s>]/i.test(raw),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoredArtefact {
  /**
   * Goes in `nodes.data`: a pointer plus enough to render a collapsed node.
   *
   * The counts differ by kind — a sheet reports cells, a deck reports slides —
   * so this stays open rather than pretending one shape fits all three. The
   * board renders whatever it finds.
   */
  data: { r2: string; kind: ArtefactKind } & Record<string, unknown>;
  /** Goes in `nodes.body`: what FTS and the embeddings read. */
  body: string;
}

/** Build the payload for a kind from the minimal authoring input. */
export function payloadFromInput(
  kind: ArtefactKind,
  title: string,
  input: {
    sheets?: SheetInput[];
    blocks?: Array<DocBlockInput | string>;
    slides?: SlideInput[];
    html?: string;
  },
): unknown {
  if (kind === "doc") return docFromInput(title, input.blocks ?? []);
  if (kind === "deck") return deckFromInput(title, input.slides ?? []);
  if (kind === "html") return htmlFromInput(title, input.html ?? "");
  return sheetFromInput(title, input.sheets ?? []);
}

/** The snapshot and the counts for a kind. One switch, not three call sites. */
function derive(kind: ArtefactKind, payload: unknown): { body: string; counts: Record<string, unknown> } {
  if (kind === "doc") return { body: docSnapshot(payload), counts: docSummary(payload) };
  if (kind === "deck") return { body: deckSnapshot(payload), counts: deckSummary(payload) };
  if (kind === "html") return { body: htmlSnapshot(payload), counts: htmlSummary(payload) };
  return { body: sheetSnapshot(payload), counts: sheetSummary(payload) };
}

/**
 * Validate a payload and work out what the row should hold, without writing
 * anything.
 *
 * Split from `putArtefact` so a create can decide whether it is allowed to
 * exist before a single byte reaches R2.
 */
export function describeArtefact(
  nodeId: string,
  kind: ArtefactKind,
  payload: unknown,
): { json: string; stored: StoredArtefact } {
  const json = JSON.stringify(payload);
  if (json.length > MAX_PAYLOAD_BYTES)
    throw new Error(
      `Artefact is ${Math.round(json.length / 1000)} kB, over the ${MAX_PAYLOAD_BYTES / 1_000_000} MB limit.`,
    );

  const key = artefactKey(nodeId);
  const { body, counts } = derive(kind, payload);
  return { json, stored: { data: { r2: key, kind, ...counts }, body } };
}

/**
 * Write the payload, then return what the row should hold.
 *
 * R2 first, D1 second, and that order is deliberate: a failed D1 write leaves
 * an orphan object that the next save overwrites, where the reverse leaves a
 * row pointing at nothing. That is right for an *existing* node, whose id the
 * caller has already been checked against. A create under a caller-chosen id
 * must not use it: see `POST /api/nodes`, which writes the row first.
 */
export async function putArtefact(
  env: ArtefactEnv,
  nodeId: string,
  kind: ArtefactKind,
  payload: unknown,
): Promise<StoredArtefact> {
  const { json, stored } = describeArtefact(nodeId, kind, payload);
  await env.ARTEFACTS.put(stored.data.r2, json, { httpMetadata: { contentType: "application/json" } });
  return stored;
}

export async function getArtefact(env: ArtefactEnv, nodeId: string): Promise<unknown | null> {
  const obj = await env.ARTEFACTS.get(artefactKey(nodeId));
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

/**
 * Deleting an artefact's object is deliberately not a function here.
 *
 * It used to be, and it is what made undo destructive: the object went the
 * moment the row did, and the restore that followed wrote a blank workbook over
 * the pointer. Deletion now goes through `r2trash.ts`, which files the object
 * and lets the cron reap it once nothing references it.
 */

export { ARTEFACT_SCHEMAS, SHEET_SCHEMA };
