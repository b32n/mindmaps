/**
 * An artefact on the board: a sheet, a document or a deck.
 *
 * Deliberately not a preview. The board holds a pointer and a summary, never
 * the payload (ARTEFACTS.md §3), so there is nothing here to render the
 * contents from, and rendering them would defeat the point: a board with a
 * dozen artefacts opens as fast as one with none.
 *
 * One component for all three kinds rather than three near-identical ones. They
 * differ in an icon, a word and a count, which is not a difference worth three
 * files.
 *
 * Opening is a route change rather than an in-card expansion, and it lands in a
 * new tab so the board you came from is still sitting there when you are done.
 * The editor is behind a lazy boundary, so its code only arrives when you
 * actually open one.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useDraftField } from "../useDraftField";
import {
  KIND_LABEL, artefactHref, artefactSummary, openArtefact, type ArtefactKind,
} from "./artefact";
import { KindIcon } from "./KindIcon";

export interface ArtefactNodeData {
  nodeId: string;
  boardId: string;
  kind: ArtefactKind;
  title: string;
  /** From `nodes.data`, so no request is needed to describe the artefact. */
  counts: Record<string, unknown>;
  onTitle: (nodeId: string, title: string) => void;
  onDelete: (nodeId: string) => void;
}

export function ArtefactNode({ data, selected }: NodeProps) {
  const d = data as unknown as ArtefactNodeData;
  const f = useDraftField(d.nodeId, d.title, (v) => d.onTitle(d.nodeId, v));

  return (
    <div
      className={`node card artefact ${d.kind} ${selected ? "selected" : ""}`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        openArtefact(d.kind, d.nodeId, d.boardId);
      }}
    >
      <Handle id="top" type="source" position={Position.Top} />
      <Handle id="right" type="source" position={Position.Right} />
      <Handle id="bottom" type="source" position={Position.Bottom} />
      <Handle id="left" type="source" position={Position.Left} />

      <button
        className="node-x"
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          d.onDelete(d.nodeId);
        }}
      >
        ×
      </button>

      <span className="artefact-kind">
        <KindIcon kind={d.kind} />
        {KIND_LABEL[d.kind]}
      </span>

      <input
        className="card-title nodrag nopan"
        value={f.value}
        placeholder={`Untitled ${KIND_LABEL[d.kind].toLowerCase()}`}
        onChange={(e) => f.onChange(e.target.value)}
        onBlur={f.flush}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />

      <p className="card-preview">{artefactSummary(d.kind, d.counts)}</p>

      <a
        className="card-open"
        href={artefactHref(d.kind, d.nodeId, d.boardId)}
        target="_blank"
        rel="noopener"
        onClick={(e) => e.stopPropagation()}
      >
        Open
      </a>
    </div>
  );
}
