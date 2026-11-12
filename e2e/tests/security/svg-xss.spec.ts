import { test, expect } from "../../fixtures";
import { createArtefact, createBoard, createNode, listFiles, uploadFile } from "../../support/api";
import { Board } from "../../support/board";
import type { Page } from "@playwright/test";

// An SVG is a document, and one that can carry script. It reaches the app two
// ways, and both must be safe when somebody navigates straight to the URL:
//   - as an image (POST /api/images, served from the app's own origin), and
//   - as an uploaded file (served from /f/<id>).
// "Safe" here is observed, not assumed: the payload below tries to raise a
// dialog and to make a request, and the tests assert that neither happened.

const PAYLOAD =
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="alert('xss-onload');fetch('/__xss?onload')">` +
  `<script>alert('xss-script');fetch('/__xss?script')</script>` +
  `<rect width="40" height="40" fill="red" onclick="alert('xss-click')"/></svg>`;

/** Records every dialog and every request to the marker path made by anything in the context. */
function watch(page: Page) {
  const seen = { dialogs: [] as string[], marker: [] as string[] };
  page.context().on("page", (p) => p.on("dialog", (d) => void d.dismiss()));
  page.on("dialog", (d) => {
    seen.dialogs.push(d.message());
    void d.dismiss();
  });
  page.context().on("request", (r) => {
    if (r.url().includes("/__xss")) seen.marker.push(r.url());
  });
  return seen;
}

async function uploadSvgImage(page: Page) {
  const res = await page.request.post("/api/images", { data: PAYLOAD, headers: { "content-type": "image/svg+xml" } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { key: string; url: string };
}

test.describe("an SVG stored as an image", () => {
  test("is served with a CSP that forbids script, a sandbox and nosniff", async ({ page, account }) => {
    void account;
    const img = await uploadSvgImage(page);
    const res = await page.request.get(new URL(img.url).pathname);
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["content-type"]).toBe("image/svg+xml");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(await res.text()).toContain("onload"); // stored verbatim: it is the headers that make it safe
  });

  test("opened as a page in the app's origin, its script does not run", async ({ page, account }) => {
    void account;
    const seen = watch(page);
    const img = await uploadSvgImage(page);
    await page.goto(new URL(img.url).pathname);
    await expect(page.locator("svg rect")).toBeVisible(); // it did load as a document
    await page.locator("svg rect").click(); // and the click handler is dead too
    expect(seen.dialogs).toEqual([]);
    expect(seen.marker).toEqual([]);
  });

  test("shown on a mindmap as a picture, it renders and nothing runs", async ({ page, account }) => {
    void account;
    const seen = watch(page);
    const img = await uploadSvgImage(page);
    const { board, record } = await Board.create(page, "SVG picture");
    const node = await createNode(page.request, record.id, { type: "image", title: "vector.svg", x: 0, y: 0, w: 40, h: 40, data: { url: img.url } });
    await board.open();
    await expect(board.node(node.id).locator("img")).toHaveAttribute("src", img.url);
    await expect.poll(() => board.node(node.id).locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    expect(seen.dialogs).toEqual([]);
    expect(seen.marker).toEqual([]);
  });
});

test.describe("an SVG uploaded as a file", () => {
  async function uploaded(page: Page, name = "vector.svg", type = "image/svg+xml", data = PAYLOAD) {
    const board = await createBoard(page.request, "SVG file");
    const node = await createArtefact(page.request, board.id, "file", { title: name });
    expect((await uploadFile(page.request, node.id, { name, type, data, description: "A vector drawing" })).status()).toBe(201);
    return (await listFiles(page.request, node.id))[0];
  }

  test("is handed over as an attachment, never rendered, with nosniff and a sandbox", async ({ page, account }) => {
    void account;
    const file = await uploaded(page);
    const res = await page.request.get(file.url!);
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["content-type"]).toBe("image/svg+xml");
    expect(h["content-disposition"]).toBe('attachment; filename="vector.svg"');
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-security-policy"]).toBe("default-src 'none'; sandbox");
  });

  test("navigating to it downloads it: no dialog, no request, no page", async ({ page, account }) => {
    void account;
    const seen = watch(page);
    const file = await uploaded(page);
    await page.goto("/app");
    const download = page.waitForEvent("download");
    await page.evaluate((href) => {
      location.href = href;
    }, file.url!);
    const d = await download;
    expect(d.suggestedFilename()).toBe("vector.svg");
    expect(seen.dialogs).toEqual([]);
    expect(seen.marker).toEqual([]);
    await expect(page).toHaveURL(/\/app/); // the app page was never replaced
  });

  test("an HTML file is a download too, not a page", async ({ page, account }) => {
    void account;
    const file = await uploaded(page, "page.html", "text/html", "<script>fetch('/__xss?html')</script><h1>x</h1>");
    const res = await page.request.get(file.url!);
    expect(res.headers()["content-disposition"]).toBe('attachment; filename="page.html"');
    expect(res.headers()["content-type"]).toBe("text/html");
    expect(res.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("a type that lies about itself cannot make a browser sniff it into a page", async ({ page, account }) => {
    void account;
    const file = await uploaded(page, "readme.txt", "text/plain", "<html><script>alert(1)</script></html>");
    const res = await page.request.get(file.url!);
    expect(res.headers()["content-type"]).toBe("text/plain");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("a file name cannot break out of the Content-Disposition header", async ({ page, account }) => {
    void account;
    const file = await uploaded(page, 'evil"; filename*=UTF-8\'\'x.html\r\nSet-Cookie: pwned=1.txt', "text/plain", "x");
    const res = await page.request.get(file.url!);
    const disposition = res.headers()["content-disposition"];
    expect(disposition).toMatch(/^attachment; filename="[^"\r\n]*"$/);
    expect(res.headers()["set-cookie"]).toBeUndefined();
  });
});
