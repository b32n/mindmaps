import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import { createNode, nodeById } from "../../support/api";

/** The saved markdown. The editor ends what it writes with a newline; that is not what these tests are about. */
async function savedBody(page: import("@playwright/test").Page, id: string) {
  return (await nodeById(page.request, id)).body.trimEnd();
}

async function boardWithCard(page: import("@playwright/test").Page, node: Parameters<typeof createNode>[2] = {}) {
  const { board, record } = await Board.create(page);
  const card = await createNode(page.request, record.id, { type: "card", x: 80, y: 80, ...node });
  await board.open();
  return { board, card };
}

test.describe("card title", () => {
  test("typing a title saves it, and it is still there after a reload", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page);

    const saved = board.savedField(card.id, "title", "Cache invalidation");
    await board.title(card.id).fill("Cache invalidation");
    await saved;
    expect((await nodeById(page.request, card.id)).title).toBe("Cache invalidation");

    await page.reload();
    await expect(board.title(card.id)).toHaveValue("Cache invalidation");
  });

  test("leaving the field straight away still saves the last keystrokes", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page);

    const saved = board.savedField(card.id, "title", "Typed then blurred");
    await board.title(card.id).fill("Typed then blurred");
    await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } }); // blur
    await saved;
    expect((await nodeById(page.request, card.id)).title).toBe("Typed then blurred");
  });

  test("a title can be cleared again", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Temporary" });
    await expect(board.title(card.id)).toHaveValue("Temporary");

    const saved = board.savedField(card.id, "title", "");
    await board.title(card.id).fill("");
    await saved;
    await page.reload();
    await expect(board.title(card.id)).toHaveValue("");
    await expect(board.title(card.id)).toHaveAttribute("placeholder", "Untitled");
  });

  test("the title shown inside the open card is the same field and edits the face too", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Before" });
    await board.openCard(card.id);

    const docTitle = page.locator(".card-doc .doc-title");
    await expect(docTitle).toHaveValue("Before");
    const saved = board.savedField(card.id, "title", "After");
    await docTitle.fill("After");
    await saved;
    await board.closeCard();
    await expect(board.title(card.id)).toHaveValue("After");
  });

  test("a note's text is edited in place and saved as its title", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page);
    const note = await createNode(page.request, record.id, { type: "note", title: "", x: 50, y: 50 });
    await board.open();

    const saved = board.savedField(note.id, "title", "Remember the milk");
    await board.noteText(note.id).fill("Remember the milk");
    await saved;
    await page.reload();
    await expect(board.noteText(note.id)).toHaveValue("Remember the milk");
  });
});

test.describe("card document", () => {
  test("typed text lands in the saved body, shows as the card's preview, and survives a reload", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Doc" });
    await board.openCard(card.id);

    await board.editor.click();
    const saved = board.savedField(card.id, "body", "The cache is invalidated twice per write.");
    await page.keyboard.type("The cache is invalidated twice per write.");
    await saved;
    await expect(board.editor).toContainText("The cache is invalidated twice per write.");
    await board.closeCard();

    await expect(board.node(card.id).locator(".card-preview")).toHaveText("The cache is invalidated twice per write.");
    await page.reload();
    await expect(board.node(card.id).locator(".card-preview")).toHaveText("The cache is invalidated twice per write.");
    expect(await savedBody(page, card.id)).toBe("The cache is invalidated twice per write.");
  });

  test("an empty document shows the placeholder hint", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page);
    await board.openCard(card.id);
    await expect(board.editor.locator("p[data-placeholder], .crepe-placeholder").first()).toHaveAttribute(
      "data-placeholder",
      "Write, or press / for blocks",
    );
  });

  test("typing markdown shortcuts formats live and stores markdown", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page);
    await board.openCard(card.id);
    await board.editor.click();

    await page.keyboard.type("# Findings");
    await page.keyboard.press("Enter");
    await page.keyboard.type("It is **really** slow");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- ");
    // The "- " input rule turns the paragraph into a list item asynchronously;
    // typing on before it has landed puts the caret in the wrong place.
    await expect(board.editor.locator("li")).toHaveCount(1);
    await page.keyboard.type("first");
    await page.keyboard.press("Enter");
    await expect(board.editor.locator("li")).toHaveCount(2); // same: wait for the new item
    await page.keyboard.type("second");

    await expect(board.editor.locator("h1")).toHaveText("Findings");
    await expect(board.editor.locator("strong")).toHaveText("really");
    await expect(board.editor.locator("li")).toHaveCount(2);
    await expect.poll(() => savedBody(page, card.id)).toBe(
      "# Findings\n\nIt is **really** slow\n\n- first\n- second",
    );
  });

  test("the slash menu inserts blocks", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page);
    await board.openCard(card.id);
    await board.editor.click();

    await page.keyboard.type("/");
    const menu = page.locator(".milkdown-slash-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Heading 1");
    await expect(menu).toContainText("Bullet List");
    await expect(menu).toContainText("Code");
    await expect(menu).toContainText("Table");

    await menu.getByText("Heading 2", { exact: true }).click();
    await page.keyboard.type("Via the menu");
    await expect(board.editor.locator("h2")).toHaveText("Via the menu");
    await expect.poll(() => savedBody(page, card.id)).toBe("## Via the menu");
  });

  test("editing an existing document keeps the rest of it", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { body: "Line one\n\nLine two" });
    await board.openCard(card.id);
    await board.editor.getByText("Line two").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" extended");
    await expect.poll(() => savedBody(page, card.id)).toBe("Line one\n\nLine two extended");
  });

  test("opening and closing a card without editing it does not rewrite it", async ({ page, account }) => {
    void account;
    // Markers the editor would normalise (`*` bullets, `_` emphasis): an untouched
    // document must come back byte for byte, or every look at a card would churn it.
    const body = "* star bullet\n* another\n\nsome _emphasis_ here";
    const { board, card } = await boardWithCard(page, { body });
    const patches: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "PATCH" && r.url().includes("/api/nodes/")) patches.push(r.postData() ?? "");
    });

    await board.openCard(card.id);
    await expect(board.editor).toContainText("star bullet");
    await board.closeCard();

    expect(patches).toEqual([]);
    expect((await nodeById(page.request, card.id)).body).toBe(body);
  });
});

test.describe("opening and closing", () => {
  test("the Open button opens it in place and puts it in the URL; × closes and clears the URL", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Doc" });
    await board.openCard(card.id);
    await expect(page).toHaveURL(new RegExp(`\\?card=${card.id}$`));
    await board.closeCard();
    await expect(page).not.toHaveURL(/card=/);
  });

  test("Escape closes the open card", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page);
    await board.openCard(card.id);
    await page.keyboard.press("Escape");
    await expect(page.locator(".card-doc")).toHaveCount(0);
  });

  test("a reload brings the open card back (it lives in the URL)", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Doc", body: "still here" });
    await board.openCard(card.id);
    // wait for the app to have recorded it before reloading
    await expect(page).toHaveURL(/card=/);
    await page.reload();
    await expect(board.editor).toContainText("still here");
    await expect(page.locator(".card-doc .doc-title")).toHaveValue("Doc");
  });

  test("a link with ?card= opens that card on load", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Linked", body: "deep link body" });
    await page.goto(`/app/${board.id}?card=${card.id}`);
    await expect(board.editor).toContainText("deep link body");
  });

  test("a ?card= that is not on this board is ignored", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Only card" });
    await page.goto(`/app/${board.id}?card=00000000-0000-0000-0000-000000000000`);
    await expect(board.node(card.id)).toBeVisible();
    await expect(page.locator(".card-doc")).toHaveCount(0);
  });

  test("opening a second card closes the first: only one is open at a time", async ({ page, account }) => {
    void account;
    const { board, record } = await Board.create(page);
    const a = await createNode(page.request, record.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(page.request, record.id, { title: "B", x: 700, y: 0 });
    await board.open();
    await board.openCard(a.id);
    await board.settled();

    // Retried as a unit: a second Open that lands while the first card's glide
    // timer is still running can be swallowed (see Observations in the PR), and
    // the second attempt is then a clean one.
    await expect(async () => {
      await board.node(b.id).getByRole("button", { name: "Open" }).click();
      await expect(board.node(b.id).locator(".card-doc")).toBeVisible({ timeout: 1500 });
      await board.settled();
      await expect(board.node(b.id).locator(".card-doc")).toBeVisible({ timeout: 500 });
    }).toPass();

    await expect(page.locator(".card-doc")).toHaveCount(1);
    await expect(board.node(a.id).locator(".card-doc")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`card=${b.id}$`));
  });

  test("zooming the canvas closes the open card", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Doc" });
    await board.openCard(card.id);
    await expect(page).toHaveURL(/card=/);

    const pane = (await board.pane.boundingBox())!;
    await page.mouse.move(pane.x + 40, pane.y + 40);
    await page.keyboard.down("Control");
    // The card ignores zooms for the moment it takes to glide into place, so
    // keep zooming until it reacts rather than guessing how long that is.
    await expect(async () => {
      await page.mouse.wheel(0, -200);
      await expect(page.locator(".card-doc")).toHaveCount(0, { timeout: 300 });
    }).toPass();
    await page.keyboard.up("Control");
    await expect(page).not.toHaveURL(/card=/);
  });

  test("focus mode moves the document into a side panel and back", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Doc", body: "focus me" });
    await board.openCard(card.id);

    await page.getByTitle("Focus mode").click();
    await expect(page.locator(".focus-panel .doc-title")).toHaveValue("Doc");
    await expect(page.locator(".focus-panel .ProseMirror")).toContainText("focus me");
    await expect(board.node(card.id).locator(".card-doc")).toHaveCount(0);

    await page.getByTitle("Back to the board").click();
    await expect(page.locator(".focus-panel")).toHaveCount(0);
    await expect(board.node(card.id).locator(".card-doc .ProseMirror")).toContainText("focus me");
  });

  test("“open at the bottom” is a per-card setting that persists", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Log" });
    await board.openCard(card.id);

    const toggle = page.locator(".card-doc .doc-btn").first();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await nodeById(page.request, card.id)).data.open_at).toBe("bottom");

    await page.reload();
    await expect(page.locator(".card-doc .doc-btn").first()).toHaveAttribute("aria-pressed", "true");
  });

  // BUG: "Open at the bottom" never scrolls anything. CardDocument scrolls
  // `.doc-body` (its `body` ref), but that element is `overflow: hidden`; the
  // element that actually scrolls the document is `.md-doc` (overflow: auto),
  // which is left at scrollTop 0. Observed with a 60-paragraph card whose
  // data.open_at is "bottom": after opening, `.md-doc` has scrollTop 0 with
  // scrollHeight 1813 / clientHeight 421, so the last paragraph is out of view.
  test.fixme("a card set to open at the bottom scrolls its document to the end", async ({ page, account }) => {
    void account;
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph number ${i + 1}`).join("\n\n");
    const { board, card } = await boardWithCard(page, { title: "Long log", body: long, data: { open_at: "bottom" } });
    await board.openCard(card.id);
    await expect(board.editor.getByText("Paragraph number 60")).toBeInViewport();
  });
});

test.describe("research thread section", () => {
  test("is collapsed by default, opens to an explanation, and needs a prompt to start", async ({ page, account }) => {
    void account;
    const { board, card } = await boardWithCard(page, { title: "Doc" });
    await board.openCard(card.id);

    const toggle = page.getByRole("button", { name: /Research thread/ });
    await expect(page.locator(".thread-inner")).toHaveCount(0);
    await toggle.click();
    await expect(page.getByText("Runs in a remote Claude session")).toBeVisible();

    const start = page.getByRole("button", { name: /Start thread/ });
    await expect(start).toBeDisabled();
    await page.getByPlaceholder("Ask Claude to trace, compare, summarise…").fill("trace the cache");
    await expect(start).toBeEnabled();
  });
});
