/**
 * The full artefact shape, returned on demand by `get_artefact_schema`.
 *
 * Kept out of the tool descriptions on purpose. Every tool schema is context
 * tax on every session (MCP.md §6), and this is several hundred lines of
 * TypeScript that almost no call needs: `create_artefact` takes rows, and the
 * server fills in the rest. An agent only needs this when it wants styles,
 * frozen panes, number formats or filters.
 *
 * Mirrors Spindle's `documentation/sheets/data-structures.md`. If that moves,
 * this goes stale silently, which is the cost of restating it rather than
 * importing it — the alternative is pulling a UI package into the Worker for
 * its types alone.
 */

export const SHEET_SCHEMA = `# Sheet artefact

Two ways to write one.

## 1. Rows (what you usually want)

\`create_artefact\` and \`update_artefact\` accept this directly. Everything
else is filled in for you: ids, sparse cell keys, a bold header row, a frozen
first row, grid size.

\`\`\`json
{
  "type": "sheet",
  "mindmap_id": "<board id>",
  "title": "Migration cost model",
  "sheets": [
    {
      "name": "Q3",
      "rows": [
        ["Service", "Monthly cost", "Notes"],
        ["bank-platform", 1200, "excludes egress"],
        ["access", 480, "reserved instances"],
        ["Total", "=SUM(B2:B3)", ""]
      ]
    }
  ]
}
\`\`\`

A cell is a string, number, boolean, or null. A string starting with \`=\` is
kept as a formula and evaluated when the sheet is opened. Empty strings and
nulls are not stored, so a mostly-blank grid costs nothing.

## 2. A full payload

Pass \`data\` instead of \`sheets\` to control everything. This is Spindle's
\`WorkbookData\`:

\`\`\`typescript
interface WorkbookData {
  id: string;
  name: string;
  activeSheetId: string;
  defaultRowHeight: number;          // 24
  defaultColWidth: number;           // 110
  stylePool: Record<string, CellStyle>;    // styleId -> style
  formatPool?: Record<string, CellFormat>; // formatId -> number format
  sheets: SheetData[];
}

interface SheetData {
  id: string;
  name: string;
  cells: Array<{ key: string; cell: Cell }>;   // key is "row:col", 0-based
  config: {
    defaultRowHeight?: number;
    defaultColWidth?: number;
    rowHeights?: Array<[number, number]>;      // [row, height]
    colWidths?: Array<[number, number]>;       // [col, width]
    hiddenRows?: number[];
    hiddenCols?: number[];
    frozenRows?: number;
    frozenCols?: number;
    showGridLines?: boolean;
  };
  rowCount: number;
  colCount: number;
}

interface Cell {
  value: string | number | boolean | null;
  formula?: string;      // raw text, e.g. "=A1+B1". value is computed on open.
  styleId?: string;      // into stylePool
  formatId?: string;     // into formatPool
  comment?: string;
  hyperlink?: string;
}

interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  fontFamily?: string;
  fontSize?: number;
  fontColor?: string;
  backgroundColor?: string;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  borderTop?: string;    // CSS shorthand, e.g. "1px solid #000"
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
  textWrap?: boolean;
  textDecoration?: 'none' | 'underline' | 'line-through';
}
\`\`\`

## What gets indexed

The text in a sheet becomes a snapshot that \`recall\` and \`search\` read:
sheet names, then each row's non-empty cells left to right, formulas as their
text. Numbers are included but carry little retrieval signal, so **label your
columns and rows** if you want the sheet to be findable later. A sheet of bare
figures is nearly invisible to search.`;


export const DOC_SCHEMA = `# Document artefact

## 1. Blocks (what you usually want)

\`create_artefact\` and \`update_artefact\` accept this directly. Ids, the page
setup and the style pools are filled in for you.

\`\`\`json
{
  "type": "doc",
  "mindmap_id": "<board id>",
  "title": "Migration plan",
  "blocks": [
    { "heading": "Why now", "level": 2 },
    { "text": "The current cluster loses a node roughly once a fortnight." },
    { "bullet": "Move reads first, they are idempotent" },
    { "bullet": "Writes follow once replication lag is under a second" },
    { "number": "Cut over one service" },
    { "number": "Watch for a week" },
    { "rule": true },
    "A bare string is a paragraph, for when that is all you meant."
  ]
}
\`\`\`

One block per entry, and exactly one of these keys:

- \`heading\` with an optional \`level\` 1-6 (default 2)
- \`text\` for a paragraph
- \`bullet\` or \`number\` for a list item
- \`rule\` for a horizontal rule

The document's own title comes from \`title\`, so a level-1 heading that
repeats it is usually noise.

## 2. A full payload

Pass \`data\` instead of \`blocks\` to control everything. This is Spindle's
\`DocumentData\`:

\`\`\`typescript
interface DocumentData {
  id: string;
  title: string;
  sections: SectionData[];          // one section unless you are laying out
  defaultPageConfig: PageConfig;
  textStylePool: Record<string, TextStyle>;
  paragraphStylePool: Record<string, ParagraphStyle>;
}

interface SectionData {
  id: string;
  pageConfig: PageConfig;           // { size:{w,h}, margins:{...}, orientation }
  blocks: Block[];
}

// Block is one of:
//   { id, type:'paragraph',      content: InlineContent[] }
//   { id, type:'heading',        level: 1-6, content: InlineContent[] }
//   { id, type:'list-item',      listType:'bullet'|'numbered', level: number,
//                                content: InlineContent[] }
//   { id, type:'table',          rows: TableRow[], colWidths?: number[] }
//   { id, type:'image',          src, width, height, alt? }
//   { id, type:'horizontal-rule' }
//   { id, type:'page-break' }

// InlineContent is one of:
//   { type:'text', text, bold?, italic?, underline?, color?, fontSize?, ... }
//   { type:'link', text, href }
//   { type:'image', src, width, height, alt? }
\`\`\`

## What gets indexed

Every block's text, in order, plus table cells row by row. Images contribute
their \`alt\` and nothing else, because a \`src\` is a URL and URLs embed as
noise.`;

export const DECK_SCHEMA = `# Deck artefact

## 1. Slides (what you usually want)

\`\`\`json
{
  "type": "deck",
  "mindmap_id": "<board id>",
  "title": "Q3 review",
  "slides": [
    {
      "title": "Where we landed",
      "bullets": ["Revenue up 12%", "Churn flat", "Two incidents, both DNS"],
      "notes": "Lead with churn. The revenue number is not the story."
    },
    { "title": "What we are changing", "bullets": ["Move auth off the shared pool"] }
  ]
}
\`\`\`

Each slide gets a title band and a bulleted body laid out on a 1280x720 stage.
That is a starting point someone can drag, not a layout engine. \`notes\` are
speaker notes and they are indexed, so the argument you write there stays
findable.

## 2. A full payload

Pass \`data\` instead of \`slides\`. This is Spindle's \`DeckData\`, and it is
tolerant: ids, z-order indices, the theme and the slide size are all filled in
on load, so you only supply what you care about.

\`\`\`typescript
interface DeckData {
  id: string;
  title: string;
  slideSize: { w: number; h: number };    // defaults to 1280x720
  theme: ThemeData;                       // defaults to the built-in theme
  slides: SlideData[];
}

interface SlideData {
  id: string;
  index: string;                          // fractional order key, generated
  background?: Fill;
  notes?: RichTextDoc;
  elements: SlideElement[];
}

// An element is text | shape | image | line | table, each with a frame:
//   { type:'text', x, y, w, h, rotation, richText: RichTextDoc,
//     bodyStyle?: { fontSize?, bold?, color?, vAlign?, fontFamily? } }
//   { type:'image', x, y, w, h, rotation, src, naturalW, naturalH }
//   { type:'shape', x, y, w, h, rotation, shape:'rect'|'ellipse'|..., fill, richText? }

interface RichTextDoc {
  type: 'doc';
  content: Array<{
    type: 'paragraph';
    attrs?: { align?, listType?: 'none'|'bullet'|'number', indent?: number };
    content?: Array<{ type: 'text'; text: string; marks?: Array<{ type: string }> }>;
  }>;
}
\`\`\`

## What gets indexed

Slide by slide in presentation order: the text of every element that carries a
body, then the speaker notes. A deck of images and no words is nearly invisible
to search, so put the point in the text.`;

/**
 * The schema for each kind, looked up by `get_artefact_schema`.
 *
 * A map rather than three exported constants, so the tool cannot be asked for a
 * kind that has no schema and quietly return the wrong one.
 */
export const HTML_SCHEMA = `# HTML artefact

One field: a complete HTML document.

\`\`\`json
{
  "type": "html",
  "mindmap_id": "<board id>",
  "title": "Burn rate",
  "html": "<!doctype html><meta charset=\\"utf-8\\"><h1>Burn rate</h1><canvas id=c width=600 height=300></canvas><script>/* ... */</script>"
}
\`\`\`

A \`<!doctype html>\` is added for you if you leave it off, along with a charset
and a viewport meta.

## The mindbox, which you must design around

The page runs on a **separate origin** inside an iframe with
\`sandbox="allow-scripts"\` and no \`allow-same-origin\`, under this policy:

    default-src 'none'
    script-src  'unsafe-inline' blob:
    style-src   'unsafe-inline'
    img-src     data: blob:
    font-src    data:
    connect-src 'none'
    form-action 'none'

What that means in practice:

- **No network, at all.** \`fetch\`, \`XMLHttpRequest\`, \`WebSocket\` and
  \`navigator.sendBeacon\` are blocked. Anything the page needs must be in the
  page.
- **No external resources.** No \`<script src="https://cdn...">\`, no
  stylesheet links, no remote fonts, no remote images. Inline the code, inline
  the CSS, and embed images as \`data:\` URIs.
- **No \`eval\`** or \`new Function\`. Write the code out.
- **No access to the app.** The page cannot read the user's cards, cannot call
  the API, and cannot see other artefacts. This is deliberate and is not going
  to be relaxed by asking.

Within that, ordinary HTML, CSS, SVG, \`<canvas>\` and plain JavaScript all work,
which is enough for a chart, a diagram, a calculator, a simulation or a small
interactive tool.

## What gets indexed

Visible text, plus the \`<title>\` and image \`alt\` text. Script and style
bodies are stripped, because code embeds as noise and drowns the few words the
page is about. A page that draws everything in canvas and writes nothing in the
markup is nearly invisible to search, so put a heading and a sentence of prose
in the document.`;

export const ARTEFACT_SCHEMAS: Record<string, string> = {
  sheet: SHEET_SCHEMA,
  doc: DOC_SCHEMA,
  deck: DECK_SCHEMA,
  html: HTML_SCHEMA,
};
