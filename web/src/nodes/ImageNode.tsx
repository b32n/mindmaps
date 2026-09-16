import { Handle, Position, NodeResizer, type NodeProps } from "@xyflow/react";

export interface ImageData {
  nodeId: string;
  url: string;
  alt: string;
  onDelete: (nodeId: string) => void;
  onResize: (nodeId: string, w: number, h: number) => void;
}

/**
 * An image sitting directly on the board — pasted or dropped onto the canvas,
 * as opposed to an image inside a card's document.
 *
 * Resizable via React Flow's NodeResizer; the size is persisted so the board
 * looks the same when you come back to it.
 */
export function ImageNode({ data, selected }: NodeProps) {
  const d = data as unknown as ImageData;

  return (
    <div className={`node image ${selected ? "selected" : ""}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={80}
        minHeight={60}
        keepAspectRatio
        onResizeEnd={(_, p) => d.onResize(d.nodeId, Math.round(p.width), Math.round(p.height))}
      />

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

      <img src={d.url} alt={d.alt || ""} draggable={false} />
    </div>
  );
}
