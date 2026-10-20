/**
 * Graph layout, so agents never invent coordinates.
 *
 * MCP.md §7 flagged this as the only real algorithmic work in the server, and
 * the reason is worth restating: if `create_mindmap` required `x`/`y`, every
 * agent-authored map would arrive as a pile at the origin. Asking a model to
 * do aesthetic 2D placement is asking the wrong thing of it — it knows what
 * connects to what, and that's enough to place things properly.
 *
 * Layered (Sugiyama): edges define depth, each layer becomes a column, and
 * siblings stack down it. Reading left-to-right follows the direction of the
 * arrows, which is how people draw dependency maps by hand.
 *
 * Two things this file owes the reader, because both were once missing and
 * both showed up as "the agent made an ugly map":
 *
 *  - **Ordering is a separate phase from coordinates.** Crossings are reduced
 *    by reordering nodes *within* a column, working in ranks rather than
 *    pixels; only then are offsets assigned. Mixing the two means the sort
 *    depends on sizes that depend on the sort.
 *
 *  - **Adding to a map is a packing problem, not a layout problem.** New cards
 *    go next to what they connect to and slide into whatever space is free.
 *    They used to go below *everything*, which turned a board into a long
 *    vertical ribbon with its right half empty.
 */

const CARD_W = 260;
const CARD_H = 150;

/**
 * Gaps are named for the **screen** axis, not the flow axis.
 *
 * This matters, because the code reads wrong otherwise: the `down` branch
 * reaches for the *horizontal* gap when spacing siblings, which looks like a
 * typo until you notice that siblings in a top-to-bottom map are side by side.
 * Horizontal space between cards is always GAP_X, vertical always GAP_Y.
 *
 * The asymmetry is deliberate, not an oversight. Cards are 260 wide and 150
 * tall, text runs horizontally, and edge labels need horizontal room; equal
 * gaps on both axes look cramped one way and loose the other.
 */
const GAP_X = 130;
const GAP_Y = 60;

const ORIGIN_X = 80;
const ORIGIN_Y = 80;

/**
 * Clearance between a block being placed and anything already on the board.
 *
 * The client has the same notion in `Board.tsx` (`taken()`), where it can
 * hardcode 270×165 because it only ever makes 260×150 cards. Here the sizes
 * are real — artefacts and resized cards both exist — so the padding is
 * separate from the size, and the two want to stay in agreement.
 */
const PAD = 24;

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

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A node already on the board: an obstacle, and possibly something to hang new
 * work off.
 *
 * `fixed` means "do not move this": either a human dragged it (`data.placed`
 * is `"hand"`) or it is not a graph node at all. Ink and images are
 * annotations drawn over the top of a map, so they take part in collision and
 * never in layout.
 */
export interface ExistingNode {
  id: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  fixed: boolean;
}

export interface PlaceOptions {
  direction?: Direction;
  /** every node already on the board */
  existing?: ExistingNode[];
  /** edges with both ends on this board, so a component can be identified */
  existingEdges?: LayoutEdge[];
  /** allow rebuilding an all-agent-placed component around the new nodes */
  reflowComponent?: boolean;
}

export interface PlaceResult {
  /** where the new nodes go, by their layout key */
  placed: Placed[];
  /** existing cards this call wants to move; empty unless a component was rebuilt */
  moved: Placed[];
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

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Do these two boxes visually collide, once a lane of clearance is allowed? */
export const overlaps = (a: Rect, b: Rect, pad = PAD): boolean =>
  a.x < b.x + b.w + pad &&
  b.x < a.x + a.w + pad &&
  a.y < b.y + b.h + pad &&
  b.y < a.y + a.h + pad;

const boundingBox = (rects: Rect[]): Rect => {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

const rectOf = (n: ExistingNode): Rect => ({
  x: n.x,
  y: n.y,
  w: n.w ?? CARD_W,
  h: n.h ?? CARD_H,
});

const middle = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const sizeIndex = (nodes: LayoutNode[]) =>
  new Map(nodes.map((n) => [n.key, { w: n.w ?? CARD_W, h: n.h ?? CARD_H }]));

/**
 * Weakly-connected components, largest first.
 *
 * Without this, two unrelated trees pile their roots into column 0 and
 * interleave their rows the whole way across, which is most of what "the map
 * looks complex" means in practice. Laid out separately and stacked, each one
 * reads on its own.
 */
function components(keys: string[], links: LayoutEdge[]): string[][] {
  const parent = new Map<string, string>(keys.map((k) => [k, k]));
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(k) !== root) {
      const next = parent.get(k)!;
      parent.set(k, root);
      k = next;
    }
    return root;
  };
  for (const e of links) {
    const a = find(e.from);
    const b = find(e.to);
    if (a !== b) parent.set(a, b);
  }

  const groups = new Map<string, string[]>();
  for (const k of keys) {
    const root = find(k);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(k);
  }

  // Size first, then first appearance — ties have to break deterministically or
  // the same map lays out differently on each call.
  const seen = new Map(keys.map((k, i) => [k, i]));
  return [...groups.values()].sort(
    (a, b) => b.length - a.length || seen.get(a[0])! - seen.get(b[0])!,
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

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

  const sizes = sizeIndex(nodes);
  const keys = nodes.map((n) => n.key);
  const known = new Set(keys);
  const links = edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);

  const down = direction === "down";
  const crossGap = down ? GAP_X : GAP_Y;

  const out: Placed[] = [];
  let crossCursor = down ? ORIGIN_X : ORIGIN_Y;

  for (const group of components(keys, links)) {
    const inside = new Set(group);
    const placed = layoutComponent(
      group,
      links.filter((e) => inside.has(e.from) && inside.has(e.to)),
      direction,
      sizes,
    );

    let extent = 0;
    for (const p of placed) {
      const size = sizes.get(p.key)!;
      const cross = p.cross + crossCursor;
      const along = p.along + (down ? ORIGIN_Y : ORIGIN_X);
      out.push(down ? { key: p.key, x: cross, y: along } : { key: p.key, x: along, y: cross });
      extent = Math.max(extent, p.cross + (down ? size.w : size.h));
    }
    crossCursor += extent + crossGap * 2;
  }

  return out;
}

/**
 * One connected component, in local `(along, cross)` coordinates.
 *
 * Naming the axes by role rather than x/y is what lets one implementation
 * serve both directions instead of two near-identical ones that drift apart.
 * `along` is distance down the flow; `cross` is position across it.
 */
/** Local coordinates for one component: offsets across the flow, and where each column starts along it. */
interface Coords {
  offset: Map<string, number>;
  alongAt: Map<number, number>;
}

function layoutComponent(
  keys: string[],
  links: LayoutEdge[],
  direction: Direction,
  sizes: Map<string, { w: number; h: number }>,
): Array<{ key: string; along: number; cross: number }> {
  const down = direction === "down";
  const crossGap = down ? GAP_X : GAP_Y;
  const crossSize = (k: string) => (down ? sizes.get(k)!.w : sizes.get(k)!.h);
  const alongSize = (k: string) => (down ? sizes.get(k)!.h : sizes.get(k)!.w);

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

  // --- depth -------------------------------------------------------------
  // Roots: nothing points at them. A fully cyclic component has none, so fall
  // back to its first node to avoid placing nothing.
  const depth = new Map<string, number>();
  for (const k of keys) depth.set(k, 0);

  const roots = keys.filter((k) => incoming.get(k)!.length === 0);
  let queue = roots.length ? [...roots] : [keys[0]];

  // Relax depths: a node sits one past its deepest parent. Bounded by node
  // count, which is the longest possible path in an acyclic graph and a safe
  // cutoff in a cyclic one.
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

  const order = new Map<number, string[]>();
  for (const k of keys) {
    const d = depth.get(k)!;
    if (!order.has(d)) order.set(d, []);
    order.get(d)!.push(k);
  }
  const depths = [...order.keys()].sort((a, b) => a - b);

  // --- ordering ----------------------------------------------------------
  // Crossing reduction happens here, in rank space. Ranks are scale-free, so
  // the sort never has to know a card's height — which is what stops it
  // depending on coordinates that depend on it.
  const rank = new Map<string, number>();
  const reindex = () => {
    for (const d of depths) order.get(d)!.forEach((k, i) => rank.set(k, i));
  };
  reindex();

  /**
   * Neighbours of `k` on one side, at any distance.
   *
   * Deliberately not restricted to the adjacent column. An edge that spans
   * three columns is the most visible line on the canvas, and if the sweeps
   * cannot see it they cannot straighten it.
   */
  const neighbours = (k: string, back: boolean) => {
    const d = depth.get(k)!;
    return (back ? incoming.get(k)! : outgoing.get(k)!).filter((n) =>
      back ? depth.get(n)! < d : depth.get(n)! > d,
    );
  };

  /**
   * Where `k` would like to sit, as a rank.
   *
   * A node with no neighbour on the side being swept **keeps its own rank**.
   * That one line is the whole fix for a long-standing defect: the old code
   * returned MAX_SAFE_INTEGER here, which sank every unparented node to the
   * bottom of its column and dragged a long diagonal edge after it.
   *
   * Median rather than mean, because a hub with one far-off neighbour should
   * not be pulled away from the rest of them.
   */
  const want = (k: string, back: boolean): number => {
    const ranks = neighbours(k, back).map((n) => rank.get(n)!);
    return ranks.length ? middle(ranks) : rank.get(k)!;
  };

  const sweep = (back: boolean) => {
    const walk = back ? depths.slice(1) : [...depths.slice(0, -1)].reverse();
    for (const d of walk) {
      const column = order.get(d)!;
      const was = new Map(column.map((k, i) => [k, i]));
      const key = new Map(column.map((k) => [k, want(k, back)]));
      // Ties keep the previous order, so the whole pass is stable and running
      // it twice on a settled map changes nothing.
      column.sort((a, b) => key.get(a)! - key.get(b)! || was.get(a)! - was.get(b)!);
      column.forEach((k, i) => rank.set(k, i));
    }
  };

  /**
   * How many edges cross in the finished drawing.
   *
   * Scored on real coordinates rather than on ranks, and this is the whole
   * reason the function below exists. A rank-space count is the textbook
   * measure and it misleads twice over: it scores a long edge slicing
   * diagonally across four columns as free, and it cannot see what the
   * centring passes do afterwards. Both were measurable regressions on real
   * graphs. Straight segments between card centres is what someone looking at
   * the board sees, so it is what we minimise.
   *
   * Brute force over edge pairs, run a handful of times per layout. At tens of
   * cards that is microseconds.
   */
  const crossings = (coords: Coords): number => {
    const centreOf = (k: string) => ({
      u: coords.alongAt.get(depth.get(k)!)! + alongSize(k) / 2,
      v: coords.offset.get(k)! + crossSize(k) / 2,
    });
    const segments = links.map((e) => ({ a: centreOf(e.from), b: centreOf(e.to), e }));

    type P = { u: number; v: number };
    const side = (p: P, q: P, r: P) =>
      Math.sign((q.u - p.u) * (r.v - p.v) - (q.v - p.v) * (r.u - p.u));

    let total = 0;
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const s = segments[i];
        const t = segments[j];
        // Edges meeting at a card touch there; that is not a crossing.
        if (
          s.e.from === t.e.from || s.e.from === t.e.to ||
          s.e.to === t.e.from || s.e.to === t.e.to
        ) continue;
        if (
          side(s.a, s.b, t.a) !== side(s.a, s.b, t.b) &&
          side(t.a, t.b, s.a) !== side(t.a, t.b, s.b)
        ) total++;
      }
    }
    return total;
  };

  // --- coordinates -------------------------------------------------------
  // Offsets are assigned by a forward walk with a hard `cursor + gap` floor,
  // so non-overlap within a column is structural rather than something to
  // check afterwards. Ordering is an input here and is never revisited.
  const assign = (): Coords => {
    const offset = new Map<string, number>();
    const centre = (k: string) => offset.get(k)! + crossSize(k) / 2;

    const pack = (d: number, desired: Map<string, number> | null) => {
      let cursor: number | null = null;
      for (const k of order.get(d)!) {
        const size = crossSize(k);
        const stacked = cursor === null ? 0 : cursor + crossGap;
        const target = desired?.has(k) ? desired.get(k)! - size / 2 : stacked;
        const at: number = cursor === null ? target : Math.max(target, cursor + crossGap);
        offset.set(k, at);
        cursor = at + size;
      }
    };

    const pull = (d: number, back: boolean) => {
      const desired = new Map<string, number>();
      for (const k of order.get(d)!) {
        const centres = neighbours(k, back).map(centre);
        if (centres.length) desired.set(k, middle(centres));
      }
      pack(d, desired);
    };

    // A provisional stack first, so everything has a centre to be measured
    // against; then parents over their children, then children under their
    // parents. Two passes, not iterate-to-convergence — that is enough for the
    // tree-shaped maps agents actually write, and without a displacement
    // objective further rounds can oscillate.
    for (const d of depths) pack(d, null);
    for (let i = depths.length - 2; i >= 0; i--) pull(depths[i], false);
    for (let i = 1; i < depths.length; i++) pull(depths[i], true);

    // Columns step by their own tallest card, so a column of artefacts does
    // not overlap the next one. With uniform cards this reproduces the old
    // constant step exactly.
    const alongAt = new Map<number, number>();
    let along = 0;
    for (const d of depths) {
      alongAt.set(d, along);
      let deepest = 0;
      for (const k of order.get(d)!) deepest = Math.max(deepest, alongSize(k));
      along += deepest + (down ? GAP_Y * 2 : GAP_X);
    }

    return { offset, alongAt };
  };

  // --- choosing an ordering ----------------------------------------------
  // Every sweep is a *candidate*, including doing nothing at all, and the one
  // that draws fewest crossings wins. Scoring the finished coordinates rather
  // than the ranks is what makes this safe: the result can never be worse than
  // the order the agent handed us, so more sweeps only ever help and this
  // needs no visual regression suite to ship.
  const snapshot = () => new Map([...order].map(([d, column]) => [d, [...column]]));
  const apply = (taken: Map<number, string[]>) => {
    for (const [d, column] of taken) order.set(d, [...column]);
    reindex();
  };

  const candidates = [snapshot()];

  // The ordering this file used to produce, kept as a candidate so the new
  // code cannot draw a worse map than the old one on any input. It is a single
  // forward pass that sends nodes with no placed parent to the back — the two
  // things the sweeps above were written to fix — but on some graphs it still
  // happens to land better, and there is no reason to lose those.
  for (const d of depths) {
    if (d === 0) continue;
    const column = order.get(d)!;
    const was = new Map(column.map((k, i) => [k, i]));
    const legacy = new Map(
      column.map((k) => {
        const parents = neighbours(k, true).map((n) => rank.get(n)!);
        return [k, parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : Infinity];
      }),
    );
    column.sort((a, b) => legacy.get(a)! - legacy.get(b)! || was.get(a)! - was.get(b)!);
    column.forEach((k, i) => rank.set(k, i));
  }
  candidates.push(snapshot());

  apply(candidates[0]);
  for (let round = 0; round < 4; round++) {
    sweep(true);
    sweep(false);
    candidates.push(snapshot());
  }

  let best = candidates[0];
  let bestCoords: Coords | null = null;
  let fewest = Infinity;
  for (const candidate of candidates) {
    apply(candidate);
    const coords = assign();
    const count = crossings(coords);
    if (count < fewest) {
      fewest = count;
      best = candidate;
      bestCoords = coords;
    }
    if (fewest === 0) break;
  }
  apply(best);
  const { offset, alongAt } = bestCoords!;

  let least = Infinity;
  for (const k of keys) least = Math.min(least, offset.get(k)!);

  return keys.map((k) => ({
    key: k,
    along: alongAt.get(depth.get(k)!)!,
    cross: offset.get(k)! - least,
  }));
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Ring `r` of a spiral, ordered by how much we would rather not use it.
 *
 * The cost prefers the flow direction, prefers staying on the anchor's axis,
 * and heavily penalises going backwards: a card placed to the *left* of its
 * parent draws an arrow pointing back the way it came, which reads as a
 * mistake even when nothing overlaps.
 */
function ring(r: number, direction: Direction): Array<[number, number]> {
  if (r === 0) return [[0, 0]];

  const cells: Array<[number, number]> = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) === r) cells.push([dx, dy]);
    }
  }

  const down = direction === "down";
  const cost = ([dx, dy]: [number, number]) =>
    dx * dx +
    dy * dy +
    (down ? (dy < 0 ? 4 : 0) + (dx !== 0 ? 1 : 0) : (dx < 0 ? 4 : 0) + (dy !== 0 ? 1 : 0));

  return cells.sort((a, b) => cost(a) - cost(b) || a[0] - b[0] || a[1] - b[1]);
}

/** Everything reachable from `seeds` through edges whose both ends are on this board. */
function componentOf(seeds: string[], present: Set<string>, edges: LayoutEdge[]): string[] {
  const adjacent = new Map<string, string[]>();
  for (const e of edges) {
    if (!present.has(e.from) || !present.has(e.to)) continue;
    if (!adjacent.has(e.from)) adjacent.set(e.from, []);
    if (!adjacent.has(e.to)) adjacent.set(e.to, []);
    adjacent.get(e.from)!.push(e.to);
    adjacent.get(e.to)!.push(e.from);
  }

  const seen = new Set<string>();
  const stack: string[] = [];
  for (const s of seeds) {
    if (present.has(s) && !seen.has(s)) {
      seen.add(s);
      stack.push(s);
    }
  }
  while (stack.length) {
    for (const n of adjacent.get(stack.pop()!) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return [...seen];
}

/**
 * How big a component may get before we stop rebuilding it on every write.
 *
 * Without a cap, one long-lived map that an agent keeps extending would
 * re-lay-out its entire self on each `add_card`, which is both slow and
 * visually unsettling for whoever is watching the board.
 */
const REFLOW_LIMIT = 80;

/**
 * Place new nodes on a board that already has content.
 *
 * Three things make this different from `layout()`, and each one was a
 * complaint about agent-authored maps:
 *
 *  1. **Edges to existing cards are honoured.** `layout()` drops any edge with
 *     an endpoint it does not know about, so "attach these findings to that
 *     card" used to be invisible to placement — the new card went to the
 *     bottom of the map and drew a line all the way back. Those edges are
 *     classified out here, before `layout()` ever sees them, and the cards
 *     they point at become the thing we place next to.
 *
 *  2. **New work goes into free space, not underneath.** The old rule was
 *     "below everything already present", which is safe and turns a board into
 *     a vertical ribbon. Now the block starts where it wants to be and spirals
 *     outward until it finds room.
 *
 *  3. **A map the agent built itself can be rebuilt.** If every card in the
 *     component being extended was placed automatically, the whole component
 *     is laid out afresh with the new nodes. One hand-placed card anywhere in
 *     it and nothing moves — someone arranged that, and it is not ours to
 *     undo.
 */
export function placeBlock(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: PlaceOptions = {},
): PlaceResult {
  if (!nodes.length) return { placed: [], moved: [] };

  const direction = opts.direction ?? "right";
  const existing = opts.existing ?? [];
  const existingEdges = opts.existingEdges ?? [];
  const down = direction === "down";

  const fresh = new Set(nodes.map((n) => n.key));
  const byId = new Map(existing.map((n) => [n.id, n]));

  // An endpoint is either one of this call's keys or a card already on the
  // board. Anything else is an edge to another mindmap, which has no second
  // position here to arrange against.
  const internal = edges.filter((e) => fresh.has(e.from) && fresh.has(e.to));
  const anchored = edges.filter(
    (e) =>
      (fresh.has(e.from) && byId.has(e.to)) || (fresh.has(e.to) && byId.has(e.from)),
  );
  const anchorIds = [
    ...new Set(anchored.flatMap((e) => [e.from, e.to]).filter((v) => byId.has(v))),
  ];

  let rebuilding: string[] = [];
  if (opts.reflowComponent !== false && anchorIds.length) {
    const component = componentOf(anchorIds, new Set(byId.keys()), existingEdges);
    const movable = component.every((id) => !byId.get(id)!.fixed);
    if (movable && component.length + nodes.length <= REFLOW_LIMIT) rebuilding = component;
  }

  const sizes = new Map<string, { w: number; h: number }>();
  for (const n of nodes) sizes.set(n.key, { w: n.w ?? CARD_W, h: n.h ?? CARD_H });
  for (const id of rebuilding) {
    const n = byId.get(id)!;
    sizes.set(id, { w: n.w ?? CARD_W, h: n.h ?? CARD_H });
  }

  let shape: Placed[];
  let obstacles: Rect[];
  let anchors: Rect[];

  if (rebuilding.length) {
    const inside = new Set(rebuilding);
    shape = layout(
      [...rebuilding.map((id) => ({ key: id, ...sizes.get(id)! })), ...nodes],
      [
        ...existingEdges.filter((e) => inside.has(e.from) && inside.has(e.to)),
        ...anchored,
        ...internal,
      ],
      direction,
    );
    obstacles = existing.filter((n) => !inside.has(n.id)).map(rectOf);
    anchors = [];
  } else {
    shape = layout(nodes, internal, direction);
    obstacles = existing.map(rectOf);
    anchors = anchorIds.map((id) => rectOf(byId.get(id)!));
  }

  // Normalise the block to its own origin so it can be translated as a unit.
  const box = boundingBox(shape.map((p) => ({ x: p.x, y: p.y, ...sizes.get(p.key)! })));
  const local = shape.map((p) => ({ key: p.key, x: p.x - box.x, y: p.y - box.y }));
  const localRects = local.map((p) => ({ x: p.x, y: p.y, ...sizes.get(p.key)! }));

  // Where the block would go if the board were empty there.
  let seed: { x: number; y: number };
  if (!obstacles.length) {
    seed = { x: ORIGIN_X, y: ORIGIN_Y };
  } else if (anchors.length) {
    const a = boundingBox(anchors);
    seed = down
      ? { x: a.x + a.w / 2 - box.w / 2, y: a.y + a.h + GAP_Y * 2 }
      : { x: a.x + a.w + GAP_X, y: a.y + a.h / 2 - box.h / 2 };
  } else if (rebuilding.length) {
    // Rebuilt in place: the component keeps the corner it already occupied.
    const was = boundingBox(rebuilding.map((id) => rectOf(byId.get(id)!)));
    seed = { x: was.x, y: was.y };
  } else {
    // Nothing to attach to. Continue the way the map already flows rather than
    // starting a new band underneath it.
    const all = boundingBox(obstacles);
    seed = down
      ? { x: all.x, y: all.y + all.h + GAP_Y * 2 }
      : { x: all.x + all.w + GAP_X, y: all.y };
  }

  /**
   * Collision against the real card rects, not the block's bounding box.
   *
   * A three-deep tree has a ragged outline, and testing the box would refuse a
   * slot the block actually slides into — which is the whole point, since the
   * holes in a board are what we are trying to use. The box is still worth
   * testing first as a cheap reject.
   */
  const fits = (ox: number, oy: number): boolean => {
    if (!obstacles.some((o) => overlaps({ x: ox, y: oy, w: box.w, h: box.h }, o))) return true;
    return !localRects.some((r) =>
      obstacles.some((o) => overlaps({ x: r.x + ox, y: r.y + oy, w: r.w, h: r.h }, o)),
    );
  };

  const stepX = CARD_W + GAP_X;
  const stepY = CARD_H + GAP_Y;

  let at: { x: number; y: number } | null = null;
  search: for (let r = 0; r <= 12; r++) {
    for (const [dx, dy] of ring(r, direction)) {
      const ox = seed.x + dx * stepX;
      const oy = seed.y + dy * stepY;
      if (fits(ox, oy)) {
        at = { x: ox, y: oy };
        break search;
      }
    }
  }

  // A board dense enough to defeat the spiral still has to go somewhere, and
  // below everything is free by construction. This is the old behaviour,
  // demoted from the rule to the last resort.
  if (!at) {
    const floor = obstacles.reduce((low, o) => Math.max(low, o.y + o.h), 0);
    at = { x: ORIGIN_X, y: floor + GAP_Y * 2 };
  }

  const settled = local.map((p) => ({
    key: p.key,
    x: Math.round(p.x + at!.x),
    y: Math.round(p.y + at!.y),
  }));
  const inside = new Set(rebuilding);

  return {
    placed: settled.filter((p) => !inside.has(p.key)),
    moved: settled.filter((p) => inside.has(p.key)),
  };
}
