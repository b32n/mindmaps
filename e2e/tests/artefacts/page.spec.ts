import { test, expect } from "../../fixtures";
import { createArtefact, createBoard, createLink, nodeById } from "../../support/api";
import { Board } from "../../support/board";
import type { Page } from "@playwright/test";

// HTML "pages": the one artefact kind that is code. It is written in a source
// box and rendered in a sandboxed iframe from a signed URL (worker/src/mindbox.ts).

// Reports, from inside the page, what it was able to reach. Each result is
// written onto <body> so the test can read it back through the frame.
const PROBE = `<!doctype html><body><h1 id="hello">Hello from a page</h1><script>
  document.body.dataset.ran = "yes";
  const done = (k, v) => { document.body.dataset[k] = v; };
  try { done("cookie", "read:" + document.cookie); } catch (e) { done("cookie", "blocked"); }
  try { localStorage.getItem("mindmaps.workspace"); done("storage", "read"); } catch (e) { done("storage", "blocked"); }
  try { done("parent", String(window.parent.document.title)); } catch (e) { done("parent", "blocked"); }
  fetch("/api/auth/me", { credentials: "include" })
    .then(r => r.text()).then(t => done("fetch", "read:" + t)).catch(() => done("fetch", "blocked"));
</script></body>`;

async function pageOn(page: Page, html = PROBE) {
  const board = await createBoard(page.request, "Pages");
  const node = await createArtefact(page.request, board.id, "html", { title: "Probe", html });
  return { board, node };
}

const frameUrl = async (page: Page, id: string) => ((await (await page.request.get(`/api/artefacts/${id}/frame`)).json()) as { url: string }).url;

test.describe("making and editing a page", () => {
  test("the dock's Add page makes a Page node", async ({ page, account }) => {
    void account;
    const { board } = await Board.create(page, "Dock page");
    const id = await board.addVia(() => page.getByRole("button", { name: "Add page" }).click());
    await expect(board.node(id).locator(".artefact-kind")).toHaveText("Page");
    await expect(board.node(id).locator("input.card-title")).toHaveAttribute("placeholder", "Untitled page");
  });

  test("a page that runs script says so on its card", async ({ page, account }) => {
    void account;
    const { board, node } = await pageOn(page);
    await page.goto(`/app/${board.id}`);
    await expect(page.locator(`.react-flow__node[data-id="${node.id}"] .card-preview`)).toContainText("interactive");
  });

  test("the preview shows the page; editing the source saves it and refreshes the preview", async ({ page, account }) => {
    void account;
    const { node } = await pageOn(page, "<h1>First version</h1>");
    await page.goto(`/page/${node.id}`);
    await page.getByRole("button", { name: "Code" }).click();
    await expect(page.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
    const preview = page.frameLocator("iframe[title='Preview']");
    await expect(preview.getByRole("heading", { name: "First version" })).toBeVisible();

    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/artefacts/${node.id}`) && r.ok());
    await page.locator("textarea.page-source").fill("<h1>Second version</h1>");
    await saved;
    await expect(preview.getByRole("heading", { name: "Second version" })).toBeVisible();
    expect((await nodeById(page.request, node.id)).body).toContain("Second version");
  });

  test("whether the source box is showing is remembered", async ({ page, account }) => {
    void account;
    const { node } = await pageOn(page, "<p>x</p>");
    await page.goto(`/page/${node.id}`);
    await page.getByRole("button", { name: "Code" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("textarea.page-source")).toBeVisible();
  });
});

test.describe("a page's script runs in a box that reaches nothing", () => {
  test("in the preview frame: it runs, but has no cookie, storage, parent or network", async ({ page, account }) => {
    void account;
    const { node } = await pageOn(page);
    await page.goto(`/page/${node.id}`);
    const body = page.frameLocator("iframe[title='Preview']").locator("body");
    await expect(body).toHaveAttribute("data-ran", "yes");
    await expect(body).toHaveAttribute("data-cookie", "blocked");
    await expect(body).toHaveAttribute("data-storage", "blocked");
    await expect(body).toHaveAttribute("data-parent", "blocked");
    await expect(body).toHaveAttribute("data-fetch", "blocked");
  });

  test("opened straight in a tab, on the app's own origin, it still has no session to borrow", async ({ page, account }) => {
    void account;
    const { node } = await pageOn(page);
    // top-level navigation, no iframe: only the response's own sandbox protects it
    await page.goto(await frameUrl(page, node.id));
    const body = page.locator("body");
    await expect(body).toHaveAttribute("data-ran", "yes");
    await expect(body).toHaveAttribute("data-cookie", "blocked");
    await expect(body).toHaveAttribute("data-storage", "blocked");
    await expect(body).toHaveAttribute("data-fetch", "blocked");
  });

  test("the response carries the sandbox, a no-network policy and no-store", async ({ page, account }) => {
    void account;
    const { node } = await pageOn(page);
    const res = await page.request.get(await frameUrl(page, node.id));
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["content-type"]).toContain("text/html");
    expect(h["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(h["content-security-policy"]).toContain("connect-src 'none'");
    expect(h["content-security-policy"]).toContain("default-src 'none'");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["cache-control"]).toBe("private, no-store");
    expect(h["referrer-policy"]).toBe("no-referrer");
  });
});

test.describe("who can get a page's frame", () => {
  test("only someone who can read the artefact is given a signed URL", async ({ page, account, existing }) => {
    void account;
    const { node } = await pageOn(page);
    expect((await existing.request.get(`/api/artefacts/${node.id}/frame`)).status()).toBe(404);
    expect((await page.request.get(`/api/artefacts/${node.id}/frame`)).status()).toBe(200);
  });

  test("the signature is checked: missing, wrong, for another page, or with an edited expiry all fail", async ({ page, account, request }) => {
    void account;
    const { board, node } = await pageOn(page);
    const other = await createArtefact(request, board.id, "html", { title: "Other", html: "<p>other</p>" });
    const url = await frameUrl(page, node.id);
    const { searchParams } = new URL(url, "http://x");
    const exp = searchParams.get("exp")!;
    const sig = searchParams.get("sig")!;

    const bare = await page.request.get(`/s/${node.id}`);
    expect(bare.status()).toBe(403);
    expect((await page.request.get(`/s/${node.id}?exp=${exp}&sig=${"0".repeat(64)}`)).status()).toBe(403);
    // a valid signature belongs to one page id: pointing it at another is refused
    expect((await page.request.get(`/s/${other.id}?exp=${exp}&sig=${sig}`)).status()).toBe(403);
    // the expiry is part of what is signed: moving it into the past breaks the signature
    expect((await page.request.get(`/s/${node.id}?exp=${Number(exp) - 2 * 3_600_000}&sig=${sig}`)).status()).toBe(403);
    expect((await page.request.get(url)).status()).toBe(200);
  });

  test("a public link to a page serves it until revoked", async ({ page, account, playwright, baseURL }) => {
    void account;
    const { node } = await pageOn(page, "<h1>Public page</h1>");
    const link = await createLink(page.request, node.id);
    const anon = await playwright.request.newContext({ baseURL });
    const shared = await (await anon.get(`/api/shared/${link.token}`)).json();
    expect(shared.kind).toBe("html");
    expect(shared.payload).toBeNull();
    const served = await anon.get(shared.frame);
    expect(served.status()).toBe(200);
    expect(await served.text()).toContain("Public page");
    // the token is bound to its page
    const other = await createArtefact(page.request, (await createBoard(page.request, "x")).id, "html", { html: "<p>secret</p>" });
    expect((await anon.get(`/s/${other.id}?t=${link.token}`)).status()).toBe(404);

    expect((await page.request.delete(`/api/shares/${link.token}`)).ok()).toBe(true);
    expect((await anon.get(shared.frame)).status()).toBe(404);
    await anon.dispose();
  });
});
