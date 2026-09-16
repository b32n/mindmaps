import { useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useDraftField } from "../useDraftField";
import { CardDocument } from "../CardDocument";
import type { BoardNode } from "../api";

/**
 * Keep a element mounted while it plays its exit animation.
 *
 * React unmounts on state change immediately, so a closing card would simply
 * vanish while the opening one animates. This holds it for `ms` after `open`
 * goes false, and cancels the exit if it is reopened mid-flight.
 */
function useExit(open: boolean, ms: number) {
  const [exiting, setExiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const was = useRef(open);

  useEffect(() => {
    if (was.current && !open) {
      setExiting(true);
      timer.current = setTimeout(() => setExiting(false), ms);
    }
    if (!was.current && open && timer.current) {
      clearTimeout(timer.current);
      setExiting(false);
    }
    was.current = open;
  }, [open, ms]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { mounted: open || exiting, exiting };
}

/** A connection point on each of the four sides. */
function SideHandles() {
  return (
    <>
      <Handle id="top" type="source" position={Position.Top} />
      <Handle id="right" type="source" position={Position.Right} />
      <Handle id="bottom" type="source" position={Position.Bottom} />
      <Handle id="left" type="source" position={Position.Left} />
    </>
  );
}

export interface CardData {
  nodeId: string;
  node: BoardNode;
  title: string;
  /** plain-text projection of the document, clamped when collapsed */
  preview: string;
  thread: string | null;
  /** checklist progress from the document; replaced the old sub-card count */
  done: number;
  total: number;
  open: boolean;
  focused: boolean;
  onOpen: (nodeId: string) => void;
  onClose: () => void;
  onToggleFocus: () => void;
  onTitle: (nodeId: string, title: string) => void;
  onChange: (id: string, patch: Partial<BoardNode>) => void;
  onDelete: (nodeId: string) => void;
}

/**
 * A card. Collapsed it shows a title, a clipped preview and its state; open it
 * grows in place into the full document. It is one element throughout — the
 * card itself expands rather than an overlay appearing on top of it.
 */
export function CardNode({ data, selected }: NodeProps) {
  const d = data as unknown as CardData;
  const id = d.nodeId;
  const f = useDraftField(id, d.title, (v) => d.onTitle(id, v));
  const { mounted, exiting } = useExit(d.open, 220);

  return (
    <div
      className={`node card ${selected ? "selected" : ""} ${d.open ? "is-open" : ""} ${
        exiting ? "is-closing" : ""
      }`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!d.open) d.onOpen(id);
      }}
    >
      <SideHandles />

      {/*
        When open, the document is drawn in an absolutely-positioned child that
        overflows the node, and the collapsed content below stays in the layout
        (hidden, but still occupying space).

        The node's own box therefore never changes size, so React Flow never
        re-measures it: the connection handles do not move and no connected edge
        re-routes. Pinning the handles with CSS instead can't be exact, because
        a collapsed card's height depends on how long its preview is.
      */}
      {mounted && (
        <div
          className={`card-doc nodrag nowheel ${exiting ? "closing" : ""}`}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <CardDocument
            node={d.node}
            onChange={d.onChange}
            onClose={d.onClose}
            onToggleFocus={d.onToggleFocus}
            focused={d.focused}
          />
        </div>
      )}

      <button
        className="node-x"
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          d.onDelete(id);
        }}
      >
        ×
      </button>

      <input
        className="card-title nodrag nopan"
        value={f.value}
        placeholder="Untitled"
        onChange={(e) => f.onChange(e.target.value)}
        onBlur={f.flush}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />

      {d.preview && <p className="card-preview">{d.preview}</p>}

      <div className="chips">
        {d.thread && <span className={`chip thread ${d.thread}`}>thread · {d.thread}</span>}
        {d.total > 0 && (
          <span className={`chip kids ${d.done === d.total ? "complete" : ""}`}>
            {d.done}/{d.total} done
          </span>
        )}
      </div>

      <button className="card-open" onClick={() => d.onOpen(id)}>
        Open
      </button>
    </div>
  );
}

export function NoteNode({ data, selected }: NodeProps) {
  const d = data as unknown as CardData;
  const id = d.nodeId;
  const f = useDraftField(id, d.title, (v) => d.onTitle(id, v));

  return (
    <div className={`node note ${selected ? "selected" : ""}`}>
      <SideHandles />
      <button
        className="node-x"
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          d.onDelete(id);
        }}
      >
        ×
      </button>
      <textarea
        className="nodrag nopan"
        value={f.value}
        placeholder="Note…"
        onChange={(e) => f.onChange(e.target.value)}
        onBlur={f.flush}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
