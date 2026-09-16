import type { Viewport } from "@xyflow/react";

/**
 * Where a board was when you left it, and where it should open by default.
 *
 * Two layers, deliberately stored in different places:
 *
 *   local state  — per browser, in localStorage. Where *you* were last time on
 *                  *this* machine. A viewport is tied to a screen size, so
 *                  syncing it would let a 27" monitor decide what a laptop sees.
 *   home view    — per board, on the server. A deliberate statement about how
 *                  this board should open, worth carrying to a new device.
 *
 * Precedence on load: local state if this browser has any, otherwise the home
 * view, otherwise fit-to-content. So the home view is the starting point for a
 * device that has never seen the board, and after that your own position takes
 * over — with "Go to home view" to get back.
 */
export interface BoardView {
  x: number;
  y: number;
  zoom: number;
  /** the card that was open, or null */
  openCard: string | null;
}

const KEY = (boardId: string) => `mindmaps:view:${boardId}`;

const isView = (v: unknown): v is BoardView =>
  !!v &&
  typeof v === "object" &&
  ["x", "y", "zoom"].every((k) => Number.isFinite((v as any)[k])) &&
  (v as any).zoom > 0;

export function readLocalView(boardId: string): BoardView | null {
  try {
    const raw = localStorage.getItem(KEY(boardId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isView(parsed) ? parsed : null;
  } catch {
    // private browsing, quota, corrupt entry — never worth failing a board load
    return null;
  }
}

export function writeLocalView(boardId: string, view: BoardView): void {
  try {
    localStorage.setItem(KEY(boardId), JSON.stringify(view));
  } catch {
    /* storage full or blocked; the board still works */
  }
}

export function clearLocalView(boardId: string): void {
  try {
    localStorage.removeItem(KEY(boardId));
  } catch {
    /* ignore */
  }
}

/** Parse the server-side home view, tolerating anything malformed. */
export function parseHomeView(raw: string | null | undefined): BoardView | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isView(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const toViewport = (v: BoardView): Viewport => ({ x: v.x, y: v.y, zoom: v.zoom });

/**
 * Would this view show any content at all?
 *
 * A saved viewport can go stale: the cards it framed get moved, or deleted, and
 * restoring it strands you on blank canvas with no clue why. Cheaper to detect
 * than to explain, so a view that frames nothing falls back to fit-to-content.
 */
export function viewShowsContent(
  view: BoardView,
  nodes: Array<{ x: number; y: number; w?: number | null; h?: number | null }>,
  pane: { width: number; height: number },
): boolean {
  if (!nodes.length) return true; // nothing to miss on an empty board

  // the flow-coordinate rectangle currently on screen
  const left = -view.x / view.zoom;
  const top = -view.y / view.zoom;
  const right = left + pane.width / view.zoom;
  const bottom = top + pane.height / view.zoom;

  return nodes.some((n) => {
    const w = n.w ?? 260;
    const h = n.h ?? 150;
    return n.x < right && n.x + w > left && n.y < bottom && n.y + h > top;
  });
}
