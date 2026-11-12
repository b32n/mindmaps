import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import { createBoard, createEdge, createNode } from "../../support/api";
import type { Page } from "@playwright/test";

async function twoCards(page: Page, opts: { linked?: boolean; label?: string } = {}) {
  const { board, record } = await Board.create(page, "Links");
  const a = await createNode(page.request, record.id, { title: "Alpha", x: 0, y: 0 });
  const b = await createNode(page.request, record.id, { title: "Beta", x: 500, y: 0 });
  const edge = opts.linked
    ? await createEdge(page.request, {
        source_id: a.id,
        target_id: b.id,
        label: opts.label ?? "",
        source_handle: "right",
        target_handle: "left",
      })
    : null;
  await board.open();
  return { board, record, a, b, edge };
}

test.describe("creating links by dragging between handles", () => {
  test("handle to handle makes a link that is stored with its sides", async ({ page, account }) => {
    void account;
    const { board, a, b } = await twoCards(page);
    const edge = await board.link(a.id, "right", b.id, "left");

    await expect(board.edge(edge.id)).toHaveCount(1);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    expect((await board.saved()).edges).toMatchObject([
      { id: edge.id, source_id: a.id, target_id: b.id, label: "", source_handle: "right", target_handle: "left" },
    ]);
  });

  test("a link survives a reload", async ({ page, account }) => {
    void account;
    const { board, a, b } = await twoCards(page);
    const edge = await board.link(a.id, "bottom", b.id, "top");
    await page.reload();
    await board.ready();
    await expect(board.edge(edge.id)).toHaveCount(1);
  });

  test("any side can be either end: dragging from the target's side works too", async ({ page, account }) => {
    void account;
    const { board, a, b } = await twoCards(page);
    const edge = await board.link(b.id, "left", a.id, "right");
    expect(edge).toMatchObject({ source_id: b.id, target_id: a.id });
  });

  test("a link can be added to a card that already has others", async ({ page, account }) => {
    void account;
    const { board, record, a, b } = await twoCards(page, { linked: true });
    const c = await createNode(page.request, record.id, { title: "Gamma", x: 250, y: 300 });
    await board.open();
    await board.link(a.id, "bottom", c.id, "top");
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    expect((await board.saved()).edges.map((e) => [e.source_id, e.target_id]).sort()).toEqual(
      [[a.id, b.id], [a.id, c.id]].sort(),
    );
  });

  test("releasing a drag on nothing offers the link picker rather than dropping the gesture", async ({ page, account }) => {
    void account;
    const { board, a } = await twoCards(page);
    const pane = (await board.pane.boundingBox())!;
    await board.dragFromHandle(a.id, "right", { x: pane.x + 300, y: pane.y + 450 });

    const picker = page.getByRole("dialog", { name: "Link this card" });
    await expect(picker).toBeVisible();
    await expect(picker.getByText("Link “Alpha”")).toBeVisible();
    await expect(picker.getByRole("button", { name: "Select from a mindmap" })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Create a card here" })).toBeVisible();
    expect((await board.saved()).edges).toHaveLength(0);

    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
  });
});

test.describe("the link picker", () => {
  async function dropOnEmpty(page: Page, board: Board, from: string, side: "top" | "right" | "bottom" | "left" = "right") {
    const pane = (await board.pane.boundingBox())!;
    await board.dragFromHandle(from, side, { x: pane.x + 300, y: pane.y + 450 });
    const picker = page.getByRole("dialog", { name: "Link this card" });
    await expect(picker).toBeVisible();
    return picker;
  }

  test("“Create a card here” makes a new card and links it, pointing away from the source", async ({ page, account }) => {
    void account;
    const { board, a } = await twoCards(page);
    const picker = await dropOnEmpty(page, board, a.id);
    await picker.getByRole("button", { name: "Create a card here" }).click();

    await expect(picker).toHaveCount(0);
    await expect(board.nodes()).toHaveCount(3);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect.poll(async () => (await board.saved()).edges.length).toBe(1);
    const saved = await board.saved();
    const created = saved.nodes.find((n) => n.id !== a.id && n.title === "" && n.type === "card")!;
    expect(saved.edges[0]).toMatchObject({ source_id: a.id, target_id: created.id, source_handle: "right", target_handle: "left" });
  });

  test("“← points here” reverses the arrow", async ({ page, account }) => {
    void account;
    const { board, a } = await twoCards(page);
    const picker = await dropOnEmpty(page, board, a.id, "bottom");
    await picker.getByRole("button", { name: "← points here" }).click();
    await picker.getByRole("button", { name: "Create a card here" }).click();

    await expect.poll(async () => (await board.saved()).edges.length).toBe(1);
    const saved = await board.saved();
    expect(saved.edges[0]).toMatchObject({ target_id: a.id, source_handle: "top", target_handle: "bottom" });
  });

  test("an existing card on this mindmap can be picked, and linked cards are greyed out", async ({ page, account }) => {
    void account;
    const { board, a, b } = await twoCards(page);
    const picker = await dropOnEmpty(page, board, a.id);
    await picker.getByRole("button", { name: "Select from a mindmap" }).click();
    await expect(picker.getByText("Choose a mindmap")).toBeVisible();
    await picker.getByRole("button", { name: /Links/ }).click();

    // never offers a card to itself
    await expect(picker.getByRole("button", { name: "Alpha" })).toBeDisabled();
    await picker.getByRole("button", { name: "Beta" }).click();

    await expect(picker).toHaveCount(0);
    await expect.poll(async () => (await board.saved()).edges.length).toBe(1);
    expect((await board.saved()).edges[0]).toMatchObject({ source_id: a.id, target_id: b.id });

    // now they are linked, the same picker marks Beta as taken
    const second = await dropOnEmpty(page, board, a.id, "top");
    await second.getByRole("button", { name: "Select from a mindmap" }).click();
    await second.getByRole("button", { name: /Links/ }).click();
    await expect(second.getByRole("button", { name: /Beta/ })).toBeDisabled();
    await expect(second.getByRole("button", { name: "Beta linked" })).toBeVisible();
  });

  test("filters narrow the lists, Escape steps back before closing", async ({ page, account }) => {
    void account;
    const { board, a } = await twoCards(page);
    await createBoard(page.request, "Zebra notes");
    const picker = await dropOnEmpty(page, board, a.id);
    await picker.getByRole("button", { name: "Select from a mindmap" }).click();

    await expect(picker.getByRole("button", { name: /Zebra notes/ })).toBeVisible();
    await picker.getByPlaceholder("Filter mindmaps…").fill("zeb");
    await expect(picker.locator(".lp-row")).toHaveCount(1);
    await picker.getByPlaceholder("Filter mindmaps…").fill("nothing like this");
    await expect(picker.getByText("No mindmaps match.")).toBeVisible();

    await picker.getByPlaceholder("Filter mindmaps…").fill("zeb");
    await picker.getByRole("button", { name: /Zebra notes/ }).click();
    await expect(picker.getByText("Nothing on this mindmap.")).toBeVisible();

    await page.keyboard.press("Escape"); // back to the mindmaps
    await expect(picker.getByText("Choose a mindmap")).toBeVisible();
    await page.keyboard.press("Escape"); // back to the start
    await expect(picker.getByRole("button", { name: "Create a card here" })).toBeVisible();
    await page.keyboard.press("Escape"); // gone
    await expect(picker).toHaveCount(0);
  });

  test("clicking elsewhere closes it without linking", async ({ page, account }) => {
    void account;
    const { board, a } = await twoCards(page);
    const picker = await dropOnEmpty(page, board, a.id);
    await page.getByRole("heading", { level: 1 }).click();
    await expect(picker).toHaveCount(0);
    expect((await board.saved()).edges).toHaveLength(0);
  });
});

test.describe("links across mindmaps", () => {
  test("picking a card from another mindmap draws a stub that jumps there", async ({ page, account }) => {
    void account;
    // The rail loads its list once per visit, so create the far mindmap first.
    const other = await createBoard(page.request, "Elsewhere");
    const far = await createNode(page.request, other.id, { title: "Far card", body: "over there", x: 0, y: 0 });
    const { board, a } = await twoCards(page);

    const pane = (await board.pane.boundingBox())!;
    await board.dragFromHandle(a.id, "right", { x: pane.x + 300, y: pane.y + 450 });
    const picker = page.getByRole("dialog", { name: "Link this card" });
    await picker.getByRole("button", { name: "Select from a mindmap" }).click();
    await picker.getByRole("button", { name: /Elsewhere/ }).click();
    await picker.getByRole("button", { name: "Far card" }).click();

    const stub = page.getByRole("link", { name: /Elsewhere/ });
    await expect(stub).toBeVisible();
    await expect(stub).toContainText("Far card");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    expect((await board.saved()).edges[0]).toMatchObject({ source_id: a.id, target_id: far.id, target_board: other.id });

    // the stub is a signpost: it is not a card and cannot be moved or deleted
    await expect(page.locator(".topbar-meta")).toHaveText("2 cards");

    await stub.click();
    await expect(page).toHaveURL(new RegExp(`/app/${other.id}\\?card=${far.id}`));
    await expect(page.getByRole("heading", { level: 1, name: "Elsewhere" })).toBeVisible();
    await expect(board.editor).toContainText("over there");
  });

  test("the far card's mindmap shows a stub back, and stubs persist across reloads", async ({ page, account }) => {
    void account;
    const here = await createBoard(page.request, "Here");
    const there = await createBoard(page.request, "There");
    const a = await createNode(page.request, here.id, { title: "Near", x: 0, y: 0 });
    const b = await createNode(page.request, there.id, { title: "Away", x: 0, y: 0 });
    await createEdge(page.request, { source_id: a.id, target_id: b.id, label: "explains", source_handle: "right", target_handle: "left" });

    await page.goto(`/app/${there.id}`);
    await expect(page.getByRole("link", { name: /Here/ })).toContainText("Near");
    await expect(page.locator(".edge-label .edge-text")).toHaveText("explains");
    await page.reload();
    await expect(page.getByRole("link", { name: /Here/ })).toContainText("Near");
  });

  test("several links to the same far card share one stub", async ({ page, account }) => {
    void account;
    const here = await createBoard(page.request, "Here");
    const there = await createBoard(page.request, "There");
    const a = await createNode(page.request, here.id, { title: "One", x: 0, y: 0 });
    const c = await createNode(page.request, here.id, { title: "Two", x: 0, y: 300 });
    const far = await createNode(page.request, there.id, { title: "Hub", x: 0, y: 0 });
    for (const src of [a, c])
      await createEdge(page.request, { source_id: src.id, target_id: far.id, source_handle: "right", target_handle: "left" });

    await page.goto(`/app/${here.id}`);
    await expect(page.getByRole("link", { name: /There/ })).toHaveCount(1);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  });
});

test.describe("labels", () => {
  test("an unlabelled link shows a + you can click to name it", async ({ page, account }) => {
    void account;
    const { board, edge } = await twoCards(page, { linked: true });
    const chip = board.edgeLabels();
    await expect(chip).toHaveText("+");
    await expect(board.edgeChips()).toHaveClass(/empty/);

    await board.hoverEdge();
    await chip.click();
    const input = page.getByPlaceholder("label…");
    await expect(input).toBeFocused();
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/edges/${edge!.id}`));
    await input.fill("blocks");
    await input.press("Enter");
    await saved;

    await expect(chip).toHaveText("blocks");
    expect((await board.saved()).edges[0].label).toBe("blocks");
    await page.reload();
    await expect(board.edgeLabels()).toHaveText("blocks");
  });

  test("double-clicking the link line edits the label too, and Escape abandons an edit", async ({ page, account }) => {
    void account;
    const { board } = await twoCards(page, { linked: true, label: "explains" });
    await board.hoverEdge();
    await board.edgeLabels().dblclick();
    const input = page.getByPlaceholder("label…");
    await expect(input).toHaveValue("explains");
    await input.fill("something else");
    await input.press("Escape");
    await expect(board.edgeLabels()).toHaveText("explains");
    expect((await board.saved()).edges[0].label).toBe("explains");
  });

  test("blur commits, surrounding spaces are trimmed, and clearing removes the label", async ({ page, account }) => {
    void account;
    const { board, edge } = await twoCards(page, { linked: true, label: "old" });
    await board.hoverEdge();
    await board.edgeLabels().dblclick();
    const input = page.getByPlaceholder("label…");
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/edges/${edge!.id}`));
    await input.fill("  supersedes  ");
    await page.getByRole("heading", { level: 1 }).click(); // blur
    await saved;
    await expect(board.edgeLabels()).toHaveText("supersedes");
    expect((await board.saved()).edges[0].label).toBe("supersedes");

    await board.hoverEdge();
    await board.edgeLabels().dblclick();
    const cleared = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/edges/${edge!.id}`));
    await page.getByPlaceholder("label…").fill("");
    await page.getByPlaceholder("label…").press("Enter");
    await cleared;
    await expect(board.edgeLabels()).toHaveText("+");
    expect((await board.saved()).edges[0].label).toBe("");
  });

  test("label edits are undoable", async ({ page, account }) => {
    void account;
    const { board } = await twoCards(page, { linked: true, label: "first" });
    await board.hoverEdge();
    await board.edgeLabels().dblclick();
    await page.getByPlaceholder("label…").fill("second");
    await page.getByPlaceholder("label…").press("Enter");
    await expect(board.edgeLabels()).toHaveText("second");

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(board.edgeLabels()).toHaveText("first");
    await expect.poll(async () => (await board.saved()).edges[0].label).toBe("first");
  });
});

test.describe("flipping, removing and re-attaching links", () => {
  test("hovering a link shows its controls; flip toggles side-to-side and top-to-bottom", async ({ page, account }) => {
    void account;
    const { board } = await twoCards(page, { linked: true, label: "then" });
    await board.hoverEdge();
    const flip = page.getByRole("button", { name: "Flip link direction" });
    await expect(flip).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove link" })).toBeVisible();

    await flip.click();
    await expect.poll(async () => (await board.saved()).edges[0]).toMatchObject({ source_handle: "bottom", target_handle: "top" });
    await board.hoverEdge();
    await page.getByRole("button", { name: "Flip link direction" }).click();
    await expect.poll(async () => (await board.saved()).edges[0]).toMatchObject({ source_handle: "right", target_handle: "left" });
  });

  test("Remove link deletes it everywhere", async ({ page, account }) => {
    void account;
    const { board } = await twoCards(page, { linked: true, label: "blocks" });
    await board.hoverEdge();
    await page.getByRole("button", { name: "Remove link" }).click();

    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await expect.poll(async () => (await board.saved()).edges.length).toBe(0);
    await page.reload();
    await board.ready();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  });

  test("undoing a link removal restores it, label included", async ({ page, account }) => {
    void account;
    const { board, edge } = await twoCards(page, { linked: true, label: "blocks" });
    await board.hoverEdge();
    await page.getByRole("button", { name: "Remove link" }).click();
    await expect.poll(async () => (await board.saved()).edges.length).toBe(0);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(board.edgeLabels()).toHaveText("blocks");
    await expect.poll(async () => (await board.saved()).edges.map((e) => [e.id, e.label])).toEqual([[edge!.id, "blocks"]]);
  });

  test("undoing and redoing a new link", async ({ page, account }) => {
    void account;
    const { board, a, b } = await twoCards(page);
    await board.link(a.id, "right", b.id, "left");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await expect.poll(async () => (await board.saved()).edges.length).toBe(0);

    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect.poll(async () => (await board.saved()).edges.length).toBe(1);
  });

  test("dragging a link's end onto another card's handle re-attaches it (and is undoable)", async ({ page, account }) => {
    void account;
    const { board, record, a, b, edge } = await twoCards(page, { linked: true });
    const c = await createNode(page.request, record.id, { title: "Gamma", x: 500, y: 300 });
    await board.open();

    const grab = (await board.edgeEnd("target").boundingBox())!;
    const dest = (await board.handle(c.id, "left").boundingBox())!;
    await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(dest.x + 4, dest.y + 4, { steps: 10 });
    await page.mouse.up();

    await expect.poll(async () => (await board.saved()).edges[0]).toMatchObject({
      id: edge!.id, source_id: a.id, target_id: c.id, target_handle: "left",
    });

    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (await board.saved()).edges[0]).toMatchObject({ id: edge!.id, source_id: a.id, target_id: b.id });
  });
});
