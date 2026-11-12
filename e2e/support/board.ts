import { expect, type Locator, type Page, type APIRequestContext } from "@playwright/test";
import { contents, createBoard, type ApiBoard, type ApiNode } from "./api";

/** A node's `PATCH /api/nodes/:id` that carries one of these fields. */
type NodeField = "title" | "body" | "x" | "y" | "w" | "h";

/**
 * Page object for an open mindmap (the React Flow canvas plus its dock).
 *
 * Reading state comes in two flavours, deliberately kept apart:
 *   - `locator`s / `box()` look at what the browser shows;
 *   - `saved()` asks the server what it stored (the thing a reload would show).
 * Persistence assertions use the second, so they hold without a reload and
 * without waiting on time.
 */
export class Board {
  readonly canvas: Locator;
  readonly pane: Locator;

  constructor(
    readonly page: Page,
    readonly request: APIRequestContext,
    readonly id: string,
  ) {
    this.canvas = page.locator(".react-flow");
    this.pane = page.locator(".react-flow__pane");
  }

  /** Create an empty mindmap through the API and open it. */
  static async create(page: Page, name = "Test mindmap", extra: Record<string, unknown> = {}) {
    const board = await createBoard(page.request, name, extra);
    const b = new Board(page, page.request, board.id);
    await b.open();
    return { board: b, record: board as ApiBoard };
  }

  async open(query = "") {
    await this.page.goto(`/app/${this.id}${query}`);
    await this.ready();
  }

  /** The board's own heading is up and React Flow has laid the nodes out. */
  async ready() {
    await expect(this.canvas).toBeVisible();
    await expect(this.page.locator(".react-flow__renderer")).toBeVisible();
    await expect(this.page.getByRole("heading", { level: 1 })).toBeVisible();
    // Every node the server has is on screen, so geometry reads are safe.
    const n = (await this.saved()).nodes.length;
    await expect(this.page.locator(".react-flow__node")).toHaveCount(n);
  }

  async saved() {
    return contents(this.request, this.id);
  }

  async savedNode(id: string): Promise<ApiNode> {
    const node = (await this.saved()).nodes.find((n) => n.id === id);
    expect(node, `node ${id} on the server`).toBeTruthy();
    return node!;
  }

  // --- nodes ---------------------------------------------------------------

  /** Every rendered card/note/etc, in DOM order. */
  nodes() {
    return this.page.locator(".react-flow__node:not(.react-flow__node-stub)");
  }

  /** The node element for a server id. */
  node(id: string) {
    return this.page.locator(`.react-flow__node[data-id="${id}"]`);
  }

  /** The × in a node's corner (it is titled "Delete"; its text is just a ×). */
  deleteButton(id: string) {
    return this.node(id).getByTitle("Delete");
  }

  /** The title field of a card (collapsed card face). */
  title(id: string) {
    return this.node(id).locator("input.card-title");
  }

  /** The text of a note. */
  noteText(id: string) {
    return this.node(id).locator("textarea");
  }

  /**
   * Wait for the PATCH that stores `value` into `field` of node `id`. Register
   * it *before* the action that triggers the save, then await it.
   */
  savedField(id: string, field: NodeField, value?: string | number | RegExp) {
    return this.page.waitForResponse((r) => {
      if (r.request().method() !== "PATCH" || !r.url().endsWith(`/api/nodes/${id}`) || !r.ok())
        return false;
      const sent = r.request().postDataJSON() as Record<string, unknown>;
      if (!(field in sent)) return false;
      if (value === undefined) return true;
      const got = String(sent[field]);
      return value instanceof RegExp ? value.test(got) : got.trim() === String(value);
    });
  }

  /** Click a dock button and return the new node's server id. */
  async addVia(action: () => Promise<void>): Promise<string> {
    const created = this.page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/api/nodes") && r.status() === 201,
    );
    await action();
    const node = (await (await created).json()) as ApiNode;
    await expect(this.node(node.id)).toBeVisible();
    return node.id;
  }

  addCard() {
    return this.addVia(() => this.page.getByRole("button", { name: "Add card" }).click());
  }

  addNote() {
    return this.addVia(() => this.page.getByRole("button", { name: "Add note" }).click());
  }

  // --- the open card -------------------------------------------------------

  /** The in-place document of the open card (the ProseMirror editor). */
  get editor() {
    return this.page.locator(".card-doc .ProseMirror");
  }

  /** Open a card with its "Open" button and wait for its editor. */
  async openCard(id: string) {
    await this.node(id).getByRole("button", { name: "Open" }).click();
    await expect(this.editor).toBeVisible();
    await expect(this.node(id).locator(".node.card.is-open")).toBeVisible();
  }

  /** Close the open card with its × and wait until the app has forgotten it. */
  async closeCard() {
    await this.page.locator(".card-doc").getByRole("button", { name: "Close" }).click();
    await expect(this.page.locator(".card-doc")).toHaveCount(0);
    await expect(this.page).not.toHaveURL(/card=/);
  }

  // --- geometry ------------------------------------------------------------

  /** Where the browser draws a node, in viewport pixels. */
  async box(id: string) {
    const box = await this.node(id).boundingBox();
    expect(box, `node ${id} is on screen`).not.toBeNull();
    return box!;
  }

  /**
   * Drag by `dx,dy` screen pixels with a real mouse, from a point on the card
   * that is neither its title input nor a button (those stop the drag).
   * Resolves once the server has the new position.
   */
  async drag(id: string, dx: number, dy: number) {
    const before = await this.savedNode(id);
    const box = await this.box(id);
    // top-left padding of the card: inside the node, outside every control
    const from = { x: box.x + 6, y: box.y + 6 };
    const saved = this.page.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        r.url().endsWith(`/api/nodes/${id}`) &&
        "x" in (r.request().postDataJSON() as object),
    );
    const { mouse } = this.page;
    await mouse.move(from.x, from.y);
    await mouse.down();
    // React Flow starts the drag on the first move and measures from there, so
    // make that first move a small one; the distance below is then accurate to
    // a few pixels.
    await mouse.move(from.x + Math.sign(dx) * 3, from.y + Math.sign(dy) * 3);
    await mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 8 });
    await mouse.move(from.x + dx, from.y + dy, { steps: 8 });
    await mouse.up();
    await saved;
    const after = await this.savedNode(id);
    // A drag that saved nothing new would make every "position persists" check
    // below compare the server with itself.
    expect([after.x, after.y], `node ${id} moved on the server`).not.toEqual([before.x, before.y]);
    return { before, after };
  }

  // --- links ---------------------------------------------------------------

  /** The connection dot on one side of a node (invisible until hovered, but live). */
  handle(id: string, side: "top" | "right" | "bottom" | "left") {
    return this.node(id).locator(`.react-flow__handle[data-handleid="${side}"]`);
  }

  /**
   * Press on a node's handle and drag to a screen point (or another node's
   * handle), releasing there. Real mouse events with intermediate moves, which
   * React Flow needs to start and finish a connection.
   */
  async dragFromHandle(
    id: string,
    side: "top" | "right" | "bottom" | "left",
    to: { x: number; y: number } | { node: string; side: "top" | "right" | "bottom" | "left" },
  ) {
    const from = await centre(this.handle(id, side));
    const end = "node" in to ? await centre(this.handle(to.node, to.side)) : to;
    const { mouse } = this.page;
    await mouse.move(from.x, from.y);
    await mouse.down();
    await mouse.move((from.x + end.x) / 2, (from.y + end.y) / 2, { steps: 6 });
    await mouse.move(end.x, end.y, { steps: 8 });
    await mouse.up();
  }

  /** Link two cards by dragging handle to handle; resolves with the stored edge. */
  async link(
    from: string,
    fromSide: "top" | "right" | "bottom" | "left",
    to: string,
    toSide: "top" | "right" | "bottom" | "left",
  ) {
    const created = this.page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/api/edges") && r.status() === 201,
    );
    await this.dragFromHandle(from, fromSide, { node: to, side: toSide });
    return (await (await created).json()) as { id: string; source_id: string; target_id: string };
  }

  /** The drawn link element for an edge id. */
  edge(id: string) {
    return this.page.locator(`.react-flow__edge[data-id="${id}"]`);
  }

  /** The label text of every drawn link ("+" when unlabelled), in DOM order. */
  edgeLabels() {
    return this.page.locator(".edge-label .edge-text");
  }

  /** The whole label chip, including its hover controls. */
  edgeChips() {
    return this.page.locator(".edge-label");
  }

  /**
   * Put the pointer on a link's label and wait for its controls to open. The
   * chip grows when they appear, so clicking before they have would land on the
   * wrong spot.
   */
  async hoverEdge(n = 0) {
    await this.edgeChips().nth(n).hover();
    await expect(this.edgeChips().nth(n).getByRole("button", { name: "Flip link direction" })).toBeVisible();
  }

  /** The draggable dot at one end of a link (React Flow's reconnect anchor). */
  edgeEnd(end: "source" | "target") {
    return this.page.locator(`.react-flow__edgeupdater-${end}`);
  }

  // --- viewport ------------------------------------------------------------

  /** Wait until the canvas has stopped gliding (opening a card pans and zooms it). */
  async settled() {
    await expect
      .poll(async () => {
        const a = await this.viewport();
        await this.page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        const b = await this.viewport();
        return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
      })
      .toBe(true);
  }

  /** `translate(x, y) scale(z)` of the React Flow viewport, as numbers. */
  async viewport() {
    const t = await this.page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\((-?[\d.]+)\)/.exec(t);
    expect(m, `viewport transform "${t}"`).toBeTruthy();
    return { x: Number(m![1]), y: Number(m![2]), zoom: Number(m![3]) };
  }
}

async function centre(l: Locator) {
  const b = await l.boundingBox();
  expect(b, "handle has a box").not.toBeNull();
  return { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 };
}
