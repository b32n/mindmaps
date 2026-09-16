import { useEffect, useRef, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type EdgeProps,
} from "@xyflow/react";

/**
 * Labels are drawn inside the canvas transform, so by default they shrink and
 * grow with the board — illegible and unclickable when zoomed out, comically
 * large when zoomed in. Counter-scaling by 1/zoom pins them to a constant
 * screen size, the way a map keeps its labels readable at every altitude.
 *
 * Clamped rather than exact: at deep zoom-out an exactly-constant label would
 * dwarf the cards it sits between and obscure the map. This keeps it readable
 * without letting it take over.
 */
const MIN_SCALE = 0.75;
const MAX_SCALE = 2.4;

export interface EdgeCallbacks {
  onLabel: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  /** swap the attachment sides between horizontal and vertical */
  onFlip: (id: string) => void;
}

/**
 * A connection with an editable label and its own small toolbar.
 *
 * The label lives in EdgeLabelRenderer, which draws HTML inside the canvas
 * transform — so it pans and zooms with the board but is a real input you can
 * type into, rather than SVG text.
 *
 * The controls appear on **hover**, not on selection. They used to require the
 * edge to be selected first, and selecting an edge by clicking it did not
 * work — the label is portalled outside the SVG, so clicks on it never reached
 * React Flow's edge handler, and the result was a delete button nobody could
 * ever get to. Hover has no such dependency and is one gesture instead of two.
 */
export function LabelledEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  selected,
  data,
  markerEnd,
  style,
}: EdgeProps) {
  const { onLabel, onDelete, onFlip } = data as unknown as EdgeCallbacks;
  const [editing, setEditing] = useState(false);
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(String(label ?? ""));
  const input = useRef<HTMLInputElement>(null);

  // Subscribing to just the zoom scalar keeps this re-rendering only when the
  // zoom actually changes, not on every pan.
  const zoom = useStore((s) => s.transform[2]);
  const counter = Math.min(MAX_SCALE, Math.max(MIN_SCALE, 1 / (zoom || 1)));

  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  useEffect(() => setDraft(String(label ?? "")), [label]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== String(label ?? "")) onLabel(id, draft.trim());
  };

  const open = hover || selected || editing;

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />

      {/* a wider invisible path, so the thin line is actually clickable */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        className="edge-hit"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      />

      <EdgeLabelRenderer>
        <div
          className={`edge-label ${open ? "open" : ""} ${selected ? "selected" : ""} ${
            label ? "" : "empty"
          }`}
          style={{
            transform:
              `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${counter})`,
          }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {editing ? (
            <input
              ref={input}
              className="nodrag nopan"
              value={draft}
              autoFocus
              placeholder="label…"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft(String(label ?? ""));
                  setEditing(false);
                }
              }}
            />
          ) : (
            <>
              <span className="edge-text" onClick={() => setEditing(true)}>
                {label || "+"}
              </span>
              {open && (
                <>
                  <button
                    className="edge-btn"
                    title="Flip between side-to-side and top-to-bottom"
                    aria-label="Flip link direction"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFlip(id);
                    }}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
                      fill="none" stroke="currentColor" strokeWidth="1.6"
                      strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 5.5h9M8.5 3l2.5 2.5L8.5 8" />
                      <path d="M11 10.5H2M4.5 8 2 10.5 4.5 13" />
                    </svg>
                  </button>
                  <button
                    className="edge-btn danger"
                    title="Remove link"
                    aria-label="Remove link"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(id);
                    }}
                  >
                    ×
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
