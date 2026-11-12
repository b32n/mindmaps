import { test, expect } from "../../fixtures";
import { createArtefact, createBoard, nodeById } from "../../support/api";
import { Board } from "../../support/board";
import type { Page } from "@playwright/test";

// Documents and decks: created from the dock, opened in their own tab, edited
// in the real editors, saved by autosave.

async function docOn(page: Page) {
  const board = await createBoard(page.request, "Writing");
  const doc = await createArtefact(page.request, board.id, "doc", {
    title: "Plan",
    blocks: [{ heading: "Why now", level: 2 }, { text: "hello doc text" }, { bullet: "one" }],
  });
  return { board, doc };
}

async function deckOn(page: Page) {
  const board = await createBoard(page.request, "Presenting");
  const deck = await createArtefact(page.request, board.id, "deck", {
    title: "Review",
    slides: [{ title: "Slide one", bullets: ["b1"], notes: "my notes" }, { title: "Slide two" }],
  });
  return { board, deck };
}

const saveOf = (page: Page, id: string) =>
  page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/artefacts/${id}`) && r.ok());

test.describe("documents", () => {
  test("the dock's Add document makes a Doc node; its summary counts words", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page, "Dock doc");
    const id = await board.addVia(() => page.getByRole("button", { name: "Add document" }).click());
    await expect(board.node(id).locator(".artefact-kind")).toHaveText("Doc");
    await expect(board.node(id).locator("input.card-title")).toHaveAttribute("placeholder", "Untitled doc");
    await expect(board.node(id).locator(".card-preview")).toHaveText("0 words");
  });

  test("opens with its blocks, a title and a Saved state; the card on the board reads its word count", async ({ page, account }) => {
    void account;
    const { board, doc } = await docOn(page);
    await page.goto(`/app/${board.id}`);
    await expect(page.locator(`.react-flow__node[data-id="${doc.id}"] .card-preview`)).toHaveText("6 words");

    await page.goto(`/doc/${doc.id}?from=${board.id}`);
    await expect(page.locator("input.sheet-title")).toHaveValue("Plan");
    for (const text of ["Why now", "hello doc text", "one"]) await expect(page.locator(".ProseMirror")).toContainText(text);
    await expect(page.locator(".sheet-state")).toHaveText("Saved");
  });

  test("typing saves by itself: the text is stored, and the search snapshot follows", async ({ page, account }) => {
    void account;
    const { doc } = await docOn(page);
    await page.goto(`/doc/${doc.id}`);
    const editor = page.locator(".ProseMirror");
    await expect(editor).toContainText("hello doc text");
    await editor.focus();
    await page.keyboard.press("Control+End");
    const saved = saveOf(page, doc.id);
    await page.keyboard.type(" and an addition");
    await saved;
    await expect(page.locator(".sheet-state")).toHaveText("Saved");

    const payload = JSON.stringify(await (await page.request.get(`/api/artefacts/${doc.id}`)).json());
    expect(payload).toContain("an addition");
    expect((await nodeById(page.request, doc.id)).body).toContain("an addition");

    await page.reload();
    await expect(page.locator(".ProseMirror")).toContainText("an addition");
  });
});

test.describe("decks", () => {
  test("the dock's Add deck makes a Deck node; its summary counts slides", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page, "Dock deck");
    const id = await board.addVia(() => page.getByRole("button", { name: "Add deck" }).click());
    await expect(board.node(id).locator(".artefact-kind")).toHaveText("Deck");
    await expect(board.node(id).locator(".card-preview")).toHaveText("1 slide");
  });

  test("opens with its slides and speaker notes", async ({ page, account }) => {
    void account;
    const { board, deck } = await deckOn(page);
    await page.goto(`/app/${board.id}`);
    await expect(page.locator(`.react-flow__node[data-id="${deck.id}"] .card-preview`)).toHaveText("2 slides");

    await page.goto(`/deck/${deck.id}?from=${board.id}`);
    await expect(page.locator("input.sheet-title")).toHaveValue("Review");
    await expect(page.getByText("Slide two").first()).toBeVisible();
    await expect(page.getByPlaceholder("Add notes for the presenter…")).toHaveValue("my notes");
  });

  test("speaker notes typed in the editor are saved and indexed", async ({ page, account }) => {
    void account;
    const { deck } = await deckOn(page);
    await page.goto(`/deck/${deck.id}`);
    const notes = page.getByPlaceholder("Add notes for the presenter…");
    await expect(notes).toHaveValue("my notes");
    const saved = saveOf(page, deck.id);
    await notes.fill("rewritten notes");
    await saved;
    await expect(page.locator(".sheet-state")).toHaveText("Saved");

    expect(JSON.stringify(await (await page.request.get(`/api/artefacts/${deck.id}`)).json())).toContain("rewritten notes");
    const body = (await nodeById(page.request, deck.id)).body;
    expect(body).toContain("rewritten notes");
    expect(body).not.toContain("my notes");
  });

  test("renaming a deck in the editor renames its node", async ({ page, account }) => {
    void account;
    const { deck } = await deckOn(page);
    await page.goto(`/deck/${deck.id}`);
    const renamed = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/nodes/${deck.id}`) && r.ok());
    await page.locator("input.sheet-title").fill("Board review");
    await renamed;
    expect((await nodeById(page.request, deck.id)).title).toBe("Board review");
  });
});
