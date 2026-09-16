import { useEffect, useRef, useState } from "react";
import type { InkTool } from "./InkLayer";
import {
  IconCard, IconCursor, IconEraser, IconNote, IconPen, IconRedo, IconUndo,
} from "./ui/Icons";

const SWATCHES = ["#0d1513", "#0f7a57", "#17548f", "#b3261e", "#8a5a13", "#7b3fa0"];
const SIZES = [2, 4, 8, 14];

interface Props {
  tool: InkTool;
  setTool: (t: InkTool) => void;
  color: string;
  setColor: (c: string) => void;
  size: number;
  setSize: (n: number) => void;
  onAddCard: () => void;
  onAddNote: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Floating tool dock, bottom-centre.
 *
 * Lives over the canvas rather than in a header strip so the board keeps the
 * full window, and the tools sit near where the cursor already is. Pen options
 * appear in a popover only while a drawing tool is active — no permanent colour
 * picker eating space for the 90% of the time you're not drawing.
 */
export function Toolbar(p: Props) {
  const [pop, setPop] = useState(false);
  const dock = useRef<HTMLDivElement>(null);

  const inking = p.tool !== "select";
  useEffect(() => {
    if (!inking) setPop(false);
  }, [inking]);

  // dismiss the popover on an outside click
  useEffect(() => {
    if (!pop) return;
    const away = (e: PointerEvent) => {
      if (!dock.current?.contains(e.target as Node)) setPop(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [pop]);

  // single-key shortcuts, the way every canvas tool does it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el?.closest?.("input, textarea, [contenteditable=true], .card-doc")) return;
      const k = e.key.toLowerCase();
      if (k === "v") p.setTool("select");
      else if (k === "p") p.setTool("pen");
      else if (k === "e") p.setTool("eraser");
      else if (k === "c") p.onAddCard();
      else if (k === "n") p.onAddNote();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const Tool = ({
    id,
    label,
    hint,
    children,
  }: {
    id: InkTool;
    label: string;
    hint: string;
    children: React.ReactNode;
  }) => (
    <button
      className={`dock-btn ${p.tool === id ? "on" : ""}`}
      onClick={() => {
        if (p.tool === id && id !== "select") setPop((v) => !v);
        else p.setTool(id);
        if (id !== "select") setPop(true);
      }}
      data-tip={`${label} · ${hint}`}
      aria-label={label}
      aria-pressed={p.tool === id}
    >
      {children}
    </button>
  );

  return (
    <div className={`dock-wrap ${pop && inking ? "has-pop" : ""}`}>
      {pop && inking && (
        <div className="dock-pop">
          <div className="swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                className={`swatch ${p.color === c ? "on" : ""}`}
                style={{ background: c }}
                onClick={() => p.setColor(c)}
                aria-label={`Colour ${c}`}
              />
            ))}
            <label className="swatch custom" aria-label="Custom colour">
              <input
                type="color"
                value={p.color}
                onChange={(e) => p.setColor(e.target.value)}
              />
            </label>
          </div>
          <div className="sizes">
            {SIZES.map((s) => (
              <button
                key={s}
                className={`size ${p.size === s ? "on" : ""}`}
                onClick={() => p.setSize(s)}
                aria-label={`Size ${s}`}
              >
                <span style={{ width: s + 2, height: s + 2, background: p.color }} />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="dock" ref={dock}>
        <Tool id="select" label="Select" hint="V">
          <IconCursor />
        </Tool>
        <Tool id="pen" label="Pen" hint="P">
          <IconPen />
        </Tool>
        <Tool id="eraser" label="Eraser" hint="E">
          <IconEraser />
        </Tool>

        <span className="dock-sep" />

        <button className="dock-btn" onClick={p.onAddCard} data-tip="Card · C" aria-label="Add card">
          <IconCard />
        </button>
        <button className="dock-btn" onClick={p.onAddNote} data-tip="Note · N" aria-label="Add note">
          <IconNote />
        </button>

        <span className="dock-sep" />

        <button
          className="dock-btn"
          onClick={p.onUndo}
          disabled={!p.canUndo}
          data-tip="Undo · ⌘Z"
          aria-label="Undo"
        >
          <IconUndo />
        </button>
        <button
          className="dock-btn"
          onClick={p.onRedo}
          disabled={!p.canRedo}
          data-tip="Redo · ⌘⇧Z"
          aria-label="Redo"
        >
          <IconRedo />
        </button>
      </div>
    </div>
  );
}
