/**
 * Graph layout, so agents never invent coordinates.
 *
 * MCP.md §7 flagged this as the only real algorithmic work in the server, and
 * the reason is worth restating: if `create_mindmap` required `x`/`y`, every
 * agent-authored map would arrive as a pile at the origin. Asking a model to
 * do aesthetic 2D placement is asking the wrong thing of it — it knows what
 * connects to what, and that's enough to place things properly.
 *
 * Layered (Sugiyama-ish, minus the crossing minimisation): edges define depth,
 * each layer becomes a column, siblings stack down it. Reading left-to-right
 * follows the direction of the arrows, which is how people draw dependency
 * maps by hand.
 */

const CARD_W = 260;
const CARD_H = 150;
const COL_GAP = 130;
const ROW_GAP = 60;
const ORIGIN_X = 80;
const ORIGIN_Y = 80;

export interface LayoutNode {
  /** the agent's own reference for this node, used to resolve edges */
  key: string;
  w?: number;
  h?: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface Placed {
  key: string;
  x: number;
  y: number;
}

/**
 * Which way the graph flows.
 *
 * `right` reads like a dependency chain; `down` reads like an outline or a
 * timeline. Neither is correct in general, which is exactly why it has to be
 * changeable after the fact rather than baked in at creation.
 */
export type Direction = "right" | "down";

/** The handle pair an edge should attach to for a given flow direction. */
export const handlesFor = (d: Direction): { source: string; target: string } =>
  d === "down" ? { source: "bottom", target: "top" } : { source: "right", target: "left" };

export const isDirection = (v: unknown): v is Direction => v === "right" || v === "down";

/**
 * Assign a position to every node.
 *
 * Depth is the longest path from any root, not the shortest: with the shortest
 * path a node that depends on both a root and a deep node would sit level with
 * the root and its arrow would point backwards. Longest-path keeps every edge
 * flowing forward.
 *
 * Cycles are expected — "blocks" and "informs" between the same pair is a
 * perfectly reasonable thing to draw — so the traversal is iterative with a
 * relaxation cap rather than a recursive DFS that would stack-overflow.
 */
export function layout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  direction: Direction = "right",
): Placed[] {
  if (!nodes.length) return [];

  const keys = nodes.map((n) => n.key);
  const known = new Set(keys);
  const links = edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const k of keys) {
    incoming.set(k, []);
    outgoing.set(k, []);
  }
  for (const e of links) {
    outgoing.get(e.from)!.push(e.to);
    incoming.get(e.to)!.push(e.from);
  }

  // Roots: nothing points at them. A fully cyclic component has none, so fall
  // back to the first node of each component to avoid placing nothing.
  const depth = new Map<string, number>();
  for (const k of keys) depth.set(k, 0);

  const roots = keys.filter((k) => incoming.get(k)!.length === 0);
  const seeds = roots.length ? roots : [keys[0]];

  // Relax depths: a node sits one past its deepest parent. Bounded by node
  // count, which is the longest possible path in an acyclic graph and a safe
  // cutoff in a cyclic one.
  let queue = [...seeds];
  for (let round = 0; round < keys.length && queue.length; round++) {
    const next: string[] = [];
    for (const from of queue) {
      for (const to of outgoing.get(from)!) {
        const candidate = depth.get(from)! + 1;
        if (candidate > depth.get(to)!) {
          depth.set(to, candidate);
          next.push(to);
        }
      }
    }
    queue = next;
  }

  // Anything unreachable from a seed (a disconnected cycle) keeps depth 0 and
  // lands in the first column, which is correct — it has no dependencies we
  // know about.

  const columns = new Map<number, string[]>();
  for (const k of keys) {
    const d = depth.get(k)!;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(k);
  }

  // Order within a column by the average row of its parents, so an edge tends
  // to run straight across rather than diagonally over the whole map.
  const sizeOf = (k: string) => {
    const n = nodes.find((x) => x.key === k)!;
    return { w: n.w ?? CARD_W, h: n.h ?? CARD_H };
  };

  const placed: Placed[] = [];
  const rowOf = new Map<string, number>();
  const depths = [...columns.keys()].sort((a, b) => a - b);

  // `depth` is distance along the flow axis; `offset` is position across it.
  // Naming them that way rather than x/y is what lets one loop serve both
  // directions instead of two near-identical ones that drift apart.
  const down = direction === "down";
  const depthStep = down ? CARD_H + ROW_GAP * 2 : CARD_W + COL_GAP;

  for (const d of depths) {
    const column = columns.get(d)!;
    if (d > 0) {
      column.sort((a, b) => barycentre(a) - barycentre(b));
    }
    let offset = down ? ORIGIN_X : ORIGIN_Y;
    for (const k of column) {
      const { w, h } = sizeOf(k);
      const along = (down ? ORIGIN_Y : ORIGIN_X) + d * depthStep;
      placed.push(down ? { key: k, x: offset, y: along } : { key: k, x: along, y: offset });
      // the barycentre heuristic works across the flow axis whichever way we go
      rowOf.set(k, offset + (down ? w : h) / 2);
      offset += (down ? w + COL_GAP : h + ROW_GAP);
    }
  }

  return placed;

  /** Mean vertical centre of a node's already-placed parents. */
  function barycentre(k: string): number {
    const parents = incoming.get(k)!.map((p) => rowOf.get(p)).filter((v): v is number => v != null);
    if (!parents.length) return Number.MAX_SAFE_INTEGER; // unparented sinks go last
    return parents.reduce((a, b) => a + b, 0) / parents.length;
  }
}

/**
 * Place new nodes being appended to a map that already has content, below
 * everything currently on it. Extending a map must never land on top of what
 * the user already arranged by hand.
 */
export function layoutBelow(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  existing: Array<{ y: number; h?: number }>,
  direction: Direction = "right",
): Placed[] {
  const floor = existing.reduce((max, n) => Math.max(max, n.y + (n.h ?? CARD_H)), 0);
  const offset = existing.length ? floor + ROW_GAP * 2 : 0;
  return layout(nodes, edges, direction).map((p) => ({ ...p, y: p.y + offset }));
}
