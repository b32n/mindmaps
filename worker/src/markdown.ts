/**
 * Markdown ⇄ BlockNote blocks.
 *
 * The reasoning is in MCP.md §4 and §5, but the short version:
 *
 *   - Agents write **markdown**, because every model already knows it. Handing
 *     them BlockNote's block JSON would mean teaching a bespoke schema no model
 *     has seen, in every session, forever.
 *   - We store **blocks**, because that is what the editor reads and it is
 *     lossless for things markdown can't say (colour, alignment, image width).
 *   - We also keep a **markdown projection** in `nodes.body`, regenerated on
 *     every write, because search and `get_mindmap` both want text and neither
 *     can do anything useful with `content[].styles`.
 *
 * So an agent's markdown is normalised rather than preserved byte-for-byte.
 * That's the intended trade: agent-written and human-written cards converge on
 * one representation instead of drifting into two.
 *
 * This is a deliberately small subset — the blocks BlockNote actually renders.
 * Anything unrecognised degrades to a paragraph, which is the failure mode we
 * want: slightly-wrong text, never a blank card.
 */

export interface InlineText {
  type: "text";
  text: string;
  styles: Record<string, boolean | string>;
}
export interface InlineLink {
  type: "link";
  href: string;
  content: InlineText[];
}
export type Inline = InlineText | InlineLink;

/**
 * BlockNote's table shape, verified against the running editor rather than
 * assumed. Cells may be bare inline arrays or full `tableCell` objects; the
 * editor accepts both and normalises, but we write the explicit form because
 * that is what it writes back after a human edit.
 */
export interface TableCell {
  type: "tableCell";
  props: Record<string, unknown>;
  content: Inline[];
}
export interface TableContent {
  type: "tableContent";
  columnWidths?: (number | null)[];
  headerRows?: number;
  rows: { cells: (Inline[] | TableCell)[] }[];
}

export interface Block {
  type: string;
  props?: Record<string, unknown>;
  content?: Inline[] | TableContent;
  children?: Block[];
}

/** Narrow a block's content to inline runs; tables carry an object instead. */
const inlineOf = (c: Block["content"]): Inline[] | undefined =>
  Array.isArray(c) ? c : undefined;

const tableOf = (c: Block["content"]): TableContent | undefined =>
  !Array.isArray(c) && c?.type === "tableContent" ? c : undefined;

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const text = (t: string, styles: Record<string, boolean> = {}): InlineText => ({
  type: "text",
  text: t,
  styles,
});

/**
 * Inline markdown → BlockNote inline content.
 *
 * One pass, longest-marker-first so `**bold**` is not mistaken for two
 * `*italic*` runs. Nesting (`**bold _and_ italic**`) is not supported: it would
 * need a real parser, and agents writing findings into a card overwhelmingly
 * emit flat runs. Unmatched markers stay as literal characters.
 */
/** Longest markers first, so `**bold**` never reads as two `*italic*` runs. */
const MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["**", "bold"],
  ["__", "bold"],
  ["~~", "strike"],
  ["*", "italic"],
  ["_", "italic"],
];

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) out.push(text(buf));
    buf = "";
  };
  /** consume `n` characters as a styled run */
  const emit = (node: Inline, n: number) => {
    flush();
    out.push(node);
    i += n;
  };

  outer: while (i < src.length) {
    // escape
    if (src[i] === "\\" && i + 1 < src.length) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    // `code` first — its contents are literal, so markers inside must survive
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        emit(text(src.slice(i + 1, end), { code: true }), end - i + 1);
        continue;
      }
    }

    // [label](href). A leading ! (inline image) is handled at block level; here
    // it degrades to a link, which is better than losing the URL.
    if (src[i] === "[") {
      const close = src.indexOf("](", i);
      if (close > i) {
        const end = src.indexOf(")", close + 2);
        if (end > close) {
          const label = src.slice(i + 1, close);
          const href = src.slice(close + 2, end).trim();
          if (href) {
            emit({ type: "link", href, content: [text(label || href)] }, end - i + 1);
            continue;
          }
        }
      }
    }

    for (const [marker, style] of MARKERS) {
      if (!src.startsWith(marker, i)) continue;
      const end = src.indexOf(marker, i + marker.length);
      if (end > i + marker.length) {
        emit(text(src.slice(i + marker.length, end), { [style]: true }), end + marker.length - i);
        continue outer;
      }
      // unmatched: fall through and take it literally rather than swallow it
    }

    buf += src[i];
    i += 1;
  }

  flush();
  return out.length ? out : [text("")];
}

const inlineToMarkdown = (content: Inline[] | undefined): string =>
  (content ?? [])
    .map((n) => {
      if (n.type === "link") return `[${inlineToMarkdown(n.content)}](${n.href})`;
      let t = n.text ?? "";
      const s = n.styles ?? {};
      if (s.code) return "`" + t + "`";
      if (s.bold) t = `**${t}**`;
      if (s.italic) t = `*${t}*`;
      if (s.strike) t = `~~${t}~~`;
      return t;
    })
    .join("");

// ---------------------------------------------------------------------------
// Markdown → blocks
// ---------------------------------------------------------------------------

const BULLET = /^[-*+]\s+(.*)$/;
const CHECK = /^[-*+]\s+\[([ xX])\]\s*(.*)$/;
const NUMBER = /^(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
/** A GFM table row: at least one pipe, and not a horizontal rule. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** The `|---|:--:|` separator that turns two rows into a table. */
const TABLE_SEP = /^\s*\|(\s*:?-{1,}:?\s*\|)+\s*$/;

/** Split `| a | b |` into cells, honouring `\|` escapes inside a cell. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let buf = "";
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      buf += "|";
      i += 1;
      continue;
    }
    if (body[i] === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += body[i];
  }
  cells.push(buf.trim());
  return cells;
}

const tableCell = (text: string): TableCell => ({
  type: "tableCell",
  props: {
    backgroundColor: "default",
    textColor: "default",
    textAlignment: "left",
    colspan: 1,
    rowspan: 1,
  },
  content: parseInline(text),
});

export function markdownToBlocks(md: string): Block[] {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // fenced code — everything inside is literal, including markdown markers
    const fence = /^```(\w*)\s*$/.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push({
        type: "codeBlock",
        props: fence[1] ? { language: fence[1] } : {},
        content: [text(body.join("\n"))],
      });
      continue;
    }

    if (RULE.test(line.trim())) {
      // BlockNote has no divider in the default schema; an empty paragraph is
      // closer to the author's intent than a literal "---"
      blocks.push({ type: "paragraph", content: [text("")] });
      i += 1;
      continue;
    }

    // Tables, before the paragraph fallback. Without this a table collapsed
    // into one run-on paragraph of literal pipes — which is exactly what the
    // tool schema promised would work.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      const width = header.length;
      const rows = [{ cells: header.map(tableCell) }];
      i += 2; // header + separator
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        const cells = splitRow(lines[i]);
        // Ragged rows are common in hand-written markdown; pad or trim to the
        // header width so the table stays rectangular and renders.
        while (cells.length < width) cells.push("");
        rows.push({ cells: cells.slice(0, width).map(tableCell) });
        i += 1;
      }
      blocks.push({
        type: "table",
        props: { textColor: "default" },
        content: {
          type: "tableContent",
          columnWidths: Array(width).fill(null),
          headerRows: 1,
          rows,
        },
      });
      continue;
    }

    const image = IMAGE.exec(line.trim());
    if (image) {
      blocks.push({ type: "image", props: { url: image[2].trim(), caption: image[1] ?? "" } });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // BlockNote's default schema has three heading levels; deeper markdown
      // headings clamp rather than disappear
      blocks.push({
        type: "heading",
        props: { level: Math.min(heading[1].length, 3) },
        content: parseInline(heading[2]),
      });
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body: string[] = [quote[1]];
      i += 1;
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])![1]);
        i += 1;
      }
      blocks.push({ type: "quote", content: parseInline(body.join(" ").trim()) });
      continue;
    }

    // checklist before bullet: "- [ ] x" also matches the bullet pattern
    const check = CHECK.exec(line.trimStart());
    if (check) {
      blocks.push({
        type: "checkListItem",
        props: { checked: check[1].toLowerCase() === "x" },
        content: parseInline(check[2]),
      });
      i += 1;
      continue;
    }

    const bullet = BULLET.exec(line.trimStart());
    if (bullet) {
      blocks.push({ type: "bulletListItem", content: parseInline(bullet[1]) });
      i += 1;
      continue;
    }

    const numbered = NUMBER.exec(line.trimStart());
    if (numbered) {
      blocks.push({ type: "numberedListItem", content: parseInline(numbered[2]) });
      i += 1;
      continue;
    }

    // paragraph: consecutive plain lines join into one block, the way markdown
    // treats a soft wrap
    const para: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: "paragraph", content: parseInline(para.join(" ")) });
  }

  return blocks.length ? blocks : [{ type: "paragraph", content: [text("")] }];
}

const isBlockStart = (line: string) => {
  const t = line.trimStart();
  return (
    HEADING.test(t) ||
    QUOTE.test(t) ||
    BULLET.test(t) ||
    NUMBER.test(t) ||
    RULE.test(t.trim()) ||
    // a table row ends the paragraph before it, rather than being absorbed
    TABLE_ROW.test(t) ||
    /^```/.test(t)
  );
};

// ---------------------------------------------------------------------------
// Blocks → markdown
// ---------------------------------------------------------------------------

/**
 * The projection stored in `nodes.body` and handed to agents by `get_mindmap`.
 * Recurses into `children`, which BlockNote uses for nested lists.
 */
const LIST_TYPES = new Set(["bulletListItem", "numberedListItem", "checkListItem"]);

export function blocksToMarkdown(blocks: Block[] | undefined, depth = 0): string {
  if (!Array.isArray(blocks)) return "";
  const pad = "  ".repeat(depth);
  const out: string[] = [];
  let previous = "";
  // Repeated "1." is valid markdown, but it reads as a mistake in a context
  // window and in the card preview. Number the run properly.
  let ordinal = 0;

  for (const b of blocks) {
    // tables carry an object, not inline runs; they render below
    const inner = inlineToMarkdown(inlineOf(b.content));
    ordinal = b.type === "numberedListItem" ? ordinal + 1 : 0;
    // A block-level change needs a blank line between it and what came before,
    // or a paragraph following a list reads as part of the list.
    if (previous && previous !== b.type && !(LIST_TYPES.has(previous) && LIST_TYPES.has(b.type)))
      out.push("");
    previous = b.type;
    switch (b.type) {
      case "heading":
        out.push(`${"#".repeat(Number(b.props?.level ?? 1))} ${inner}`);
        break;
      case "bulletListItem":
        out.push(`${pad}- ${inner}`);
        break;
      case "numberedListItem":
        out.push(`${pad}${ordinal}. ${inner}`);
        break;
      case "checkListItem":
        out.push(`${pad}- [${b.props?.checked ? "x" : " "}] ${inner}`);
        break;
      case "quote":
        out.push(`> ${inner}`);
        break;
      case "codeBlock":
        out.push("```" + String(b.props?.language ?? ""), inner, "```");
        break;
      case "image": {
        const url = String(b.props?.url ?? "");
        if (url) out.push(`![${String(b.props?.caption ?? "")}](${url})`);
        break;
      }
      case "table":
        out.push(tableToMarkdown(b));
        break;
      default:
        if (inner) out.push(inner);
    }
    if (b.children?.length) out.push(blocksToMarkdown(b.children, depth + 1));
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tableToMarkdown(b: Block): string {
  const rows = tableOf(b.content)?.rows ?? [];
  if (!rows.length) return "";
  // A cell is either a bare inline array or a `tableCell` wrapper.
  const cellText = (c: Inline[] | TableCell) =>
    inlineToMarkdown(Array.isArray(c) ? c : c?.content).replace(/\|/g, "\\|");
  const render = (row: { cells: (Inline[] | TableCell)[] }) =>
    `| ${(row.cells ?? []).map(cellText).join(" | ")} |`;
  const width = rows[0].cells?.length ?? 0;
  if (!width) return "";
  return [
    render(rows[0]),
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...rows.slice(1).map(render),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// What the write path actually calls
// ---------------------------------------------------------------------------

/**
 * Accept whatever an agent sent for a card's prose and return both
 * representations. `content` is a union — markdown string, or `{blocks:[…]}`
 * for the rare thing markdown can't express (MCP.md §4).
 */
export function normaliseContent(content: unknown): { doc: string; body: string } {
  let blocks: Block[];
  if (typeof content === "string") blocks = markdownToBlocks(content);
  else if (content && typeof content === "object" && Array.isArray((content as any).blocks))
    blocks = (content as any).blocks as Block[];
  else if (Array.isArray(content)) blocks = content as Block[];
  else blocks = markdownToBlocks("");

  return { doc: JSON.stringify(blocks), body: blocksToMarkdown(blocks) };
}

/** Parse a stored doc column defensively — a bad row must not fail a read. */
export function parseDoc(doc: string | null | undefined): Block[] {
  if (!doc) return [];
  try {
    const parsed = JSON.parse(doc);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Checklist progress, for `get_mindmap` — the same derivation the UI does. */
export function progressOf(blocks: Block[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.type === "checkListItem") {
        total += 1;
        if (b.props?.checked) done += 1;
      }
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return { done, total };
}
