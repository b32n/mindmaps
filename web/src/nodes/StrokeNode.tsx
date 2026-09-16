import { NodeResizer, type NodeProps } from "@xyflow/react";
import { getStroke } from "perfect-freehand";

export interface StrokeData {
  nodeId: string;
  points: [number, number, number][];
  color: string;
  size: number;
  /** the stroke's original bounding box, used as the SVG viewBox */
  ox: number;
  oy: number;
  ow: number;
  oh: number;
  onDelete: (nodeId: string) => void;
  onResize: (nodeId: string, w: number, h: number) => void;
}

/** perfect-freehand outline points -> SVG path */
function toPath(outline: number[][]): string {
  if (!outline.length) return "";
  const d = outline.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...outline[0], "Q"] as (string | number)[],
  );
  d.push("Z");
  return d.join(" ");
}

export function strokePath(points: [number, number, number][], size: number): string {
  return toPath(
    getStroke(points, {
      size,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: false,
    }) as number[][],
  );
}

/**
 * A pen stroke as a board node, so it can be selected, moved, scaled and
 * deleted like anything else rather than being painted into a passive layer.
 *
 * Scaling is done by the SVG viewBox: the path keeps its original coordinates
 * and the browser maps that box onto the node's current size. No point math on
 * resize, and no precision lost by repeatedly rescaling the data.
 */
export function StrokeNode({ data, selected }: NodeProps) {
  const d = data as unknown as StrokeData;
  const pad = d.size; // the rendered stroke is wider than its centre line
  const path = strokePath(d.points, d.size);

  return (
    <div className={`node stroke ${selected ? "selected" : ""}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={12}
        minHeight={12}
        onResizeEnd={(_, p) => d.onResize(d.nodeId, Math.round(p.width), Math.round(p.height))}
      />

      {selected && (
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
      )}

      <svg
        width="100%"
        height="100%"
        viewBox={`${d.ox - pad} ${d.oy - pad} ${d.ow + pad * 2} ${d.oh + pad * 2}`}
        preserveAspectRatio="none"
      >
        {/*
          A generous invisible hit path along the line. Only painted pixels are
          clickable in SVG, so without this a thin stroke is a near-impossible
          target to select or drag. Follows the line rather than filling the
          bounding box, so it doesn't swallow clicks in the empty corners.
        */}
        <path
          className="stroke-hit"
          d={path}
          fill="none"
          stroke="transparent"
          strokeWidth={Math.max(d.size * 3, 16)}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <path d={path} fill={d.color} />
      </svg>
    </div>
  );
}
