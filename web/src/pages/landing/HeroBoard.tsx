/**
 * The hero: the actual app, with four cards on it.
 *
 * Not a lookalike. This mounts the real `CardNode` and `LabelledEdge` the board
 * uses, so the card you drag here is the card you get: the same title input,
 * the same chips, the same open-in-place markdown document
 * inside it. A rebuilt imitation drifts from the product the first time either
 * one changes, and is quietly dishonest in the meantime.
 *
 * Every callback those components take is a prop, so the whole thing runs on
 * local state with no account and no network. `CardDocument` only calls out on
 * image paste, and `ThreadSection` only once expanded, so mounting this costs
 * zero requests.
 *
 * It costs nothing in bytes either: the app ships as a single bundle, so the
 * landing page already downloads React Flow whether it renders it or not.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionMode,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { CardNode } from "../../nodes/CardNode";
import { LabelledEdge } from "../../edges/LabelledEdge";
import { docProgress, docToText } from "../../CardDocument";
import type { BoardNode } from "../../api";

const nodeTypes = { card: CardNode };
const edgeTypes = { labelled: LabelledEdge };

/** Must match `.node.card.is-open` in index.css, as it does in Board.tsx. */
const OPEN_W = 430;
const OPEN_H = 520;

// Seed documents are just markdown now, which is what a card stores.
const card = (id: string, title: string, x: number, y: number, md: string): BoardNode =>
  ({
    id,
    board_id: "demo",
    type: "card",
    title,
    body: md,
    x,
    y,
    w: 260,
    h: 150,
    data: {},
    created_at: 0,
    updated_at: 0,
  }) as unknown as BoardNode;

const seed: BoardNode[] = [
  card(
    "auth",
    "Auth consolidation",
    0,
    0,
    `Four services issue or validate sessions and nobody has the full path written down.

- [x] bank-platform issues the session
- [x] access validates, but caches for 15m
- [ ] Refresh races the cache under load`,
  ),
  card(
    "refresh",
    "Token refresh races the cache",
    360,
    140,
    `Two implementations of refresh, and they disagree about which one wins.

This is almost certainly the August incident.`,
  ),
  card(
    "cache",
    "15m cache window",
    0,
    320,
    "access caches validation for fifteen minutes, which is fine until a token is rotated inside the window.",
  ),
  card(
    "incident",
    "August incident",
    360,
    455,
    "Sessions dropped for forty minutes at peak. Never fully explained at the time.",
  ),
];

// Handles are chosen to match where the cards actually sit. Routing everything
// right-to-left in a zigzag made the links loop out around their own cards and
// run off the canvas.
const seedEdges: Edge[] = [
  { id: "e1", source: "auth", target: "refresh", sourceHandle: "right", targetHandle: "left", type: "labelled", label: "leads to" },
  { id: "e2", source: "auth", target: "cache", sourceHandle: "bottom", targetHandle: "top", type: "labelled", label: "involves" },
  { id: "e3", source: "refresh", target: "incident", sourceHandle: "bottom", targetHandle: "top", type: "labelled", label: "explains" },
  { id: "e4", source: "cache", target: "incident", sourceHandle: "right", targetHandle: "left", type: "labelled" },
];

export function HeroBoard() {
  const [cards, setCards] = useState<BoardNode[]>(seed);
  const [open, setOpen] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const rf = useRef<ReactFlowInstance | null>(null);
  /** Where we were before a card was opened, so closing returns you there. */
  const priorView = useRef<Viewport | null>(null);
  /** Live node positions, for centring on whatever has been dragged where. */
  const nodesRef = useRef<Node[]>([]);

  /**
   * Open a card the way the board does: remember the viewport, then glide the
   * card to the middle of the canvas. Without this the card expands wherever it
   * happens to sit and half of it can be off the edge, which on a panel this
   * size is most of the time.
   *
   * The board centres at zoom 1 because it has room for a 430x520 document.
   * Here the panel is smaller, so the zoom is whatever actually fits, capped at
   * 1 so it never magnifies.
   */
  const openCard = useCallback((id: string) => {
    setOpen(id);
    const inst = rf.current;
    const n = nodesRef.current.find((x) => x.id === id);
    if (!inst || !n) return;
    priorView.current = inst.getViewport();
    const box = boxRef.current?.getBoundingClientRect();
    const fit = box
      ? Math.min(1, (box.height - 32) / OPEN_H, (box.width - 32) / OPEN_W)
      : 1;
    inst.setCenter(n.position.x + OPEN_W / 2, n.position.y + OPEN_H / 2, {
      zoom: fit,
      duration: 420,
    });
  }, []);

  const closeCard = useCallback(() => {
    setOpen(null);
    const back = priorView.current;
    priorView.current = null;
    if (back) void rf.current?.setViewport(back, { duration: 420 });
  }, []);

  const boxRef = useRef<HTMLDivElement>(null);

  const patch = useCallback((id: string, p: Partial<BoardNode>) => {
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  }, []);

  /** The props the real CardNode reads, rebuilt whenever a card changes. */
  const dataFor = useCallback(
    (n: BoardNode, isOpen: boolean) => {
      const { done, total } = docProgress(n.body ?? "");
      return {
        nodeId: n.id,
        node: n,
        title: n.title,
        preview: docToText(n.body ?? "", 120),
        thread: null,
        done,
        total,
        open: isOpen,
        focused: false,
        onOpen: openCard,
        onClose: closeCard,
        onToggleFocus: () => {},
        onTitle: (id: string, title: string) => patch(id, { title }),
        onChange: (id: string, p: Partial<BoardNode>) => patch(id, p),
        // Deleting is real on a board. Here it would let a visitor empty the
        // hero, so the button is hidden in CSS and this never fires.
        onDelete: () => {},
      };
    },
    [patch, openCard, closeCard],
  );

  /**
   * Nodes live in state rather than being derived on every render, because
   * React Flow writes measured dimensions back through `onNodesChange` and
   * those measurements are what edge endpoints are computed from. Rebuilding
   * the array each render threw them away, and the links silently never drew.
   */
  const [nodes, setNodes] = useState<Node[]>(() =>
    seed.map((n) => ({
      id: n.id,
      type: "card",
      position: { x: n.x, y: n.y },
      zIndex: 1,
      data: dataFor(n, false),
    })),
  );

  // Kept in step on every render, not just on drag: the initial array and the
  // data-refresh effect set nodes too, and centring would otherwise read a
  // stale ref until something had been moved.
  nodesRef.current = nodes;

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      if (changes.some((c) => c.type === "position" && c.dragging)) setTouched(true);
    },
    [],
  );

  // Push card edits and the open/closed flag into the existing nodes, leaving
  // position and measurements untouched.
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        const c = cards.find((x) => x.id === n.id);
        if (!c) return n;
        return { ...n, zIndex: open === n.id ? 10 : 1, data: dataFor(c, open === n.id) };
      }),
    );
  }, [cards, open, dataFor]);

  const edges = useMemo<Edge[]>(
    () =>
      seedEdges.map((e) => ({
        ...e,
        data: {
          // The real edge destructures these from `data`. Inert rather than
          // absent, so hovering a link behaves instead of throwing.
          onLabel: () => {},
          onDelete: () => {},
          onFlip: () => {},
        },
      })),
    [],
  );

  return (
    <div className="lp-board" ref={boxRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onInit={(inst) => (rf.current = inst)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // Handles are declared as sources only on the real card, so an edge can
        // only find its target end in loose mode. Without this the links
        // silently do not render at all.
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
        minZoom={0.4}
        maxZoom={1.2}
        // A canvas that eats the scroll wheel on a landing page traps the
        // reader: they try to scroll past and zoom instead. Wheel and pinch are
        // off, and `preventScrolling` lets the page keep the gesture.
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        panOnScroll={false}
        preventScrolling={false}
        panOnDrag={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        aria-label="A mindmap you can drag and open"
      />
      {/* Also hidden while a card is open, where it would sit on top of the
          document it is inviting you to read. */}
      <span className={`lp-board-hint${touched || open ? " gone" : ""}`}>
        drag a card · open one
      </span>
    </div>
  );
}
