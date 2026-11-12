import { test, expect } from "../../fixtures";
import { createArtefact, createBoard, listFiles, nodeById, trash, uploadFile } from "../../support/api";
import { Board } from "../../support/board";
import { PIXEL_PNG, PIXEL_PNG_BASE64 } from "../../support/files";
import type { Page } from "@playwright/test";

// Files and folders. A `file` node holds one file, a `folder` holds many. They
// open on /file/:id, where a file is staged (chosen or dropped), described and
// then uploaded. Downloads come from signed URLs on /f/:id.

async function empty(page: Page, type: "file" | "folder") {
  const board = await createBoard(page.request, "Files");
  const node = await createArtefact(page.request, board.id, type, { title: type === "file" ? "Report" : "Docs" });
  await page.goto(`/file/${node.id}?from=${board.id}`);
  await expect(page.getByText("Drop a file here")).toBeVisible();
  return { board, node };
}

const chooser = (page: Page) => page.locator(".file-drop input[type=file]");
const rows = (page: Page) => page.locator(".file-row");

/** Click Upload and wait for the server's answer. */
async function upload(page: Page, nodeId: string) {
  const done = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/nodes/${nodeId}/files`));
  await page.getByRole("button", { name: "Upload" }).click();
  return done;
}

test.describe("adding files and folders from the dock", () => {
  test("Add file and Add folder make nodes that say what they are and that they are empty", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page, "Dock files");
    const file = await board.addVia(() => page.getByRole("button", { name: "Add file" }).click());
    const folder = await board.addVia(() => page.getByRole("button", { name: "Add folder" }).click());
    await expect(board.node(file).locator(".artefact-kind")).toHaveText("File");
    await expect(board.node(file).locator(".card-preview")).toHaveText("Empty");
    await expect(board.node(folder).locator(".artefact-kind")).toHaveText("Folder");
    await expect(board.node(folder).locator(".card-preview")).toHaveText("Empty");
    expect(board.node(file).getByRole("link", { name: "Open" })).toHaveAttribute("href", /^\/file\//);
  });
});

test.describe("uploading with the file chooser", () => {
  test("a text file needs no description: it uploads, is listed with its size, and its text is indexed", async ({ page, account }) => {
    void account;
    const { node } = await empty(page, "file");
    await chooser(page).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("quarterly findings\nsecond line") });
    await expect(page.getByPlaceholder(/Optional — its text is already indexed/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload" })).toBeEnabled();

    expect((await upload(page, node.id)).status()).toBe(201);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().locator(".file-name")).toHaveText("notes.txt");
    await expect(rows(page).first().locator(".file-meta").first()).toHaveText("1 kB");
    // a `file` holds one: the chooser is gone
    await expect(page.getByText("Add another file")).toHaveCount(0);
    await expect(chooser(page)).toHaveCount(0);

    const stored = await nodeById(page.request, node.id);
    expect(stored.data).toMatchObject({ kind: "file", files: 1, name: "notes.txt", contentType: "text/plain" });
    expect(stored.body).toContain("quarterly findings");
  });

  test("a binary file must be described first, and the description is what gets indexed", async ({ page, account }) => {
    void account;
    const { node } = await empty(page, "folder");
    await chooser(page).setInputFiles({ name: "model.bin", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3, 4]) });
    const go = page.getByRole("button", { name: "Upload" });
    await expect(page.getByText("We cannot read text out of this one")).toBeVisible();
    await expect(go).toBeDisabled();
    await page.getByPlaceholder(/What is this\? One line/).fill("Trained weights for the ranking model");
    await expect(go).toBeEnabled();

    expect((await upload(page, node.id)).status()).toBe(201);
    await expect(rows(page).first().locator(".file-desc")).toHaveText("Trained weights for the ranking model");
    expect((await nodeById(page.request, node.id)).body).toContain("Trained weights for the ranking model");
  });

  test("Cancel drops the staged file and returns to the chooser; nothing is uploaded", async ({ page, account }) => {
    void account;
    const { node } = await empty(page, "folder");
    await chooser(page).setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") });
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Drop a file here")).toBeVisible();
    expect(await listFiles(page.request, node.id)).toEqual([]);
  });

  test("a folder takes several files, newest last, and the chooser stays", async ({ page, account }) => {
    void account;
    const { node } = await empty(page, "folder");
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      await chooser(page).setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(`${name} body`) });
      expect((await upload(page, node.id)).status()).toBe(201);
      await expect(rows(page).filter({ hasText: name })).toHaveCount(1);
    }
    await expect(rows(page).locator(".file-name")).toHaveText(["one.txt", "two.txt", "three.txt"]);
    await expect(page.getByText("Add another file")).toBeVisible();
    expect((await nodeById(page.request, node.id)).data).toMatchObject({ kind: "folder", files: 3 });
  });

  test("a file over the size limit is refused before anything is sent", async ({ page, account }) => {
    void account;
    const { node } = await empty(page, "folder");
    await chooser(page).setInputFiles({ name: "huge.txt", mimeType: "text/plain", buffer: Buffer.alloc(50_000_001, 97) });
    await expect(page.getByText("over the 50 MB limit")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(await listFiles(page.request, node.id)).toEqual([]);
  });

  test("names with spaces and non-Latin characters survive the round trip", async ({ page, account }) => {
    void account;
    const { node } = await empty(page, "folder");
    await chooser(page).setInputFiles({ name: "Résumé 最終.txt", mimeType: "text/plain", buffer: Buffer.from("cv") });
    expect((await upload(page, node.id)).status()).toBe(201);
    await expect(rows(page).first().locator(".file-name")).toHaveText("Résumé 最終.txt");
    expect((await listFiles(page.request, node.id))[0].name).toBe("Résumé 最終.txt");
  });
});

test.describe("uploading by drag and drop", () => {
  test("dropping a file on the drop zone stages it exactly as choosing it does", async ({ page, account }) => {
    void account;
    const { node } = await empty(page, "folder");
    await page.locator(".file-drop").evaluate((zone) => {
      const data = new DataTransfer();
      data.items.add(new File(["dropped words"], "dropped.txt", { type: "text/plain" }));
      zone.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
      zone.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".file-stage .file-name")).toHaveText("dropped.txt");
    expect((await upload(page, node.id)).status()).toBe(201);
    await expect(rows(page).first().locator(".file-name")).toHaveText("dropped.txt");
    expect((await nodeById(page.request, node.id)).body).toContain("dropped words");
  });

  test("the zone lights up while a file is dragged over it", async ({ page, account }) => {
    void account;
    await empty(page, "folder");
    await page.locator(".file-drop").evaluate((zone) => {
      zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".file-drop")).toHaveClass(/over/);
  });

  test("only the first of several dropped files is taken", async ({ page, account }) => {
    void account;
    await empty(page, "folder");
    await page.locator(".file-drop").evaluate((zone) => {
      const data = new DataTransfer();
      data.items.add(new File(["1"], "first.txt", { type: "text/plain" }));
      data.items.add(new File(["2"], "second.txt", { type: "text/plain" }));
      zone.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".file-stage .file-name")).toHaveText("first.txt");
  });
});

test.describe("opening and downloading", () => {
  test("a text file is handed over as an attachment with its exact bytes and its name", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Downloads");
    const node = await createArtefact(page.request, board.id, "file", { title: "Notes" });
    expect((await uploadFile(page.request, node.id, { name: "notes.txt", type: "text/plain", data: "exact bytes ✓" })).status()).toBe(201);
    await page.goto(`/file/${node.id}`);
    const open = rows(page).first().getByRole("link", { name: "Open" });
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("href", /^\/f\/[0-9a-f-]{36}\?exp=\d+&sig=[0-9a-f]{64}$/);

    const res = await page.request.get((await open.getAttribute("href"))!);
    expect(res.status()).toBe(200);
    expect(await res.text()).toBe("exact bytes ✓");
    const h = res.headers();
    expect(h["content-type"]).toBe("text/plain");
    expect(h["content-disposition"]).toBe('attachment; filename="notes.txt"');
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(h["cache-control"]).toBe("private, no-store");
  });

  test("a PNG opens inline in a new tab", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Previews");
    const node = await createArtefact(page.request, board.id, "file", { title: "Pixel" });
    expect((await uploadFile(page.request, node.id, { name: "pixel.png", type: "image/png", data: PIXEL_PNG, description: "A single pixel" })).status()).toBe(201);
    await page.goto(`/file/${node.id}`);

    const popup = page.context().waitForEvent("page");
    await rows(page).first().getByRole("link", { name: "Open" }).click();
    const tab = await popup;
    await expect(tab).toHaveURL(/\/f\/[0-9a-f-]{36}\?exp=/);
    await expect(tab.locator("img")).toBeVisible();
    const res = await page.request.get((await rows(page).first().getByRole("link", { name: "Open" }).getAttribute("href"))!);
    expect(res.headers()["content-disposition"]).toBe('inline; filename="pixel.png"');
    expect((await res.body()).toString("base64")).toBe(PIXEL_PNG_BASE64);
  });

  test("HEAD works and POST is refused on the download path", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Methods");
    const node = await createArtefact(page.request, board.id, "file", { title: "M" });
    await uploadFile(page.request, node.id, { name: "m.txt", type: "text/plain", data: "m" });
    const url = (await listFiles(page.request, node.id))[0].url!;
    expect((await page.request.head(url)).status()).toBe(200);
    expect((await page.request.post(url)).status()).toBe(405);
  });
});

test.describe("renaming and deleting", () => {
  test("× asks first; Cancel keeps the file, OK removes it and its download stops working", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Deleting");
    const node = await createArtefact(page.request, board.id, "folder", { title: "Folder" });
    await uploadFile(page.request, node.id, { name: "keep.txt", type: "text/plain", data: "keep" });
    await uploadFile(page.request, node.id, { name: "drop.txt", type: "text/plain", data: "drop" });
    const [, dropped] = await listFiles(page.request, node.id);
    await page.goto(`/file/${node.id}`);
    await expect(rows(page)).toHaveCount(2);

    page.once("dialog", (d) => {
      expect(d.message()).toBe("Delete drop.txt? It can be restored for seven days.");
      void d.dismiss();
    });
    await rows(page).filter({ hasText: "drop.txt" }).getByTitle("Delete").click();
    await expect(rows(page)).toHaveCount(2);

    page.once("dialog", (d) => void d.accept());
    const gone = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/files/"));
    await rows(page).filter({ hasText: "drop.txt" }).getByTitle("Delete").click();
    expect((await gone).ok()).toBe(true);
    await expect(rows(page).locator(".file-name")).toHaveText(["keep.txt"]);
    expect((await page.request.get(dropped.url!)).status()).toBe(404);
    expect((await nodeById(page.request, node.id)).data).toMatchObject({ files: 1 });
  });

  test("a file can be renamed or re-described through the API (the page has no control for it)", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Renaming");
    const node = await createArtefact(page.request, board.id, "folder", { title: "F" });
    await uploadFile(page.request, node.id, { name: "old.txt", type: "text/plain", data: "x" });
    const [file] = await listFiles(page.request, node.id);
    expect((await page.request.patch(`/api/files/${file.id}`, { data: { name: "new.txt", description: "now described" } })).ok()).toBe(true);
    expect((await listFiles(page.request, node.id))[0]).toMatchObject({ name: "new.txt", description: "now described" });
    expect((await page.request.patch(`/api/files/${file.id}`, { data: { name: "   " } })).status()).toBe(400);
    expect((await nodeById(page.request, node.id)).body).toContain("now described");
  });

  test("deleting the folder node moves it to the trash; restoring brings its files back, downloadable", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Trash files");
    const node = await createArtefact(page.request, board.id, "folder", { title: "Recoverable" });
    await uploadFile(page.request, node.id, { name: "keep.txt", type: "text/plain", data: "still here" });
    expect((await page.request.delete(`/api/nodes/${node.id}`)).ok()).toBe(true);
    expect((await page.request.get(`/api/nodes/${node.id}/files`)).status()).toBe(404);

    const entry = (await trash(page.request)).find((t) => t.label === "Recoverable");
    expect(entry?.node_type).toBe("folder");
    expect((await page.request.post(`/api/trash/${entry!.id}/restore`)).ok()).toBe(true);

    const [file] = await listFiles(page.request, node.id);
    expect(file.name).toBe("keep.txt");
    expect(await (await page.request.get(file.url!)).text()).toBe("still here");
  });

  test("files and folders appear in the Artefacts list with their kind", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Listed");
    await createArtefact(page.request, board.id, "folder", { title: "Listed folder" });
    await page.goto("/artefacts");
    const row = page.locator(".arte-tr", { hasText: "Listed folder" });
    await expect(row).toBeVisible();
    await expect(row.locator("a.arte-name")).toHaveAttribute("href", new RegExp(`^/file/`));
  });
});

test.describe("who can add and see files", () => {
  test("a viewer lists and downloads but cannot upload, rename or delete; an editor can add", async ({ page, account, existing }) => {
    void account;
    const board = await createBoard(page.request, "Shared files");
    const node = await createArtefact(page.request, board.id, "folder", { title: "Shared" });
    await uploadFile(page.request, node.id, { name: "a.txt", type: "text/plain", data: "a" });
    const [file] = await listFiles(page.request, node.id);
    await page.request.post(`/api/artefacts/${node.id}/members`, { data: { email: existing.user.email, role: "viewer" } });
    const v = existing.request;

    const seen = await listFiles(v, node.id);
    expect(seen.map((f) => f.name)).toEqual(["a.txt"]);
    expect(await (await v.get(seen[0].url!)).text()).toBe("a");
    expect((await uploadFile(v, node.id, { name: "b.txt", type: "text/plain", data: "b" })).status()).toBe(403);
    expect((await v.patch(`/api/files/${file.id}`, { data: { name: "x" } })).status()).toBe(403);
    expect((await v.delete(`/api/files/${file.id}`)).status()).toBe(403);

    await page.request.post(`/api/artefacts/${node.id}/members`, { data: { email: existing.user.email, role: "editor" } });
    expect((await uploadFile(v, node.id, { name: "b.txt", type: "text/plain", data: "b" })).status()).toBe(201);
    expect((await listFiles(page.request, node.id)).map((f) => f.name).sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("uploads must name the file, name a file node, and a file node holds one file", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Rules");
    const file = await createArtefact(page.request, board.id, "file", { title: "Single" });
    const card = await (await page.request.post("/api/nodes", { data: { board_id: board.id, type: "card", title: "c" } })).json();
    const raw = (id: string, headers: Record<string, string>) =>
      page.request.post(`/api/nodes/${id}/files`, { data: Buffer.from("x"), headers: { "content-type": "text/plain", ...headers } });

    expect((await raw(file.id, {})).status()).toBe(400); // x-file-name is required
    expect((await raw(card.id, { "x-file-name": "a.txt" })).status()).toBe(400); // not a file node
    expect((await raw(file.id, { "x-file-name": "a.txt" })).status()).toBe(201);
    expect((await raw(file.id, { "x-file-name": "b.txt" })).status()).toBe(409); // already holds one
  });
});
