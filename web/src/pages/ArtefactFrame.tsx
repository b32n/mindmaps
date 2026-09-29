/**
 * The chrome around an artefact editor: back, title, save state.
 *
 * Identical for all three kinds, so it is one component rather than three
 * copies that drift. The editor itself goes in `children` and is handed the
 * measured size, because every Spindle editor sizes in pixels rather than CSS
 * and needs numbers to fill the window.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

export function ArtefactFrame({
  title,
  onTitle,
  state,
  placeholder,
  error,
  loading,
  dirty,
  onLeave,
  actions,
  children,
}: {
  title: string;
  onTitle: (t: string) => void;
  state: string;
  placeholder: string;
  error: string | null;
  loading: boolean;
  dirty: boolean;
  /** Write any pending change before the route changes. */
  onLeave: () => void;
  /** Controls specific to one kind, placed before the save state. */
  actions?: ReactNode;
  children: (size: { w: number; h: number }) => ReactNode;
}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  /**
   * Every Spindle editor takes `width`/`height` numbers, not CSS, so filling
   * the window means measuring what is left and re-measuring when it changes.
   * A ResizeObserver rather than a window listener, because the header wraps at
   * narrow widths and the editor has to follow.
   */
  const frame = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, error]);

  const back = () => {
    if (dirty) onLeave();
    const board = params.get("from");
    navigate(board ? `/app/${board}` : "/app");
  };

  return (
    <div className="sheet-page">
      <header className="sheet-head">
        <button className="sheet-back" onClick={back}>
          &larr; Back
        </button>
        {error || loading ? (
          <span className="sheet-title">{title || placeholder}</span>
        ) : (
          <input
            className="sheet-title"
            value={title}
            placeholder={placeholder}
            onChange={(e) => onTitle(e.target.value)}
          />
        )}
        {!error && !loading && actions}
        {!error && !loading && (
          <span className={`sheet-state${state === "Saving…" ? " busy" : ""}`}>{state}</span>
        )}
      </header>

      {error ? (
        <p className="sheet-msg sheet-err">{error}</p>
      ) : loading ? (
        <p className="sheet-msg">Opening…</p>
      ) : (
        <div className="sheet-grid" ref={frame}>
          {size.w > 0 && children(size)}
        </div>
      )}
    </div>
  );
}
