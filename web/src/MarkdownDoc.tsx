/**
 * A card's document: WYSIWYG editing over markdown.
 *
 * Milkdown's Crepe editor, which parses markdown in and serialises markdown
 * out. That is the whole reason it is here rather than BlockNote: the problem
 * with BlockNote was never the editing, it was that every document was stored
 * twice — block JSON in `nodes.doc` and a markdown projection in `nodes.body` —
 * and the two could disagree. They did: cards written in the browser held a
 * plain-text `body` clipped to 500 characters, so they searched and recalled on
 * their opening paragraph only.
 *
 * Here `body` is the document. Nothing derives it, nothing can drift from it,
 * and what an agent writes over MCP is what you see.
 *
 * Crepe brings the editing affordances back: slash menu, drag handles to
 * reorder blocks, a table editor, code blocks with a language picker, and live
 * checkboxes. All of it serialises to markdown.
 */

import { useEffect, useRef } from "react";
// `CrepeBuilder` plus explicit features, never the `Crepe` default export.
// That entry point statically imports every feature, so turning them off in
// config changes nothing about what ships: with the default import the bundle
// was 2,187 kB across 174 chunks, because Latex pulls KaTeX and the code block
// pulls CodeMirror's entire legacy language set.
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { table } from "@milkdown/crepe/feature/table";
import { imageBlock } from "@milkdown/crepe/feature/image-block";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { listener } from "@milkdown/kit/plugin/listener";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
// Per-feature CSS, not `theme/common/style.css`. That file is an aggregate
// that imports every feature's styles including latex.css, which pulls KaTeX's
// font files into the build for a feature that is not enabled.
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/image-block.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/frame.css";
import { api } from "./api";

/**
 * Checklist progress, for the collapsed card's chip.
 *
 * Read from the markdown rather than the editor, because the chip is shown on
 * cards that are closed and have no editor mounted. Fenced code is skipped so a
 * `- [ ]` inside a code block is not counted as a task.
 */
export function markdownProgress(md: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  let fenced = false;
  for (const line of String(md ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^\s*[-*+]\s+\[([ xX])\]/.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1] !== " ") done += 1;
  }
  return { done, total };
}

/** Plain text for the collapsed preview: markdown syntax stripped, not shown. */
export function markdownPreview(md: string, limit = 160): string {
  return String(md ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function MarkdownDoc({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const crepe = useRef<CrepeBuilder | null>(null);

  // The latest callback, read at call time. Without this the editor would have
  // to be torn down and rebuilt whenever the parent re-rendered, losing the
  // caret on every keystroke.
  const save = useRef(onChange);
  save.current = onChange;

  // `value` seeds the editor once. It is deliberately not a dependency: the
  // editor owns the document while it is mounted, and re-seeding from a prop
  // that this component itself just changed would fight the caret.
  const seed = useRef(value);

  useEffect(() => {
    const root = host.current;
    if (!root) return;

    let disposed = false;
    const editor = new CrepeBuilder({ root, defaultValue: seed.current })
      // Slash menu and the drag handle: the two affordances that make this feel
      // like a block editor rather than a text box.
      .addFeature(blockEdit)
      .addFeature(toolbar)
      .addFeature(table)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(cursor)
      .addFeature(placeholder, { text: "Write, or press / for blocks" })
      // R2 upload, the same endpoint the rest of the app posts images to.
      .addFeature(imageBlock, {
        onUpload: (file: File) => api.uploadImage(file),
        inlineOnUpload: (file: File) => api.uploadImage(file),
      });

    editor.editor
      .config((ctx) => {
        // Match what the worker's own serialiser writes, so a card does not
        // churn every time it changes hands. remark defaults to `*` for bullets
        // and `_` for emphasis; agents write `-` and `**`, and without this a
        // human opening a card rewrites every marker, then the next agent write
        // flips them back.
        ctx.set(remarkStringifyOptionsCtx, {
          bullet: "-",
          emphasis: "*",
          strong: "*",
          fence: "`",
          fences: true,
          rule: "-",
        });
      })
      .use(listener);
    editor.on((l) => {
      l.markdownUpdated((_ctx, markdown, prev) => {
        // Fires once on load with prev undefined; saving then would rewrite
        // every card with Crepe's normalisation the moment it was opened.
        if (prev === undefined || markdown === prev) return;
        save.current(markdown);
      });
    });

    crepe.current = editor;
    void editor.create().catch(() => {
      // A failed editor must not take the card with it. The document is still
      // in `body` and still readable everywhere else.
    });

    return () => {
      disposed = true;
      void crepe.current?.destroy();
      crepe.current = null;
      void disposed;
    };
  }, []);

  return <div className="md-doc nodrag nowheel" ref={host} />;
}
