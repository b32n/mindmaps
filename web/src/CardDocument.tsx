import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownDoc } from "./MarkdownDoc";
import { type BoardNode } from "./api";
import { ThreadSection } from "./ThreadSection";

// The collapsed card's preview and progress chip, re-exported from the one
// place that understands markdown. Callers used to import block-shaped versions
// of these from here, so the import site is kept rather than moved.
export { markdownPreview as docToText, markdownProgress as docProgress } from "./MarkdownDoc";

/**
 * Title + document + research thread.
 *
 * Shell-agnostic on purpose: the same component renders anchored to a card on
 * the board and in the full-height focus panel, so the two can't drift apart.
 */
export function CardDocument({
  node,
  onChange,
  onClose,
  onToggleFocus,
  focused,
}: {
  node: BoardNode;
  onChange: (id: string, patch: Partial<BoardNode>) => void;
  onClose: () => void;
  onToggleFocus: () => void;
  focused: boolean;
}) {
  const [title, setTitle] = useState(node.title);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const body = useRef<HTMLDivElement>(null);

  /**
   * Running logs open at the end.
   *
   * Per card rather than per mindmap: it describes what the card *is* — a task
   * list you append to — and one mindmap will hold both those and reference
   * cards you want to read from the top.
   */
  const openAtBottom = node.data?.open_at === "bottom";

  const setOpenAt = (bottom: boolean) =>
    onChange(node.id, { data: { ...(node.data ?? {}), open_at: bottom ? "bottom" : "top" } });

  // Jump to the end once the document has actually laid out. A single frame is
  // not enough — the rendered document reflows after mount, and scrolling
  // before that lands at whatever height it had at the time.
  useEffect(() => {
    if (!openAtBottom) return;
    let frames = 0;
    let raf = 0;
    const settle = () => {
      const el = body.current;
      if (el) el.scrollTop = el.scrollHeight;
      if (frames++ < 12) raf = requestAnimationFrame(settle);
    };
    raf = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(raf);
  }, [node.id, openAtBottom]);

  useEffect(() => setTitle(node.title), [node.id]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /**
   * `body` *is* the document now, so this writes it straight through.
   *
   * Not debounced: the markdown view commits on blur or on a checkbox click,
   * both of which are single deliberate acts rather than a keystroke stream.
   */
  function saveDoc(markdown: string) {
    onChange(node.id, { body: markdown });
  }

  function saveTitle(v: string) {
    setTitle(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(node.id, { title: v }), 400);
  }

  return (
    <>
      <header className="doc-head">
        <input
          className="doc-title"
          value={title}
          placeholder="Untitled"
          onChange={(e) => saveTitle(e.target.value)}
        />
        <button
          className={`doc-btn ${openAtBottom ? "on" : ""}`}
          onClick={() => setOpenAt(!openAtBottom)}
          aria-pressed={openAtBottom}
          title={
            openAtBottom
              ? "Opens at the bottom. Click to open at the top."
              : "Open this card at the bottom (for running logs)"
          }
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"
            fill="none" stroke="currentColor" strokeWidth="1.7"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2.5v9" /><path d="M4.5 8 8 11.5 11.5 8" /><path d="M3.5 14h9" />
          </svg>
        </button>
        <button
          className="doc-btn"
          onClick={onToggleFocus}
          title={focused ? "Back to the board" : "Focus mode"}
        >
          {focused ? "⤡" : "⤢"}
        </button>
        <button className="doc-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <div className="doc-body" ref={body}>
        <MarkdownDoc value={node.body ?? ""} onChange={saveDoc} />
      </div>

      <ThreadSection node={node} />
    </>
  );
}
