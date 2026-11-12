import { test, expect } from "../../fixtures";
import { createBoard, createNode, trash } from "../../support/api";
import { Board } from "../../support/board";
import { pasteImage, PIXEL_PNG } from "../../support/files";
import { TrashDialog } from "../../support/trash";
import type { APIRequestContext } from "@playwright/test";

// Pasted images live in R2 (`IMAGES`), keyed by a random name, and are served
// at /api/images/<key> to any signed-in person who has the key. Deleting what
// holds an image files the object for deletion after the retention window
// (worker/src/r2trash.ts); the cron reaps it. These specs pin down what a
// person can observe: the image stays reachable after the node is gone.

async function uploadImage(request: APIRequestContext) {
  const res = await request.post("/api/images", { data: PIXEL_PNG, headers: { "content-type": "image/png" } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { key: string; url: string };
}

const status = async (request: APIRequestContext, url: string) => (await request.get(new URL(url).pathname)).status();

test.describe("images and their nodes", () => {
  test("an uploaded image needs a signed-in session, and only image types are accepted", async ({ page, account, playwright, baseURL }) => {
    void account;
    const img = await uploadImage(page.request);
    const anon = await playwright.request.newContext({ baseURL });
    expect((await anon.get(new URL(img.url).pathname)).status()).toBe(401);
    expect((await anon.post("/api/images", { data: PIXEL_PNG, headers: { "content-type": "image/png" } })).status()).toBe(401);
    expect((await page.request.post("/api/images", { data: "x", headers: { "content-type": "text/html" } })).status()).toBe(415);
    expect((await page.request.get("/api/images/00000000-0000-0000-0000-000000000000.png")).status()).toBe(404);
    await anon.dispose();
  });

  test("deleting a pasted image from the board files it in the trash, and Restore brings the image back", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page, "Pasted");
    const made = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/nodes") && r.status() === 201);
    await pasteImage(page, "shot.png");
    const node = await (await made).json();
    const url = String(node.data.url);

    await board.node(node.id).hover();
    await board.deleteButton(node.id).click();
    await expect(board.node(node.id)).toHaveCount(0);
    await expect.poll(async () => (await trash(page.request)).map((t) => t.label)).toContain("shot.png");
    // still served while it is in the trash: that is what lets Restore work
    expect(await status(page.request, url)).toBe(200);

    const dialog = await new TrashDialog(page).open();
    await dialog.row("shot.png").getByRole("button", { name: "Restore" }).click();
    await expect(board.node(node.id).locator("img")).toHaveCount(1);
    await expect.poll(() => board.node(node.id).locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1);
  });
});

test.describe("known problems with image clean-up", () => {
  test.fixme("an image embedded in a card's text is gone once the card is permanently deleted", async ({ page, account }) => {
    // Expected: when a card is deleted and then removed from the trash for
    // good, the images its text refers to stop being served (and are
    // eventually deleted from R2). Actual: only nodes of type `image` file
    // their object (trashObjectsFor in worker/src/trash.ts); an image uploaded
    // through a card's editor (POST /api/images, then referenced by URL from
    // the card's markdown) is tracked by nothing, so it stays in the bucket and
    // stays reachable by its URL forever. Observed by uploading an image,
    // referencing it in a card body, deleting the card, emptying the trash and
    // fetching the URL: still 200.
    void account;
    const img = await uploadImage(page.request);
    const board = await createBoard(page.request, "Doc images");
    const card = await createNode(page.request, board.id, { title: "With picture", body: `![pic](${img.url})`, x: 0, y: 0 });
    expect(await status(page.request, img.url)).toBe(200);

    expect((await page.request.delete(`/api/nodes/${card.id}`)).ok()).toBe(true);
    expect((await page.request.post("/api/trash/empty")).ok()).toBe(true);
    expect(await status(page.request, img.url)).toBe(404);
  });

  test.fixme("a pasted image is gone once its trash entry is emptied for good", async ({ page, account }) => {
    // Expected: "Empty trash" is permanent, and the image object goes with it.
    // Actual: emptying the trash deletes the `trash` rows only. The object's
    // own deletion order (`r2_trash`) is dated from when the node was deleted
    // and is carried out by the weekly cron, so for up to the retention window
    // the image is still served from /api/images/<key> after the person
    // confirmed "Delete all". Observed by pasting an image, deleting it,
    // emptying the trash and fetching the URL: 200.
    void account;
    const { board } = await Board.create(page, "Pasted and emptied");
    const made = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/nodes") && r.status() === 201);
    await pasteImage(page, "gone.png");
    const node = await (await made).json();
    await board.node(node.id).hover();
    await board.deleteButton(node.id).click();
    await expect(board.node(node.id)).toHaveCount(0);

    const dialog = await new TrashDialog(page).open();
    await dialog.root.getByRole("button", { name: "Empty trash" }).click();
    await dialog.root.getByRole("button", { name: "Delete all" }).click();
    await expect(dialog.rows()).toHaveCount(0);

    expect(await status(page.request, String(node.data.url))).toBe(404);
  });
});
