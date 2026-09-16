import { Handle, Position, type NodeProps } from "@xyflow/react";

export interface StubData {
  /** the far card */
  nodeId: string;
  title: string;
  /** the mindmap it lives on */
  boardId: string;
  boardName: string;
  onJump: (boardId: string, nodeId: string) => void;
  [key: string]: unknown;
}

/**
 * The far end of a link that leaves this mindmap.
 *
 * Deliberately not a card. A card here would claim the far one lives on this
 * canvas, which is a lie the layout would then have to maintain — move it, and
 * you'd have moved something on a board you aren't looking at. A stub is a
 * signpost: it says "this continues elsewhere", names where, and gets out of
 * the way.
 *
 * It carries handles on all four sides so the edge can attach with the same
 * geometry as any other, and it is never persisted — it exists only while this
 * board is on screen.
 */
export function StubNode({ data }: NodeProps) {
  const d = data as unknown as StubData;
  return (
    <div
      className="node stub"
      onClick={() => d.onJump(d.boardId, d.nodeId)}
      title={`${d.title} · in ${d.boardName}`}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") d.onJump(d.boardId, d.nodeId);
      }}
    >
      <Handle id="top" type="source" position={Position.Top} />
      <Handle id="right" type="source" position={Position.Right} />
      <Handle id="bottom" type="source" position={Position.Bottom} />
      <Handle id="left" type="source" position={Position.Left} />

      <span className="stub-where">
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"
          fill="none" stroke="currentColor" strokeWidth="1.7"
          strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.5 3.5H13v3.5" />
          <path d="M13 3.5 7.5 9" />
          <path d="M12 9.5v3H3.5v-9H7" />
        </svg>
        {d.boardName}
      </span>
      <span className="stub-title">{d.title || "(untitled)"}</span>
    </div>
  );
}
