import { useCallback, useRef, useState } from "react";
import { useViewport, useReactFlow } from "@xyflow/react";
import { strokePath } from "./nodes/StrokeNode";

/**
 * The drawing surface — it only handles the stroke currently under the pen.
 *
 * Once a stroke is finished it becomes a node (see StrokeNode), so it can be
 * selected, moved, scaled and deleted like any other object on the board. This
 * layer no longer renders finished strokes at all.
 */

const PRESSURE_FALLBACK = 0.5;

export type InkTool = "select" | "pen" | "eraser";

interface Props {
  tool: InkTool;
  color: string;
  size: number;
  onCommit: (points: [number, number, number][]) => void;
  /** board-space point; the board decides which stroke node it hits */
  onErase: (at: [number, number]) => void;
}

export function InkLayer({ tool, color, size, onCommit, onErase }: Props) {
  const { x, y, zoom } = useViewport();
  const { screenToFlowPosition } = useReactFlow();
  const [live, setLive] = useState<[number, number, number][]>([]);
  const drawing = useRef(false);

  const active = tool !== "select";

  const toBoard = useCallback(
    (e: React.PointerEvent): [number, number, number] => {
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      return [p.x, p.y, e.pressure || PRESSURE_FALLBACK];
    },
    [screenToFlowPosition],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const pt = toBoard(e);
    if (tool === "eraser") onErase([pt[0], pt[1]]);
    else setLive([pt]);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!active || !drawing.current) return;
    const pt = toBoard(e);
    if (tool === "eraser") onErase([pt[0], pt[1]]);
    else setLive((prev) => [...prev, pt]);
  };

  const onPointerUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (tool === "pen" && live.length > 1) onCommit(live);
    setLive([]);
  };

  if (!active && !live.length) return null;

  return (
    <>
      {/* the in-progress stroke, drawn in the canvas transform */}
      <svg
        className="ink-live"
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          pointerEvents: "none", zIndex: 6,
        }}
      >
        <g transform={`translate(${x}, ${y}) scale(${zoom})`}>
          {live.length > 1 && <path d={strokePath(live, size)} fill={color} />}
        </g>
      </svg>

      {active && (
        <div
          className="ink-capture"
          style={{
            position: "absolute", inset: 0, zIndex: 10,
            cursor: tool === "eraser" ? "cell" : "crosshair",
            touchAction: "none",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />
      )}
    </>
  );
}
