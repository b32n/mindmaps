import { test, expect } from "../../fixtures";
import { Board } from "../../support/board";
import { createNode, nodeById } from "../../support/api";

// Markdown is the document format: `nodes.body` is what the editor loads, what
// it saves, what search reads and what an agent writes over MCP. These specs
// seed bodies through the API (as an agent would) and check what a person sees.

async function openCardWith(page: import("@playwright/test").Page, body: string, title = "Doc") {
  const { board, record } = await Board.create(page);
  const card = await createNode(page.request, record.id, { type: "card", title, body, x: 80, y: 80 });
  await board.open();
  return { board, card };
}

const RICH = [
  "# Heading one",
  "",
  "## Heading two",
  "",
  "### Heading three",
  "",
  "Plain with **bold**, *italic*, ~~struck~~ and `inline code`.",
  "",
  "> a quoted line",
  "",
  "- apple",
  "- pear",
  "",
  "1. first",
  "2. second",
  "",
  "---",
  "",
  "[a link](https://example.com/docs)",
].join("\n");

test.describe("rendering", () => {
  test("headings, emphasis, quotes, lists, rules and links", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, RICH);
    await board.openCard(card.id);
    const doc = board.editor;

    await expect(doc.locator("h1")).toHaveText("Heading one");
    await expect(doc.locator("h2")).toHaveText("Heading two");
    await expect(doc.locator("h3")).toHaveText("Heading three");
    await expect(doc.locator("p strong")).toHaveText("bold");
    await expect(doc.locator("p em")).toHaveText("italic");
    await expect(doc.locator("p del")).toHaveText("struck");
    await expect(doc.locator("p code")).toHaveText("inline code");
    await expect(doc.locator("blockquote")).toContainText("a quoted line");
    await expect(doc.locator("ul > .milkdown-list-item-block")).toHaveCount(2);
    await expect(doc.locator("ul .content-dom p")).toHaveText(["apple", "pear"]);
    await expect(doc.locator("ol .content-dom p")).toHaveText(["first", "second"]);
    await expect(doc.locator("ol .label")).toHaveText(["1.", "2."]);
    await expect(doc.locator("hr")).toHaveCount(1);
    await expect(doc.getByRole("link", { name: "a link" })).toHaveAttribute("href", "https://example.com/docs");
  });

  test("fenced code keeps its language and its text verbatim", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, "```ts\nconst answer: number = 6 * 7;\n  indented();\n```");
    await board.openCard(card.id);
    const code = board.editor.locator("pre[data-language='ts'] code");
    await expect(code).toHaveText("const answer: number = 6 * 7;\n  indented();");
  });

  test("tables render a header row and body cells", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, "| name | role |\n| --- | --- |\n| Ada | author |\n| Grace | reviewer |");
    await board.openCard(card.id);
    const table = board.editor.locator("table");
    await expect(table.locator("th")).toHaveText(["name", "role"]);
    await expect(table.locator("tr:not([data-is-header]) td")).toHaveText(["Ada", "author", "Grace", "reviewer"]);
  });

  test("images render from their URL", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, "![a diagram](https://example.invalid/diagram.png)");
    await board.openCard(card.id);
    await expect(board.editor.locator("img[data-type='image-block']")).toHaveAttribute(
      "src",
      "https://example.invalid/diagram.png",
    );
  });

  test("an uploaded image is stored by the app and renders in the document", async ({ page, account }) => {
    void account;
    // what the image block's upload does: POST the bytes, put the URL in markdown
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const up = await page.request.post("/api/images", { data: png, headers: { "content-type": "image/png" } });
    expect(up.status()).toBe(201);
    const { url } = await up.json();

    const { board, card } = await openCardWith(page, `![pixel](${url})`);
    await board.openCard(card.id);
    const img = board.editor.locator("img[data-type='image-block']");
    await expect(img).toHaveAttribute("src", url);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
  });

  test("raw HTML in a document is not executed", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, 'before\n\n<img src=x onerror="window.__pwned = true">\n\nafter');
    await board.openCard(card.id);
    await expect(board.editor).toContainText("before");
    expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  });
});

test.describe("checklists", () => {
  const LIST = "- [ ] write the spec\n- [x] read the code\n- [ ] ship it";

  test("show their state, and the closed card shows progress", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, LIST);
    await expect(board.node(card.id).locator(".chip.kids")).toHaveText("1/3 done");

    await board.openCard(card.id);
    await expect(board.editor.locator(".label.unchecked")).toHaveCount(2);
    await expect(board.editor.locator(".label.checked")).toHaveCount(1);
  });

  test("ticking a box is saved immediately, updates the chip, and survives a reload", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, LIST);
    await board.openCard(card.id);

    // (the first click into a document also re-saves it once, unchanged but for
    // trailing blank lines, so wait for the save that carries the tick)
    const saved = board.savedField(card.id, "body", /\[x\] write the spec/);
    await board.editor.locator(".milkdown-list-item-block", { hasText: "write the spec" }).locator(".label").click();
    await saved;
    expect((await nodeById(page.request, card.id)).body.trimEnd()).toBe(
      "- [x] write the spec\n- [x] read the code\n- [ ] ship it",
    );
    await board.closeCard();
    await expect(board.node(card.id).locator(".chip.kids")).toHaveText("2/3 done");

    await page.reload();
    await expect(board.node(card.id).locator(".chip.kids")).toHaveText("2/3 done");
    await board.openCard(card.id);
    await expect(board.editor.locator(".label.checked")).toHaveCount(2);
  });

  test("unticking works the same way, and finishing the list marks the chip complete", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, "- [x] one\n- [ ] two");
    await board.openCard(card.id);

    const first = board.savedField(card.id, "body", /\[ \] one/);
    await board.editor.locator(".milkdown-list-item-block", { hasText: "one" }).locator(".label").click();
    await first;
    expect((await nodeById(page.request, card.id)).body.trimEnd()).toBe("- [ ] one\n- [ ] two");

    const both = board.savedField(card.id, "body", /\[x\] one\n- \[x\] two/);
    await board.editor.locator(".label").first().click();
    await board.editor.locator(".label").nth(1).click();
    await both;
    await expect.poll(async () => (await nodeById(page.request, card.id)).body.trimEnd()).toBe("- [x] one\n- [x] two");
    await board.closeCard();
    await expect(board.node(card.id).locator(".chip.kids")).toHaveText("2/2 done");
    await expect(board.node(card.id).locator(".chip.kids")).toHaveClass(/complete/);
  });

  test("a checkbox written inside a code fence is not a task", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, "- [ ] real\n\n```\n- [ ] not a task\n- [x] nor this\n```");
    await expect(board.node(card.id).locator(".chip.kids")).toHaveText("0/1 done");
  });

  test("a document with no checklist shows no progress chip", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, "just prose");
    await expect(board.node(card.id).locator(".chip.kids")).toHaveCount(0);
  });
});

test.describe("the closed card's preview", () => {
  test("shows the words, not the markdown syntax", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(
      page,
      "# Title\n\nSome **bold** text and a [link](https://x.test).\n\n- a\n- b\n\n> quoted\n\n```\nhidden code\n```",
    );
    await expect(board.node(card.id).locator(".card-preview")).toHaveText("Title Some bold text and a link. a b quoted");
  });

  test("table cells are joined, images are dropped", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, "| a | b |\n|---|---|\n| 1 | 2 |\n\n![alt](https://x.test/i.png)\n\nend");
    await expect(board.node(card.id).locator(".card-preview")).toHaveText("a · b 1 · 2 end");
  });

  test("a card with an empty document has no preview line", async ({ page, account }) => {
    void account;
    const { board, card } = await openCardWith(page, "");
    await expect(board.node(card.id).locator(".card-preview")).toHaveCount(0);
  });
});
