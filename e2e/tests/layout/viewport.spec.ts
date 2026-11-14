import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import { contents, createNode } from "../../support/api";
import type { Page } from "@playwright/test";

// Pan and zoom are remembered per mindmap in localStorage (`mindmaps:view:<id>`),
// debounced; the "home view" is the server-side starting point for a device that
// has never seen the board. See web/src/viewState.ts.

const KEY = (id: string) => `mindmaps:view:${id}`;
const stored = (page: Page, id: string) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), KEY(id)) as Promise<{ x: number; y: number; zoom: number; openCard: string | null } | null>;

async function spread(page: Page) {
  const { board, record } = await Board.create(page, "Wide map");
  const nodes = [];
  for (const [i, [x, y]] of [[0, 0], [900, 0], [0, 700], [900, 700]].entries())
    nodes.push(await createNode(page.request, record.id, { title: `Corner ${i + 1}`, x, y }));
  await board.open();
  return { board, record, nodes };
}

/** The session cookie without this browser's localStorage: "the same account on another device". */
async function signedInOnly(page: Page) {
  const { cookies } = await page.context().storageState();
  return { cookies, origins: [] };
}

/** Wait until what is in localStorage is the viewport on screen. */
async function rememberedView(board: Board) {
  await expect
    .poll(async () => {
      const [v, s] = [await board.viewport(), await stored(board.page, board.id)];
      return !!s && Math.abs(s.x - v.x) < 0.5 && Math.abs(s.y - v.y) < 0.5 && Math.abs(s.zoom - v.zoom) < 0.001;
    })
    .toBe(true);
  return board.viewport();
}

async function panBy(page: Page, board: Board, dx: number, dy: number) {
  const pane = (await board.pane.boundingBox())!;
  // an empty spot: the canvas corner, away from cards, controls and minimap
  const from = { x: pane.x + pane.width - 330, y: pane.y + 30 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 5, from.y + 5);
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
  await page.mouse.up();
}

test.describe("opening a mindmap", () => {
  test("a board with content opens fitted to it, at most 100%", async ({ page, account }) => {
    void account;
    const { board, nodes } = await spread(page);
    const { zoom } = await board.viewport();
    expect(zoom).toBeLessThanOrEqual(1);
    expect(zoom).toBeGreaterThan(0);
    // every card is inside the canvas
    const pane = (await board.pane.boundingBox())!;
    for (const n of nodes) {
      const b = await board.box(n.id);
      expect(b.x).toBeGreaterThanOrEqual(pane.x - 1);
      expect(b.y).toBeGreaterThanOrEqual(pane.y - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
      expect(b.y + b.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
    }
  });

  test("the minimap draws one rectangle per card", async ({ page, account }) => {
    void account;
    await spread(page);
    await expect(page.locator(".react-flow__minimap-node")).toHaveCount(4);
  });
});

test.describe("pan and zoom persistence", () => {
  test("panning moves the canvas and the new position is remembered across a reload", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    const start = await board.viewport();
    await panBy(page, board, -120, 60);
    const moved = await board.viewport();
    expect(moved.x).toBeLessThan(start.x - 80);
    expect(moved.y).toBeGreaterThan(start.y + 30);
    expect(moved.zoom).toBeCloseTo(start.zoom, 5);

    const remembered = await rememberedView(board);
    await page.reload();
    await board.ready();
    await expect.poll(() => board.viewport()).toEqual(remembered);
  });

  test("zoom buttons change the scale, and the zoom is remembered", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    const start = await board.viewport();

    await page.getByRole("button", { name: "Zoom In" }).click();
    await expect.poll(async () => (await board.viewport()).zoom).toBeGreaterThan(start.zoom);
    await board.settled();
    const remembered = await rememberedView(board);

    await page.getByRole("button", { name: "Zoom Out" }).click();
    await expect.poll(async () => (await board.viewport()).zoom).toBeLessThan(remembered.zoom);

    await page.reload();
    await board.ready();
    await expect.poll(async () => (await board.viewport()).zoom).toBeLessThan(remembered.zoom + 0.0001);
  });

  test("Ctrl+scroll zooms around the pointer", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    const start = await board.viewport();
    const pane = (await board.pane.boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -300);
    await page.keyboard.up("Control");
    await expect.poll(async () => (await board.viewport()).zoom).toBeGreaterThan(start.zoom);
  });

  test("“fit view” returns to the whole map", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    const fitted = await board.viewport();
    await panBy(page, board, -200, -150);
    await page.getByRole("button", { name: "Zoom In" }).click();
    await board.settled();
    await page.getByRole("button", { name: "Fit View" }).click();
    await board.settled();
    const after = await board.viewport();
    expect(after.zoom).toBeCloseTo(fitted.zoom, 1);
  });

  test("each mindmap remembers its own view", async ({ page, account }) => {
    void account;
    const { board, record } = await spread(page);
    await panBy(page, board, -150, 0);
    const a = await rememberedView(board);

    const other = await Board.create(page, "Other map");
    await createNode(page.request, other.record.id, { title: "x", x: 0, y: 0 });
    await other.board.open();
    const b = await other.board.viewport();
    expect(b).not.toEqual(a);

    await board.open();
    await expect.poll(() => board.viewport()).toEqual(a);
    expect((await stored(page, record.id))?.x).toBeCloseTo(a.x, 0);
  });

  test("the view is a property of this browser, not of the account", async ({ page, browser, account }) => {
    void account;
    const { board } = await spread(page);
    await panBy(page, board, -200, 100);
    const mine = await rememberedView(board);

    const ctx = await browser.newContext({ storageState: await signedInOnly(page) });
    const other = await ctx.newPage();
    const there = new Board(other, other.request, board.id);
    await there.open();
    expect(await there.viewport()).not.toEqual(mine);
    await ctx.close();
  });

  test("a remembered view that no longer shows anything falls back to fit", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    const fitted = await board.viewport();
    // as if the cards had since moved away from where this browser was looking
    await page.evaluate(
      ([k]) => localStorage.setItem(k, JSON.stringify({ x: -50_000, y: -50_000, zoom: 1, openCard: null })),
      [KEY(board.id)],
    );
    await page.reload();
    await board.ready();
    await expect.poll(async () => (await board.viewport()).zoom).toBeCloseTo(fitted.zoom, 2);
  });

  test("a corrupt remembered view is ignored", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    await page.evaluate(([k]) => localStorage.setItem(k, "{not json"), [KEY(board.id)]);
    await page.reload();
    await board.ready();
    await expect(board.nodes()).toHaveCount(4);
  });
});

test.describe("home view", () => {
  async function menu(page: Page) {
    await page.locator(".home-view-btn").click();
    return page.getByRole("menu");
  }

  test("starts without one: the menu offers to set it, and to forget this device's position", async ({ page, account }) => {
    void account;
    await spread(page);
    await expect(page.locator(".home-view-dot")).toHaveCount(0);
    await expect(page.locator(".home-view-btn")).toHaveAttribute("title", "Set a home view");
    const m = await menu(page);
    await expect(m.getByRole("menuitem")).toHaveText(["Save this as the home view", "Forget my position on this device"]);
    await page.keyboard.press("Escape");
    await expect(m).toHaveCount(0);
  });

  test("saving stores the current view on the server and marks the button", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    await panBy(page, board, -140, 40);
    await board.settled();
    const view = await board.viewport();

    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/boards/${board.id}`));
    await (await menu(page)).getByRole("menuitem", { name: "Save this as the home view" }).click();
    await saved;

    await expect(page.locator(".home-view-dot")).toHaveCount(1);
    await expect(page.locator(".home-view-btn")).toHaveAttribute("title", "Home view");
    const home = JSON.parse((await contents(page.request, board.id)).board.home_view!);
    expect(home.zoom).toBeCloseTo(view.zoom, 3);
    expect(home.x).toBeCloseTo(view.x, 0);
    expect(home.y).toBeCloseTo(view.y, 0);
  });

  test("“Go to home view” returns there after wandering off", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    await panBy(page, board, -140, 40);
    await board.settled();
    const home = await board.viewport();
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/boards/${board.id}`));
    await (await menu(page)).getByRole("menuitem", { name: "Save this as the home view" }).click();
    await saved;

    await panBy(page, board, 200, 150);
    await board.settled();
    expect((await board.viewport()).x).not.toBeCloseTo(home.x, 0);

    await (await menu(page)).getByRole("menuitem", { name: "Go to home view" }).click();
    await expect.poll(async () => Math.round((await board.viewport()).x)).toBe(Math.round(home.x));
    expect((await board.viewport()).y).toBeCloseTo(home.y, 0);
  });

  test("a device that has never seen the board opens at the home view", async ({ page, browser, account }) => {
    void account;
    const { board } = await spread(page);
    await panBy(page, board, -250, 120);
    await board.settled();
    const home = await board.viewport();
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/boards/${board.id}`));
    await (await menu(page)).getByRole("menuitem", { name: "Save this as the home view" }).click();
    await saved;

    const ctx = await browser.newContext({ storageState: await signedInOnly(page) });
    const fresh = await ctx.newPage();
    const there = new Board(fresh, fresh.request, board.id);
    await there.open();
    await expect.poll(async () => Math.round((await there.viewport()).x)).toBe(Math.round(home.x));
    expect((await there.viewport()).zoom).toBeCloseTo(home.zoom, 3);
    await ctx.close();
  });

  test("“Forget my position on this device” drops the local view and goes home", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    await panBy(page, board, -250, 120);
    await board.settled();
    const home = await board.viewport();
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/boards/${board.id}`));
    await (await menu(page)).getByRole("menuitem", { name: "Save this as the home view" }).click();
    await saved;
    await panBy(page, board, 150, 100);
    await rememberedView(board);

    await (await menu(page)).getByRole("menuitem", { name: "Forget my position on this device" }).click();
    await expect.poll(async () => Math.round((await board.viewport()).x)).toBe(Math.round(home.x));
    await expect.poll(() => stored(page, board.id)).toMatchObject({ x: expect.closeTo(home.x, 0) });
  });

  test("“Clear home view” removes it", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/boards/${board.id}`));
    await (await menu(page)).getByRole("menuitem", { name: "Save this as the home view" }).click();
    await saved;
    await expect(page.locator(".home-view-dot")).toHaveCount(1);

    const cleared = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/boards/${board.id}`));
    await (await menu(page)).getByRole("menuitem", { name: "Clear home view" }).click();
    await cleared;
    await expect(page.locator(".home-view-dot")).toHaveCount(0);
    expect((await contents(page.request, board.id)).board.home_view ?? "").toBe("");
  });

  test("updating replaces the saved home view", async ({ page, account }) => {
    void account;
    const { board } = await spread(page);
    const first = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/boards/${board.id}`));
    await (await menu(page)).getByRole("menuitem", { name: "Save this as the home view" }).click();
    await first;
    const one = JSON.parse((await contents(page.request, board.id)).board.home_view!);

    await panBy(page, board, -300, 0);
    await board.settled();
    const second = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/boards/${board.id}`));
    await (await menu(page)).getByRole("menuitem", { name: "Update home view to this" }).click();
    await second;
    const two = JSON.parse((await contents(page.request, board.id)).board.home_view!);
    expect(two.x).toBeLessThan(one.x - 200);
  });
});
