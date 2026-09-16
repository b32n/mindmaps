import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type Connection,
  type Viewport,
  ConnectionMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useSearchParams } from "react-router-dom";

import { api, type Board as BoardT, type BoardEdge, type BoardNode } from "./api";
import { InkLayer, type InkTool } from "./InkLayer";
import { CardNode, NoteNode } from "./nodes/CardNode";
import { ImageNode } from "./nodes/ImageNode";
import { StrokeNode } from "./nodes/StrokeNode";
import { StubNode, type StubData } from "./nodes/StubNode";
import { useHistory, isTextTarget } from "./useHistory";
import { LabelledEdge } from "./edges/LabelledEdge";
import { Toolbar } from "./Toolbar";
import { IconHome } from "./ui/Icons";
import { CardDocument, docProgress } from "./CardDocument";
import { LinkPicker } from "./LinkPicker";
import {
  clearLocalView, parseHomeView, readLocalView, toViewport, viewShowsContent,
  writeLocalView, type BoardView,
} from "./viewState";

const nodeTypes = { card: CardNode, note: NoteNode, image: ImageNode, stroke: StrokeNode, stub: StubNode };

/**
 * Readable prose for a collapsed card.
 *
 * `nodes.body` holds a markdown projection of the document — that's what search
 * and the MCP server want. A card preview wants the words, so strip the syntax
 * rather than showing the reader literal `##` and `- [ ]`.
 */
function previewOf(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")            // code blocks say nothing at a glance
    .replace(/^\s*\|(\s*:?-{1,}:?\s*\|)+\s*$/gm, " ")  // table separator rows
    .replace(/^\s*\|(.*)\|\s*$/gm, (_, row: string) => // table rows -> their cells
      row.split(/(?<!\\)\|/).map((c) => c.trim()).filter(Boolean).join(" · "))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")      // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")    // links keep their label
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")         // heading markers
    .replace(/^\s*>\s?/gm, "")                  // quote markers
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, "")  // checklist markers
    .replace(/^\s*[-*+]\s+/gm, "")              // bullets
    .replace(/^\s*\d+[.)]\s+/gm, "")            // numbers
    .replace(/(\*\*|__|~~|`)/g, "")             // paired emphasis
    .replace(/\*/g, "")                         // and the single-asterisk form
    // `_` only at a word boundary, so identifiers like vault_keys survive
    .replace(/(^|\W)_(?=\S)/g, "$1")
    .replace(/(\S)_(?=\W|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
const edgeTypes = { labelled: LabelledEdge };

// must match .node.card.is-open in index.css
const OPEN_W = 430;
const OPEN_H = 520;


interface Props {
  boardId: string;
  /** bumped when the mindmap is edited in the rail, to force a re-fetch */
  revision?: number;
  onNavigate: (boardId: string, opts?: { replace?: boolean; card?: string }) => void;
}

function BoardInner({ boardId, revision, onNavigate }: Props) {
  const rf = useReactFlow();
  /**
   * The open card rides in the URL alongside the mindmap.
   *
   * Same reason the board does: it is *what you are looking at*, so it should
   * survive a reload and be worth sending to someone. The split is that the
   * URL owns what, and localStorage owns how — pan and zoom stay local,
   * because a viewport measured on this screen means nothing on another.
   */
  const [search, setSearch] = useSearchParams();
  const urlCard = search.get("card");
  /**
   * The last `?card=` value the reader effect below saw.
   *
   * Written by that effect and nothing else. A ref shared with the writer
   * effect does not work: effects run in declaration order, so the writer
   * updates the shared value and the reader then runs in the same pass against
   * a `search` that has not caught up, concludes the URL is saying something
   * new, and acts on it.
   */
  const lastUrlCard = useRef<string | null>(urlCard);
  const inkingRef = useRef(false);
  const [board, setBoard] = useState<BoardT | null>(null);
  const [raw, setRaw] = useState<BoardNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  /** server rows, kept so off-board endpoints can be turned into stubs */
  const [rawEdges, setRawEdges] = useState<BoardEdge[]>([]);

  /**
   * A connection released on empty canvas: where it landed, and what it came
   * from. Non-null while the link picker is open.
   */
  const [pendingLink, setPendingLink] = useState<{
    screen: { x: number; y: number };
    flow: { x: number; y: number };
    fromId: string;
    fromHandle: string | null;
    fromTitle: string;
  } | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);

  const [openId, setOpenId] = useState<string | null>(null);
  // anchored = expanded on the board; focused = full-height side panel
  const [focused, setFocused] = useState(false);
  const programmatic = useRef(false);
  const lastZoom = useRef(1);
  /** where the board was before a card glided into the centre */
  const priorView = useRef<Viewport | null>(null);
  const rawRef = useRef<BoardNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  /** read inside the debounced save, which must not close over a stale openId */
  const openIdRef = useRef<string | null>(null);
  /** guards the save from firing before the restore has happened */
  const restored = useRef(false);
  /** the same signal as `restored`, but one a render can depend on */
  const [restoreTick, setRestoreTick] = useState(0);
  /** the view to apply once the nodes are actually on screen */
  const pendingView = useRef<BoardView | null>(null);
  const {
    push: pushHistory,
    undo: undoHistory,
    redo: redoHistory,
    clear: clearHistory,
    depth: historyDepth,
  } = useHistory();

  const [tool, setTool] = useState<InkTool>("select");
  const [color, setColor] = useState("#1a1a1a");
  const [size, setSize] = useState(4);

  // Optimistic local update + persist. The detail panel debounces, so this
  // is not called per keystroke.
  rawRef.current = raw;
  edgesRef.current = edges;
  openIdRef.current = openId;

  const patch = useCallback((id: string, p: Partial<BoardNode>) => {
    setRaw((ns) => ns.map((n) => (n.id === id ? { ...n, ...p } : n)));
    void api.updateNode(id, p);
  }, []);

  const setTitle = useCallback((id: string, title: string) => patch(id, { title }), [patch]);

  /** create/delete without touching history — the primitives undo itself uses */
  const insertNode = useCallback(async (n: BoardNode) => {
    const created = await api.createNode(n);
    setRaw((ns) => (ns.some((x) => x.id === created.id) ? ns : [...ns, created]));
    return created;
  }, []);

  const dropNode = useCallback((id: string) => {
    setRaw((ns) => ns.filter((n) => n.id !== id));
    setOpenId((o) => (o === id ? null : o));
    void api.deleteNode(id);
  }, []);

  /**
   * Delete a node, recording how to bring it back. Edges touching it die with
   * it server-side (cascade), so they're captured here and restored too —
   * otherwise undo would resurrect an orphan.
   */
  const removeNode = useCallback(
    (id: string) => {
      const node = rawRef.current.find((n) => n.id === id);
      if (!node) return;
      const touching = edgesRef.current.filter((e) => e.source === id || e.target === id);
      dropNode(id);
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      pushHistory({
        label: "delete",
        undo: async () => {
          await insertNode(node);
          setEdges((es) => [...es, ...touching.filter((t) => !es.some((e) => e.id === t.id))]);
          await Promise.all(
            touching.map((e) =>
              api.createEdge({
                id: e.id,
                source_id: e.source,
                target_id: e.target,
                source_handle: (e.sourceHandle ?? null) as string | null,
                target_handle: (e.targetHandle ?? null) as string | null,
              }),
            ),
          );
        },
        redo: () => {
          dropNode(id);
          setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
        },
      });
    },
    [boardId, dropNode, insertNode, pushHistory],
  );

  /**
   * Open a card in place, gliding the board so the document lands centred.
   *
   * The document grows down and to the right of the card's own footprint, so
   * the point to centre on is the middle of the *opened* box, not the card.
   * It also renders at the board's scale, so we normalise to 100% on the way —
   * at any other zoom the prose is either unreadable or comically large.
   *
   * `programmatic` suppresses the collapse-on-zoom watcher below for the
   * duration, otherwise this animation would immediately close what it opened.
   */
  const openCard = useCallback(
    (id: string) => {
      setOpenId(id);
      setFocused(false); // ⤢ escalates to the focus panel
      const n = rawRef.current.find((x) => x.id === id);
      if (n) {
        // remember where we were, so closing returns you to what you were
        // looking at rather than stranding you wherever the card happened to be
        priorView.current = rf.getViewport();
        programmatic.current = true;
        rf.setCenter(n.x + OPEN_W / 2, n.y + OPEN_H / 2, { zoom: 1, duration: 420 });
        setTimeout(() => (programmatic.current = false), 520);
      }
      lastZoom.current = 1;
    },
    [rf],
  );

  const applySize = useCallback((id: string, w: number, h: number) => {
    setRaw((ns) => ns.map((n) => (n.id === id ? { ...n, w, h } : n)));
    void api.updateNode(id, { w, h });
  }, []);

  const resizeNode = useCallback(
    (id: string, w: number, h: number) => {
      const prev = rawRef.current.find((n) => n.id === id);
      if (!prev || (prev.w === w && prev.h === h)) return;
      const { w: pw, h: ph } = prev;
      applySize(id, w, h);
      pushHistory({
        label: "resize",
        undo: () => applySize(id, pw, ph),
        redo: () => applySize(id, w, h),
      });
    },
    [applySize, pushHistory],
  );

  /**
   * Put an image on the board. Sized to fit the natural dimensions within a
   * sensible box so a screenshot doesn't land three times the size of a card.
   */
  const addImage = useCallback(
    async (file: File, at?: { x: number; y: number }) => {
      const url = await api.uploadImage(file);
      const dim = await new Promise<{ w: number; h: number }>((res) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 360 / img.width, 360 / img.height);
          res({ w: Math.round(img.width * scale), h: Math.round(img.height * scale) });
        };
        img.onerror = () => res({ w: 260, h: 180 });
        img.src = url;
      });
      const pane = document.querySelector(".react-flow__pane")?.getBoundingClientRect();
      const pos =
        at ??
        (pane
          ? rf.screenToFlowPosition({
              x: pane.x + pane.width / 2 - dim.w / 2,
              y: pane.y + pane.height / 2 - dim.h / 2,
            })
          : { x: 120, y: 120 });
      const created = await api.createNode({
        board_id: boardId,
        type: "image",
        title: file.name,
        x: Math.round(pos.x),
        y: Math.round(pos.y),
        w: dim.w,
        h: dim.h,
        data: { url },
      });
      setRaw((ns) => [...ns, created]);
      pushHistory({
        label: "add image",
        undo: () => dropNode(created.id),
        redo: () => void insertNode(created),
      });
    },
    [boardId, rf, history, dropNode, insertNode],
  );

  const applyLabel = useCallback((id: string, label: string) => {
    setEdges((es) => es.map((e) => (e.id === id ? { ...e, label: label || undefined } : e)));
    void api.updateEdge(id, { label });
  }, []);

  const setEdgeLabel = useCallback(
    (id: string, label: string) => {
      const prev = String(edgesRef.current.find((e) => e.id === id)?.label ?? "");
      if (prev === label) return;
      applyLabel(id, label);
      pushHistory({
        label: "label",
        undo: () => applyLabel(id, prev),
        redo: () => applyLabel(id, label),
      });
    },
    [applyLabel, pushHistory],
  );

  /** Write an edge's endpoints and attachment sides, locally and on the server. */
  const applyEnds = useCallback(
    (id: string, ends: { source: string; target: string; sourceHandle: string | null; targetHandle: string | null }) => {
      setEdges((es) => es.map((e) => (e.id === id ? { ...e, ...ends } : e)));
      void api.updateEdge(id, {
        source_id: ends.source,
        target_id: ends.target,
        source_handle: ends.sourceHandle,
        target_handle: ends.targetHandle,
      });
    },
    [],
  );

  /**
   * Flip a link between side-to-side and top-to-bottom.
   *
   * An agent that laid a map out left-to-right leaves every edge attached
   * right→left, and before this there was no way to change that from the
   * board. One click per edge; `relayout_mindmap` over MCP does the whole map.
   */
  const flipEdge = useCallback(
    (id: string) => {
      const e = edgesRef.current.find((x) => x.id === id);
      if (!e) return;
      const before = {
        source: e.source,
        target: e.target,
        sourceHandle: (e.sourceHandle ?? null) as string | null,
        targetHandle: (e.targetHandle ?? null) as string | null,
      };
      const vertical = before.sourceHandle === "bottom" || before.targetHandle === "top";
      const after = {
        ...before,
        sourceHandle: vertical ? "right" : "bottom",
        targetHandle: vertical ? "left" : "top",
      };
      applyEnds(id, after);
      pushHistory({
        label: "flip link",
        undo: () => applyEnds(id, before),
        redo: () => applyEnds(id, after),
      });
    },
    [applyEnds, pushHistory],
  );

  /** Dragging an edge endpoint onto a different handle or card. */
  const reconnectEdge = useCallback(
    (oldEdge: Edge, conn: Connection) => {
      const before = {
        source: oldEdge.source,
        target: oldEdge.target,
        sourceHandle: (oldEdge.sourceHandle ?? null) as string | null,
        targetHandle: (oldEdge.targetHandle ?? null) as string | null,
      };
      const after = {
        source: conn.source,
        target: conn.target,
        sourceHandle: conn.sourceHandle ?? null,
        targetHandle: conn.targetHandle ?? null,
      };
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      applyEnds(oldEdge.id, after);
      pushHistory({
        label: "reconnect",
        undo: () => applyEnds(oldEdge.id, before),
        redo: () => applyEnds(oldEdge.id, after),
      });
    },
    [applyEnds, pushHistory],
  );

  const removeEdge = useCallback(
    (id: string) => {
      const e = edgesRef.current.find((x) => x.id === id);
      if (!e) return;
      setEdges((es) => es.filter((x) => x.id !== id));
      void api.deleteEdge(id);
      pushHistory({
        label: "unlink",
        undo: async () => {
          setEdges((es) => (es.some((x) => x.id === id) ? es : [...es, e]));
          await api.createEdge({
            id: e.id,
            source_id: e.source,
            target_id: e.target,
            source_handle: (e.sourceHandle ?? null) as string | null,
            target_handle: (e.targetHandle ?? null) as string | null,
            label: String(e.label ?? ""),
          });
        },
        redo: () => {
          setEdges((es) => es.filter((x) => x.id !== id));
          void api.deleteEdge(id);
        },
      });
    },
    [boardId, pushHistory],
  );

  /**
   * Follow a stub to the card it points at.
   *
   * The target lives on another mindmap, so this switches boards and asks that
   * board to open the card once it has loaded — written into that board's saved
   * view, which is the mechanism already responsible for restoring state.
   */
  const onJump = useCallback(
    (targetBoard: string, nodeId: string) => {
      onNavigate(targetBoard, { card: nodeId });
    },
    [onNavigate],
  );

  /** Close, and glide back to wherever the board was before the card opened. */
  const closeCard = useCallback(() => {
    setOpenId(null);
    setFocused(false);
    const back = priorView.current;
    priorView.current = null;
    if (back) {
      programmatic.current = true;
      lastZoom.current = back.zoom;
      void rf.setViewport(back, { duration: 420 });
      setTimeout(() => (programmatic.current = false), 520);
    }
  }, [rf]);

  /**
   * Remember where this board is, debounced.
   *
   * Panning fires continuously, so writing on every frame would hammer
   * localStorage for no benefit — only the position you come to rest at
   * matters.
   */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rememberView = useCallback(() => {
    if (!restored.current) return; // don't overwrite before we've restored
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const v = rf.getViewport();
      writeLocalView(boardId, { ...v, openCard: openIdRef.current });
    }, 350);
  }, [boardId, rf]);

  useEffect(() => rememberView(), [openId, rememberView]);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  /**
   * Put the board back where it should be.
   *
   * Guarded, because a saved view goes stale: the card may have been deleted,
   * and the framed region may now be empty because things moved. Either way the
   * fallback is fit-to-content, which is never wrong — just less specific.
   */
  const applyView = useCallback(
    (view: BoardView, nodesNow: BoardNode[]) => {
      const pane = document.querySelector(".react-flow__pane")?.getBoundingClientRect();
      const fits =
        !pane ||
        viewShowsContent(view, nodesNow, { width: pane.width, height: pane.height });

      programmatic.current = true;

      // The viewport and the open card are separate concerns: a stale viewport
      // must not swallow the card. Arriving from a stub on another mindmap is
      // exactly this case — the card is named, the position is not.
      if (fits) {
        rf.setViewport(toViewport(view));
        lastZoom.current = view.zoom;
      } else {
        rf.fitView({ maxZoom: 1, padding: 0.3 });
        lastZoom.current = rf.getZoom();
      }

      // Set openId directly rather than calling openCard(), which would glide
      // and re-centre — undoing the viewport we just restored.
      const stillThere = view.openCard && nodesNow.some((n) => n.id === view.openCard);
      setOpenId(stillThere ? view.openCard : null);
      setFocused(false);
      setTimeout(() => (programmatic.current = false), 140);
    },
    [rf],
  );

  /**
   * Collapse on zoom.
   *
   * The open card is part of the board and scales with it, so zooming while
   * one is open would shrink the document out of legibility. Treat a zoom as
   * "I'm done reading this" and close it. Programmatic zooms — the glide when
   * opening — are excluded, or the card would close the instant it opened.
   */
  const onViewportChange = useCallback(
    ({ zoom }: { zoom: number }) => {
      rememberView();
      if (programmatic.current) {
        lastZoom.current = zoom;
        return;
      }
      if (openId && !focused && Math.abs(zoom - lastZoom.current) > 0.02) closeCard();
      lastZoom.current = zoom;
    },
    [openId, focused, closeCard, rememberView],
  );

  /**
   * Paste an image straight onto the board.
   *
   * Skipped when the caret is in a text field or inside an open card's
   * document — the markdown editor handles that paste itself, and we'd otherwise get the
   * image twice: once in the document and once as a loose node.
   */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.(".card-doc")) return;
      if (el?.closest?.("input, textarea, [contenteditable=true]")) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) void addImage(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addImage]);

  /** Drop image files anywhere on the canvas. */
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (!files.length) return;
      e.preventDefault();
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      files.forEach((f, i) => void addImage(f, { x: p.x + i * 24, y: p.y + i * 24 }));
    },
    [rf, addImage],
  );

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, closeCard]);

  /**
   * Undo/redo for the board. Deliberately steps aside when a text field or a
   * card's document has focus — ⌘Z there is the editor's own undo, and
   * hijacking it would silently discard the user's typing instead.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || isTextTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        void undoHistory();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        void redoHistory();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoHistory, redoHistory]);

  // a different board is a different history
  useEffect(() => { clearHistory(); }, [boardId, clearHistory]);

  // Rebuild the React Flow graph whenever data changes. Opening a card never
  // touches node geometry — the detail panel sits beside the board, so nothing
  // moves and no edge re-routes.
  useEffect(() => {
    const out: Node[] = raw.map((n) => {
      // checklist progress is derived from the document, not stored
      const { done, total } = docProgress(n.body ?? "");

      if (n.type === "stroke") {
        const sd = (n.data ?? {}) as any;
        return {
          id: n.id,
          type: "stroke",
          position: { x: n.x, y: n.y },
          width: n.w,
          height: n.h,
          zIndex: 0, // ink sits behind cards
          data: {
            nodeId: n.id,
            points: sd.points ?? [],
            color: sd.color ?? "#1a1a1a",
            size: sd.size ?? 4,
            ox: sd.ox ?? 0,
            oy: sd.oy ?? 0,
            ow: sd.ow ?? n.w,
            oh: sd.oh ?? n.h,
            onDelete: removeNode,
            onResize: resizeNode,
          },
        };
      }

      if (n.type === "image") {
        return {
          id: n.id,
          type: "image",
          position: { x: n.x, y: n.y },
          // React Flow v12 wants width/height as top-level node properties —
          // NodeResizer reads them, and with only `style` set the resize drag
          // falls through to the node-drag handler and moves the node instead.
          width: n.w,
          height: n.h,
          zIndex: 1,
          data: {
            nodeId: n.id,
            url: (n.data as any)?.url ?? "",
            alt: n.title,
            onDelete: removeNode,
            onResize: resizeNode,
          },
        };
      }

      return {
        id: n.id,
        type: n.type === "note" ? "note" : "card",
        position: { x: n.x, y: n.y },
        zIndex: n.id === openId ? 40 : 1,
        data: {
          nodeId: n.id,
          node: n,
          title: n.title,
          preview: previewOf(n.body ?? ""),
          thread: n.thread ?? null,
          done,
          total,
          open: n.id === openId && !focused,
          focused,
          onOpen: openCard,
          onClose: closeCard,
          onToggleFocus: () => setFocused((v) => !v),
          onTitle: setTitle,
          onChange: patch,
          onDelete: removeNode,
        },
      };
    });

    // Stubs for links that leave this mindmap. One per far card, not per edge,
    // so a card connected to three things over there produces one signpost
    // rather than three. Placed beyond the near card in the direction the link
    // leaves, and fanned out so several never land on top of each other.
    const here = new Set(raw.map((n) => n.id));
    const seen = new Map<string, number>();
    for (const e of rawEdges) {
      const outward = here.has(e.source_id) && !here.has(e.target_id);
      const inward = here.has(e.target_id) && !here.has(e.source_id);
      if (!outward && !inward) continue;

      const farId = outward ? e.target_id : e.source_id;
      const nearId = outward ? e.source_id : e.target_id;
      if (seen.has(farId)) continue;

      const near = raw.find((n) => n.id === nearId);
      if (!near) continue;
      const side = (outward ? e.source_handle : e.target_handle) ?? "right";
      const rank = seen.size;
      seen.set(farId, rank);

      const away = 380;
      const fan = rank * 170;
      const dx = side === "left" ? -away : side === "right" ? away : 0;
      const dy = side === "top" ? -away : side === "bottom" ? away : 0;

      out.push({
        id: `stub-${farId}`,
        type: "stub",
        position: {
          x: near.x + dx + (dx === 0 ? fan : 0),
          y: near.y + dy + (dy === 0 ? fan : 0),
        },
        draggable: false,
        selectable: false,
        deletable: false,
        data: {
          nodeId: farId,
          title: (outward ? e.target_title : e.source_title) ?? "",
          boardId: (outward ? e.target_board : e.source_board) ?? "",
          boardName: (outward ? e.target_board_name : e.source_board_name) ?? "elsewhere",
          onJump,
        } satisfies StubData,
      });
    }

    setNodes(out);
  }, [raw, rawEdges, openId, focused, openCard, closeCard, setTitle, patch, removeNode, resizeNode, onJump]);

  useEffect(() => {
    let cancelled = false;
    setOpenId(null);
    setFocused(false);
    api.contents(boardId).then((c) => {
      if (cancelled) return;
      setBoard(c.board);
      setRaw(c.nodes);
      setRawEdges(c.edges);
      setEdges(
        c.edges.map((e) => ({
          id: e.id,
          type: "labelled",
          // an endpoint on another mindmap is drawn to its stub
          source: e.source_board === boardId ? e.source_id : `stub-${e.source_id}`,
          target: e.target_board === boardId ? e.target_id : `stub-${e.target_id}`,
          sourceHandle: e.source_handle ?? undefined,
          targetHandle: e.target_handle ?? undefined,
          label: e.label || undefined,
          data: { onLabel: setEdgeLabel, onDelete: removeEdge, onFlip: flipEdge },
          // endpoints can be dragged onto a different handle or card
          reconnectable: true,
        })),
      );

      // Restore after the nodes are in, so the guards can see them and so
      // measured, so the guards can see them.
      // Precedence: this browser's last position, else the board's declared
      // home view, else fit-to-content.
      // Queue it: applying now would be undone, because React Flow runs its
      // own fit once the nodes first render — which is after this callback.
      const saved = readLocalView(boardId) ?? parseHomeView(c.board.home_view);
      // A card named in the URL is an explicit request — someone followed a
      // link or a stub — so it outranks whatever was open here last time.
      // The viewport still comes from the saved view: the card is named, the
      // position is not.
      pendingView.current = urlCard
        ? { x: saved?.x ?? 0, y: saved?.y ?? 0, zoom: saved?.zoom ?? 1, openCard: urlCard }
        : saved;
    });
    return () => {
      cancelled = true;
      restored.current = false;
      setRestoreTick(0);
      pendingView.current = null;
    };
    // urlCard is read once per load on purpose: re-running this on every card
    // open would refetch the whole board.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, revision, setEdgeLabel, removeEdge, flipEdge]);

  /**
   * Apply the queued view once the nodes have been measured.
   *
   * `useNodesInitialized` is the only reliable signal here: before it fires,
   * React Flow has not sized anything, so both our restore and its own fit are
   * operating on an empty canvas — and its fit lands last.
   */
  const nodesReady = useNodesInitialized();
  useEffect(() => {
    if (!nodesReady || restored.current) return;
    const view = pendingView.current;
    pendingView.current = null;
    if (view) applyView(view, rawRef.current);
    else rf.fitView({ maxZoom: 1, padding: 0.3 });
    restored.current = true;
    setRestoreTick((t) => t + 1);
  }, [nodesReady, applyView, rf]);

  /**
   * Keep the URL saying which card is open.
   *
   * `replace`, not push: opening a card is reading, not travelling, and a
   * history entry per card would turn Back into an undo button for scrolling.
   * Gated on the restore having run — otherwise the first render, where nothing
   * is open yet, would strip the `?card=` we are about to honour.
   */
  useEffect(() => {
    if (!restoreTick) return;
    if ((search.get("card") ?? null) === openId) return;
    const next = new URLSearchParams(search);
    if (openId) next.set("card", openId);
    else next.delete("card");
    setSearch(next, { replace: true });
  }, [openId, restoreTick, search, setSearch]);

  /**
   * Honour a `?card=` that arrives while this board is already mounted.
   *
   * The load effect reads `urlCard` once, deliberately, so that opening a card
   * does not refetch the board. That leaves a gap: a link to a card on the
   * board you are *already* looking at changes the URL without changing
   * `boardId`, so nothing reacts and the sync effect above then strips the
   * parameter it should have honoured. Recall jumping to a card on the current
   * board hits this every time, and so does pasting a shared link.
   *
   * The URL and `openId` are synced *both* ways — this writes state from the
   * URL, the effect above writes the URL from state — so this must react only
   * to the URL actually *changing*, never to it merely lagging behind state.
   * Closing a card is exactly that lag: `openId` goes null while the URL still
   * names the card, and a naive check reopens it instantly.
   */
  useEffect(() => {
    if (!restoreTick) return;
    const want = search.get("card");
    if (want === lastUrlCard.current) return; // the URL has not changed
    lastUrlCard.current = want;
    if (!want || want === openId) return;
    if (!rawRef.current.some((n) => n.id === want)) return;
    openCard(want);
  }, [search, restoreTick, openId, openCard]);

  const moveNode = useCallback((id: string, at: { x: number; y: number }) => {
    setRaw((ns) => ns.map((n) => (n.id === id ? { ...n, ...at } : n)));
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, position: at } : n)));
    void api.updateNode(id, at);
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    for (const ch of changes) {
      if (ch.type === "position" && ch.dragging === false && ch.position) {
        // `raw` still holds the pre-drag position at this point
        const prev = rawRef.current.find((n) => n.id === ch.id);
        const to = { x: ch.position.x, y: ch.position.y };
        if (prev && (prev.x !== to.x || prev.y !== to.y)) {
          const from = { x: prev.x, y: prev.y };
          moveNode(ch.id, to);
          pushHistory({
            label: "move",
            undo: () => moveNode(ch.id, from),
            redo: () => moveNode(ch.id, to),
          });
        }
      }
      if (ch.type === "remove") removeNode(ch.id);
    }
  }, [moveNode, removeNode, pushHistory]);

  /**
   * A link dropped in open space.
   *
   * The intent is unambiguous — connect this to something — so rather than
   * discarding the gesture, ask what. This is the only way to make a link to a
   * card on another mindmap from the board itself.
   */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: { toNode: unknown; fromNode?: { id: string } | null; fromHandle?: { id?: string | null } | null }) => {
      if (state.toNode) return; // landed on a real handle; onConnect has it
      const fromId = state.fromNode?.id;
      if (!fromId || fromId.startsWith("stub-")) return;

      const point = "changedTouches" in event ? event.changedTouches[0] : (event as MouseEvent);
      const screen = { x: point.clientX, y: point.clientY };
      setPendingLink({
        screen,
        flow: rf.screenToFlowPosition(screen),
        fromId,
        fromHandle: state.fromHandle?.id ?? null,
        fromTitle: rawRef.current.find((n) => n.id === fromId)?.title ?? "",
      });
    },
    [rf],
  );

  /** Persist a link and show it, in whichever direction was chosen. */
  const linkTo = useCallback(
    async (targetId: string, incoming: boolean) => {
      const link = pendingLink;
      if (!link) return;
      const from = incoming ? targetId : link.fromId;
      const to = incoming ? link.fromId : targetId;
      // The handle the drag started from describes this end whichever way the
      // arrow ends up pointing.
      const side = link.fromHandle ?? "right";
      const opposite = { right: "left", left: "right", top: "bottom", bottom: "top" }[side] ?? "left";

      const e = await api.createEdge({
        source_id: from,
        target_id: to,
        source_handle: incoming ? opposite : side,
        target_handle: incoming ? side : opposite,
      });
      setPendingLink(null);
      // Re-read rather than splice: a cross-board link needs the far card's
      // title and mindmap to render its stub, which only the server knows.
      const fresh = await api.contents(boardId);
      setRawEdges(fresh.edges);
      setEdges(
        fresh.edges.map((x) => ({
          id: x.id,
          type: "labelled",
          source: x.source_board === boardId ? x.source_id : `stub-${x.source_id}`,
          target: x.target_board === boardId ? x.target_id : `stub-${x.target_id}`,
          sourceHandle: x.source_handle ?? undefined,
          targetHandle: x.target_handle ?? undefined,
          label: x.label || undefined,
          data: { onLabel: setEdgeLabel, onDelete: removeEdge, onFlip: flipEdge },
          reconnectable: true,
        })),
      );
      pushHistory({
        label: "link",
        undo: () => {
          setEdges((es) => es.filter((x) => x.id !== e.id));
          setRawEdges((es) => es.filter((x) => x.id !== e.id));
          void api.deleteEdge(e.id);
        },
        redo: () => void api.createEdge({ ...e, id: e.id }),
      });
    },
    [pendingLink, boardId, setEdgeLabel, removeEdge, flipEdge, pushHistory],
  );

  /** Make a new card where the link was dropped, already connected. */
  const createLinkedCard = useCallback(
    async (incoming: boolean) => {
      const link = pendingLink;
      if (!link) return;
      setPendingLink(null);
      const created = await api.createNode({
        board_id: boardId,
        type: "card",
        title: "",
        x: Math.round(link.flow.x - 130),
        y: Math.round(link.flow.y - 40),
      });
      setRaw((ns) => [...ns, created]);

      const side = link.fromHandle ?? "right";
      const opposite = { right: "left", left: "right", top: "bottom", bottom: "top" }[side] ?? "left";
      const e = await api.createEdge({
        source_id: incoming ? created.id : link.fromId,
        target_id: incoming ? link.fromId : created.id,
        source_handle: incoming ? opposite : side,
        target_handle: incoming ? side : opposite,
      });
      setEdges((es) =>
        addEdge(
          {
            id: e.id,
            type: "labelled",
            source: incoming ? created.id : link.fromId,
            target: incoming ? link.fromId : created.id,
            sourceHandle: incoming ? opposite : side,
            targetHandle: incoming ? side : opposite,
            data: { onLabel: setEdgeLabel, onDelete: removeEdge, onFlip: flipEdge },
            reconnectable: true,
          },
          es,
        ),
      );
      pushHistory({
        label: "add linked card",
        undo: () => {
          dropNode(created.id);
          setEdges((es) => es.filter((x) => x.id !== e.id));
        },
        redo: () => void insertNode(created),
      });
    },
    [pendingLink, boardId, setEdgeLabel, removeEdge, flipEdge, pushHistory, dropNode, insertNode],
  );

  /** Cards the pending source already links to, so the picker can grey them. */
  const linkedToPending = useMemo(() => {
    const id = pendingLink?.fromId;
    if (!id) return new Set<string>();
    const out = new Set<string>();
    for (const e of rawEdges) {
      if (e.source_id === id) out.add(e.target_id);
      if (e.target_id === id) out.add(e.source_id);
    }
    out.add(id); // never offer to link a card to itself
    return out;
  }, [pendingLink, rawEdges]);

  const onConnect = useCallback(
    async (c: Connection) => {
      const e = await api.createEdge({
        source_id: c.source!,
        target_id: c.target!,
        source_handle: c.sourceHandle ?? null,
        target_handle: c.targetHandle ?? null,
      });
      setEdges((es) => addEdge({ ...c, id: e.id, type: "labelled", data: { onLabel: setEdgeLabel, onDelete: removeEdge, onFlip: flipEdge } }, es));
      pushHistory({
        label: "link",
        undo: () => {
          setEdges((es) => es.filter((x) => x.id !== e.id));
          void api.deleteEdge(e.id);
        },
        redo: async () => {
          await api.createEdge({ ...e, id: e.id });
          setEdges((es) => addEdge({ ...c, id: e.id, type: "labelled", data: { onLabel: setEdgeLabel, onDelete: removeEdge, onFlip: flipEdge } }, es));
        },
      });
    },
    [boardId, pushHistory],
  );

  /** Drop new nodes where you're looking, not at a random spot off-screen. */
  const addNode = useCallback(
    async (type: "card" | "note", at?: { x: number; y: number }) => {
      const pane = document.querySelector(".react-flow__pane")?.getBoundingClientRect();
      const pos =
        at ??
        (pane
          ? rf.screenToFlowPosition({
              x: pane.x + pane.width / 2 - 130,
              y: pane.y + pane.height / 2 - 70,
            })
          : { x: 100, y: 100 });
      // Step off anything already sitting here, so repeated clicks on the dock
      // don't stack every new card on the same square. Steps sideways by a full
      // card width first — a small diagonal nudge would leave each new card
      // covering the previous one's Open button.
      if (!at) {
        // "taken" means visually overlapping, not merely near: a card is
        // ~260×150, so anything closer than that would bury what's under it.
        const taken = (p: { x: number; y: number }) =>
          rawRef.current.some(
            (n) => Math.abs(n.x - p.x) < 270 && Math.abs(n.y - p.y) < 165,
          );
        const home = pos.x;
        for (let i = 0; i < 40 && taken(pos); i++) {
          pos.x += 290;
          if (pos.x > home + 290 * 2) {
            pos.x = home;
            pos.y += 200;
          }
        }
      }
      const created = await api.createNode({
        board_id: boardId,
        type,
        title: "",
        x: Math.round(pos.x),
        y: Math.round(pos.y),
      });
      setRaw((ns) => [...ns, created]);
      pushHistory({
        label: `add ${type}`,
        undo: () => dropNode(created.id),
        redo: () => void insertNode(created),
      });
    },
    [boardId, rf, history, dropNode, insertNode],
  );

  /**
   * Double-click EMPTY canvas to create a card there.
   *
   * The handler sits on the ReactFlow root, so it also sees double-clicks on
   * nodes, buttons and text. Without this guard, double-clicking a word to
   * select it spawns a card on top of what you were reading.
   */
  const onPaneDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (inkingRef.current) return;
      const el = e.target as HTMLElement;
      const onPane =
        el.classList.contains("react-flow__pane") ||
        el.classList.contains("react-flow__background");
      if (!onPane) return;
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      void addNode("card", { x: p.x - 130, y: p.y - 70 });
    },
    [rf, addNode],
  );

  /** A finished stroke becomes a node, positioned at its bounding box. */
  const commitStroke = useCallback(
    async (points: [number, number, number][]) => {
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      const ox = Math.min(...xs);
      const oy = Math.min(...ys);
      const ow = Math.max(Math.max(...xs) - ox, 1);
      const oh = Math.max(Math.max(...ys) - oy, 1);
      const created = await api.createNode({
        board_id: boardId,
        type: "stroke",
        x: Math.round(ox),
        y: Math.round(oy),
        w: Math.round(ow),
        h: Math.round(oh),
        data: { points, color, size, ox, oy, ow, oh },
      });
      setRaw((ns) => [...ns, created]);
      pushHistory({
        label: "draw",
        undo: () => dropNode(created.id),
        redo: () => void insertNode(created),
      });
    },
    [boardId, color, size, history, dropNode, insertNode],
  );

  /** Eraser: delete the topmost stroke whose box contains the point. */
  const eraseAt = useCallback(
    ([px, py]: [number, number]) => {
      const hit = [...rawRef.current]
        .reverse()
        .find(
          (n) =>
            n.type === "stroke" &&
            px >= n.x - 6 && px <= n.x + n.w + 6 &&
            py >= n.y - 6 && py <= n.y + n.h + 6,
        );
      if (hit) removeNode(hit.id);
    },
    [removeNode],
  );

  const openNode = openId ? raw.find((n) => n.id === openId) ?? null : null;

  const inking = tool !== "select";
  inkingRef.current = inking;
  const counts = useMemo(
    () => ({
      cards: raw.filter((n) => n.type !== "note").length,
      threads: raw.filter((n) => n.thread).length,
    }),
    [raw],
  );

  return (
    <div className="board">
      <header className="topbar">
        {board?.parent_id && (
          <button className="btn btn-ghost" onClick={() => onNavigate(board.parent_id!)}>
            ← Back
          </button>
        )}
        <h1 className="topbar-title">{board?.name ?? "…"}</h1>
        <span className="topbar-meta">
          {counts.cards} {counts.cards === 1 ? "card" : "cards"}
          {counts.threads > 0 && ` · ${counts.threads} threads`}
        </span>

        <span className="grow" />
        <HomeViewMenu
          hasHome={!!parseHomeView(board?.home_view)}
          onGoHome={() => {
            const home = parseHomeView(board?.home_view);
            if (home) applyView(home, rawRef.current);
          }}
          onSave={async () => {
            const v = rf.getViewport();
            const view: BoardView = { ...v, openCard: openIdRef.current };
            const updated = await api.updateBoard(boardId, {
              home_view: JSON.stringify(view),
            } as Partial<BoardT>);
            setBoard(updated);
          }}
          onClear={async () => {
            const updated = await api.updateBoard(boardId, {
              home_view: "",
            } as Partial<BoardT>);
            setBoard(updated);
          }}
          onForget={() => {
            clearLocalView(boardId);
            const home = parseHomeView(board?.home_view);
            if (home) applyView(home, rawRef.current);
            else rf.fitView({ maxZoom: 1, padding: 0.3 });
          }}
        />
      </header>

      <div
        className="canvas"
        onDrop={onDrop}
        onDragOver={(e) => {
          // required for onDrop to fire at all
          if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file"))
            e.preventDefault();
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd as never}
          // Drag either end of a link onto a different handle or card. Without
          // this an edge's attachment sides were fixed at creation forever.
          edgesReconnectable
          reconnectRadius={18}
          onReconnect={reconnectEdge}
          onEdgesDelete={(del) =>
            del.forEach((e) => {
              void api.deleteEdge(e.id);
              pushHistory({
                label: "unlink",
                undo: async () => {
                  await api.createEdge({
                    id: e.id,
                    source_id: e.source,
                    target_id: e.target,
                    source_handle: (e.sourceHandle ?? null) as string | null,
                    target_handle: (e.targetHandle ?? null) as string | null,
                  });
                  setEdges((es) => (es.some((x) => x.id === e.id) ? es : [...es, e]));
                },
                redo: () => {
                  setEdges((es) => es.filter((x) => x.id !== e.id));
                  void api.deleteEdge(e.id);
                },
              });
            })
          }
          onDoubleClick={onPaneDoubleClick}
          onViewportChange={onViewportChange}
          // any side can be either end of a link
          connectionMode={ConnectionMode.Loose}
          panOnDrag={!inking}
          selectionOnDrag={false}
          nodesDraggable={!inking}
          zoomOnDoubleClick={false}
          // No `fitView` prop: we fit (or restore a saved view) ourselves once
          // useNodesInitialized fires, because React Flow's own fit would land
          // after a restore and silently undo it. The cap and padding live in
          // the rf.fitView call instead.
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          {/* same cap as the initial fit, so the button matches what you land on */}
          <Controls fitViewOptions={{ maxZoom: 1, padding: 0.3 }} />
          <MiniMap pannable zoomable />
          <InkLayer
            tool={tool}
            color={color}
            size={size}
            onCommit={commitStroke}
            onErase={eraseAt}
          />
        </ReactFlow>

        <Toolbar
          tool={tool}
          setTool={setTool}
          color={color}
          setColor={setColor}
          size={size}
          setSize={setSize}
          onAddCard={() => void addNode("card")}
          onAddNote={() => void addNode("note")}
          onUndo={() => void undoHistory()}
          onRedo={() => void redoHistory()}
          canUndo={!!historyDepth.undo}
          canRedo={!!historyDepth.redo}
        />

        {pendingLink && (
          <LinkPicker
            origin={pendingLink.screen}
            sourceTitle={pendingLink.fromTitle}
            currentBoardId={boardId}
            linkedIds={linkedToPending}
            onClose={() => setPendingLink(null)}
            onPick={(target, incoming) => void linkTo(target.nodeId, incoming)}
            onCreate={(incoming) => void createLinkedCard(incoming)}
          />
        )}

        {openNode && focused && (
          <aside className="focus-panel">
            <CardDocument
              key={openNode.id}
              node={openNode}
              onChange={patch}
              onClose={closeCard}
              onToggleFocus={() => setFocused(false)}
              focused
            />
          </aside>
        )}
      </div>
    </div>
  );
}

export function Board(props: Props) {
  return (
    <ReactFlowProvider>
      <BoardInner {...props} />
    </ReactFlowProvider>
  );
}

/**
 * Home-view controls.
 *
 * A menu rather than a bare button because there are three distinct things to
 * do — set, return to, forget — and only one of them is frequent. Putting the
 * frequent one behind one click and the rest behind two keeps the topbar quiet.
 */
function HomeViewMenu({
  hasHome,
  onGoHome,
  onSave,
  onClear,
  onForget,
}: {
  hasHome: boolean;
  onGoHome: () => void;
  onSave: () => Promise<void>;
  onClear: () => Promise<void>;
  onForget: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      // `Node` here would resolve to React Flow's node type, not the DOM one
      if (!wrap.current?.contains(e.target as HTMLElement)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const run = (fn: () => void | Promise<void>) => () => {
    setOpen(false);
    void fn();
  };

  return (
    <div className="home-view" ref={wrap}>
      <button
        className="btn btn-ghost home-view-btn"
        onClick={() => setOpen((v) => !v)}
        title={hasHome ? "Home view" : "Set a home view"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconHome size={15} />
        {hasHome && <span className="home-view-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="home-view-menu" role="menu">
          {hasHome && (
            <button role="menuitem" onClick={run(onGoHome)}>
              Go to home view
            </button>
          )}
          <button role="menuitem" onClick={run(onSave)}>
            {hasHome ? "Update home view to this" : "Save this as the home view"}
          </button>
          <button role="menuitem" onClick={run(onForget)}>
            Forget my position on this device
          </button>
          {hasHome && (
            <button role="menuitem" className="danger" onClick={run(onClear)}>
              Clear home view
            </button>
          )}
        </div>
      )}
    </div>
  );
}
