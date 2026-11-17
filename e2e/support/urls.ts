// The ids and URLs the Worker hands out, checked the same way on every Worker
// configuration (default origin, PUBLIC_ORIGIN, PUBLIC_ORIGIN + MINDBOX_ORIGIN).
// Each spec file calls `urlSpecs` with the origins its Worker was configured
// with (see support/hosts.ts), so one set of assertions covers all three.
//
// Two kinds of check, per tool: the response carries the node's id, type,
// mindmap id and an absolute URL on the right origin, and the URL *opens* the
// right thing (the app route in a browser, the signed one by a plain request).
import { request as pwRequest, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { addMember, createBoard, createLink, deleteBoard, deleteNode, nodeById } from "./api";
import { connectMcp, type McpClient } from "./mcp";

export interface Origins {
  /** The origin app links must be on. */
  app: string;
  /** The origin signed frame and download links must be on. */
  mindbox: string;
}

export interface Ref {
  id: string;
  type?: string;
  mindmap?: string;
  url?: string;
  line: string;
}

/**
 * Every line of a tool's text that names a node, by `id: \`…\`` or (in the lists
 * `create_mindmap` and `add_to_mindmap` print) `— \`…\``, with the fields on it.
 */
export function refs(text: string): Ref[] {
  const out: Ref[] = [];
  for (const line of text.split("\n")) {
    const id = /\bid: `([^`]+)`/.exec(line)?.[1] ?? /^- .* — `([^`]+)`/.exec(line)?.[1] ??
      /^- .* · `([^`]+)` · type: /.exec(line)?.[1];
    if (!id) continue;
    out.push({
      id,
      type: /\btype: (\w+)/.exec(line)?.[1],
      mindmap: /\bmindmap: `([^`]+)`/.exec(line)?.[1],
      url: /\burl: (\S+)/.exec(line)?.[1],
      line,
    });
  }
  return out;
}

/** The one reference to `id` in `text`; fails with the whole text if there is none. */
export function refTo(text: string, id: string): Ref {
  const hit = refs(text).find((r) => r.id === id);
  expect(hit, `no \`id: …\` line for ${id} in:\n${text}`).toBeTruthy();
  return hit!;
}

/** Assert `id` is named with its type, mindmap and an app URL of the right shape. */
export function expectRef(
  o: Origins,
  text: string,
  want: { id: string; type: string; mindmap: string },
): Ref {
  const r = refTo(text, want.id);
  expect(r.type, `type of ${want.id}`).toBe(want.type);
  expect(r.mindmap, `mindmap of ${want.id}`).toBe(want.mindmap);
  expect(r.url, `url of ${want.id}`).toBe(appUrl(o, want));
  return r;
}

const ROUTE: Record<string, string> = { sheet: "sheet", doc: "doc", deck: "deck", html: "page", file: "file", folder: "file" };

/** Where the app shows this node. */
export function appUrl(o: Origins, n: { id: string; type: string; mindmap: string }): string {
  if (n.type === "mindmap") return `${o.app}/app/${n.id}`;
  const route = ROUTE[n.type];
  return route ? `${o.app}/${route}/${n.id}` : `${o.app}/app/${n.mindmap}?card=${n.id}`;
}

/** The signed frame URL in a tool's text, if it has one. */
export function frameIn(text: string): string | undefined {
  return /(https?:\/\/\S+\/s\/[^\s?]+\?exp=\d+&sig=[0-9a-f]+)/.exec(text)?.[1];
}

/** The signed download URL in a tool's text, if it has one. */
export function downloadIn(text: string): string | undefined {
  return /(https?:\/\/\S+\/f\/[^\s?]+\?exp=\d+&sig=[0-9a-f]+)/.exec(text)?.[1];
}

/** A request with no cookies and no token: all a signed URL may rely on. */
export async function anonymous<T>(fn: (r: APIRequestContext) => Promise<T>): Promise<T> {
  const r = await pwRequest.newContext();
  try {
    return await fn(r);
  } finally {
    await r.dispose();
  }
}

/** GET `url` with nothing but the URL; the body is read before the request context goes. */
export async function fetched(url: string) {
  return anonymous(async (r) => {
    const res = await r.get(url);
    const body = await res.body();
    return { status: () => res.status(), body: () => body, text: () => body.toString("utf8") };
  });
}

/** Open an app URL as the signed-in person, whatever host it names. */
export async function openApp(page: Page, context: BrowserContext, url: string) {
  // The session cookie belongs to the host the test connected through; the URL
  // may name another one (that is the point of the configured origins).
  const origin = new URL(url).origin;
  const cookies = await context.cookies();
  await context.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, url: origin })));
  await page.goto(url);
}

const SHEET = [{ name: "Q1", rows: [["item", "cost"], ["tea", 3]] }];
const DOC = [{ heading: "Plan" }, { text: "alpha beta" }];
const DECK = [{ title: "Intro", bullets: ["one", "two"] }];
const PAGE_HTML = (marker: string) => `<!doctype html><html><body><p>${marker}</p></body></html>`;

const idOf = (text: string) => /card id: `([^`]+)`/.exec(text)![1]!;

export function urlSpecs(label: string, o: Origins) {
  const mcpOk = async (mcp: McpClient, tool: string, args: Record<string, unknown>) => {
    const r = await mcp.call(tool, args);
    expect(r.isError, `${tool}: ${r.text}`).toBe(false);
    return r.text;
  };

  test.describe(`ids and URLs (${label})`, () => {
    test("create_mindmap, add_to_mindmap and add_card name every node they make, and the URLs open it", async ({
      page, context, account, request,
    }) => {
      void account;
      const mcp = await connectMcp(request);

      await mcpOk(mcp, "recall", { query: "ref map" });
      const made = await mcpOk(mcp, "create_mindmap", {
        name: "Ref map",
        nodes: [{ key: "a", title: "Alpha card", content: "first" }, { key: "b", title: "Beta card", content: "second" }],
        edges: [{ from: "a", to: "b" }],
      });
      const mapId = /mindmap id: `([^`]+)`/.exec(made)![1]!;
      const mapRef = refTo(made, mapId);
      expect(mapRef).toMatchObject({ type: "mindmap", mindmap: mapId, url: `${o.app}/app/${mapId}` });
      const nodeLines = refs(made).filter((r) => r.id !== mapId);
      expect(nodeLines).toHaveLength(2);
      for (const r of nodeLines) expectRef(o, made, { id: r.id, type: "card", mindmap: mapId });

      const added = await mcpOk(mcp, "add_to_mindmap", { id: mapId, nodes: [{ key: "c", title: "Gamma card", content: "third" }] });
      const gamma = refs(added).find((r) => r.line.includes("Gamma card"))!;
      expectRef(o, added, { id: gamma.id, type: "card", mindmap: mapId });

      const card = await mcpOk(mcp, "add_card", { mindmap_id: mapId, title: "Delta card", content: "fourth", key: "d" });
      const deltaId = idOf(card);
      expectRef(o, card, { id: deltaId, type: "card", mindmap: mapId });
      // A keyed re-add updates in place and still says where the card is.
      const again = await mcpOk(mcp, "add_card", { mindmap_id: mapId, title: "Delta card", content: "fourth, said again", key: "d" });
      expect(idOf(again)).toBe(deltaId);
      expectRef(o, again, { id: deltaId, type: "card", mindmap: mapId });

      // The mindmap URL opens the mindmap; a card URL opens that card.
      await openApp(page, context, mapRef.url!);
      await expect(page.getByRole("heading", { name: "Ref map" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Untitled" }).first()).toHaveValue("Alpha card");
      await openApp(page, context, refTo(card, deltaId).url!);
      await expect(page.getByRole("textbox", { name: "Untitled" }).last()).toHaveValue("Delta card");
      expect(new URL(page.url()).searchParams.get("card")).toBe(deltaId);
    });

    test("update_card, append_to_card and link_cards say which cards they touched", async ({ account, request }) => {
      void account;
      const mcp = await connectMcp(request);
      const board = await createBoard(request, "Edits");
      const a = idOf(await mcpOk(mcp, "add_card", { mindmap_id: board.id, title: "A", content: "a" }));
      const b = idOf(await mcpOk(mcp, "add_card", { mindmap_id: board.id, title: "B", content: "b" }));

      expectRef(o, await mcpOk(mcp, "update_card", { id: a, title: "A2" }), { id: a, type: "card", mindmap: board.id });
      expectRef(o, await mcpOk(mcp, "append_to_card", { id: a, content: "more" }), { id: a, type: "card", mindmap: board.id });
      const linked = await mcpOk(mcp, "link_cards", { from: a, to: b, label: "leads to" });
      expectRef(o, linked, { id: a, type: "card", mindmap: board.id });
      expectRef(o, linked, { id: b, type: "card", mindmap: board.id });
    });

    for (const [type, extra, route] of [
      ["sheet", { sheets: SHEET }, "sheet"],
      ["doc", { blocks: DOC }, "doc"],
      ["deck", { slides: DECK }, "deck"],
      ["html", { html: PAGE_HTML("page-marker") }, "page"],
    ] as const) {
      test(`${type} artefacts: create_artefact, update_artefact and get_card name the node, and the URL opens the ${route} editor`, async ({
        page, context, account, request,
      }) => {
        void account;
        const mcp = await connectMcp(request);
        const board = await createBoard(request, "Artefacts");
        const title = `A ${type} for refs`;

        const made = await mcpOk(mcp, "create_artefact", { mindmap_id: board.id, type, title, ...extra });
        const id = idOf(made);
        const r = expectRef(o, made, { id, type, mindmap: board.id });
        expect(r.url).toBe(`${o.app}/${route}/${id}`);

        const rewrote = await mcpOk(mcp, "update_artefact", { id, title: `${title} v2`, ...extra });
        expectRef(o, rewrote, { id, type, mindmap: board.id });
        const renamed = await mcpOk(mcp, "update_artefact", { id, title });
        expectRef(o, renamed, { id, type, mindmap: board.id });

        const got = await mcpOk(mcp, "get_card", { id });
        expectRef(o, got, { id, type, mindmap: board.id });

        // A keyed re-create is an update, and answers the same way.
        const keyed = await mcpOk(mcp, "create_artefact", { mindmap_id: board.id, type, title, key: "k", ...extra });
        const keyedAgain = await mcpOk(mcp, "create_artefact", { mindmap_id: board.id, type, title, key: "k", ...extra });
        expectRef(o, keyedAgain, { id: idOf(keyed), type, mindmap: board.id });

        await openApp(page, context, r.url!);
        expect(new URL(page.url()).pathname).toBe(`/${route}/${id}`);
        await expect(page.getByText(title, { exact: true }).or(page.locator(`input[value="${title}"]`)).first()).toBeVisible();
      });
    }

    test("html artefacts: every tool that touches one hands back a frame URL on the mindbox origin that renders it", async ({
      account, request,
    }) => {
      void account;
      const mcp = await connectMcp(request);
      const board = await createBoard(request, "Pages");
      const made = await mcpOk(mcp, "create_artefact", { mindmap_id: board.id, type: "html", title: "Frame me", html: PAGE_HTML("marker-one") });
      const id = idOf(made);

      const check = async (text: string, marker: string, what: string) => {
        const url = frameIn(text);
        expect(url, `${what} returned no frame URL:\n${text}`).toBeTruthy();
        expect(url!.startsWith(`${o.mindbox}/s/${id}?exp=`), `${what}: ${url}`).toBe(true);
        const res = await fetched(url!);
        expect(res.status(), `${what} frame status`).toBe(200);
        expect(res.text()).toContain(marker);
      };

      await check(made, "marker-one", "create_artefact");
      await check(await mcpOk(mcp, "update_artefact", { id, html: PAGE_HTML("marker-two") }), "marker-two", "update_artefact");
      // F06: a page written earlier could only be shown again by rewriting it.
      await check(await mcpOk(mcp, "get_card", { id }), "marker-two", "get_card");

      // And the app's own route for it mints one too.
      const viaRest = await (await request.get(`/api/artefacts/${id}/frame`)).json();
      expect(viaRest.url.startsWith(`${o.mindbox}/s/${id}?exp=`), viaRest.url).toBe(true);
      expect((await fetched(viaRest.url)).status()).toBe(200);
    });

    test("a frame URL stops working once its node is in the trash", async ({ account, request }) => {
      void account;
      const mcp = await connectMcp(request);
      const board = await createBoard(request, "Trashed pages");
      const made = await mcpOk(mcp, "create_artefact", { mindmap_id: board.id, type: "html", title: "Soon gone", html: PAGE_HTML("still-here") });
      const id = idOf(made);
      const url = frameIn(made)!;
      expect((await fetched(url)).status()).toBe(200);

      await deleteNode(request, id);
      const gone = await fetched(url);
      expect(gone.status()).toBe(404);
      expect(gone.text()).not.toContain("still-here");
    });

    test("a frame URL stops working once its whole mindmap is in the trash", async ({ account, request }) => {
      void account;
      const mcp = await connectMcp(request);
      const board = await createBoard(request, "Trashed map");
      const made = await mcpOk(mcp, "create_artefact", { mindmap_id: board.id, type: "html", title: "Soon gone", html: PAGE_HTML("still-here") });
      const url = frameIn(made)!;
      expect((await fetched(url)).status()).toBe(200);

      await deleteBoard(request, board.id);
      expect((await fetched(url)).status()).toBe(404);
    });

    test("get_card, get_mindmap, list_mindmaps, get_context, search, recall and the mindmap tools carry ids and URLs", async ({
      account, request,
    }) => {
      void account;
      const mcp = await connectMcp(request);
      const board = await createBoard(request, "Zanzibar reading list");
      const a = idOf(await mcpOk(mcp, "add_card", { mindmap_id: board.id, title: "Zanzibar spice", content: "cloves and pepper" }));
      const b = idOf(await mcpOk(mcp, "add_card", { mindmap_id: board.id, title: "Zanzibar ferry", content: "the ferry timetable", connect_to: a }));
      const note = { id: a, type: "card", mindmap: board.id };

      expectRef(o, await mcpOk(mcp, "get_card", { id: a }), note);

      const mindmap = await mcpOk(mcp, "get_mindmap", { id: board.id });
      expectRef(o, mindmap, note);
      expectRef(o, mindmap, { id: b, type: "card", mindmap: board.id });
      expectRef(o, mindmap, { id: board.id, type: "mindmap", mindmap: board.id });

      const listed = await mcpOk(mcp, "list_mindmaps", {});
      expectRef(o, listed, { id: board.id, type: "mindmap", mindmap: board.id });

      const context = await mcpOk(mcp, "get_context", { id: a });
      expectRef(o, context, note);
      expectRef(o, context, { id: b, type: "card", mindmap: board.id });

      const found = await mcpOk(mcp, "search", { query: "zanzibar" });
      expectRef(o, found, note);
      expectRef(o, found, { id: b, type: "card", mindmap: board.id });

      const recalled = await mcpOk(mcp, "recall", { query: "zanzibar spice" });
      expectRef(o, recalled, note);

      expectRef(o, await mcpOk(mcp, "update_mindmap", { id: board.id, description: "spices" }), {
        id: board.id, type: "mindmap", mindmap: board.id,
      });
      expectRef(o, await mcpOk(mcp, "relayout_mindmap", { id: board.id, direction: "down" }), {
        id: board.id, type: "mindmap", mindmap: board.id,
      });
    });

    test("a card on a shared mindmap is named by the same URL for the person it is shared with", async ({
      account, request, existing,
    }) => {
      void account;
      const mcp = await connectMcp(request);
      const board = await createBoard(request, "Shared out");
      const card = await mcpOk(mcp, "add_card", { mindmap_id: board.id, title: "Seen by two", content: "x" });
      await addMember(request, "boards", board.id, existing.user.email, "viewer");
      const theirs = await connectMcp(existing.request);
      const got = await mcpOk(theirs, "get_card", { id: idOf(card) });
      expectRef(o, got, { id: idOf(card), type: "card", mindmap: board.id });
    });

    test("put_file, list_files and read_file name the file's node, and a download URL fetches the bytes", async ({
      account, request,
    }) => {
      void account;
      const mcp = await connectMcp(request);
      const board = await createBoard(request, "Files");

      const text = await mcpOk(mcp, "put_file", { mindmap_id: board.id, name: "notes.txt", content: "plain words", description: "notes" });
      const textNode = idOf(text);
      expectRef(o, text, { id: textNode, type: "file", mindmap: board.id });

      const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]);
      const bin = await mcpOk(mcp, "put_file", {
        mindmap_id: board.id, name: "blob.bin", content_base64: bytes.toString("base64"), description: "four bytes and four more",
      });
      const binNode = idOf(bin);
      expectRef(o, bin, { id: binNode, type: "file", mindmap: board.id });

      const inFolder = await mcpOk(mcp, "put_file", { mindmap_id: board.id, folder: "Reports", name: "r1.txt", content: "one", description: "r1" });
      const folderNode = idOf(inFolder);
      expectRef(o, inFolder, { id: folderNode, type: "folder", mindmap: board.id });

      const onBoard = await mcpOk(mcp, "list_files", { id: board.id });
      expectRef(o, onBoard, { id: textNode, type: "file", mindmap: board.id });
      expectRef(o, onBoard, { id: binNode, type: "file", mindmap: board.id });
      expectRef(o, onBoard, { id: folderNode, type: "folder", mindmap: board.id });
      expectRef(o, await mcpOk(mcp, "list_files", { id: folderNode }), { id: folderNode, type: "folder", mindmap: board.id });

      expectRef(o, await mcpOk(mcp, "read_file", { id: textNode }), { id: textNode, type: "file", mindmap: board.id });
      const read = await mcpOk(mcp, "read_file", { id: binNode });
      expectRef(o, read, { id: binNode, type: "file", mindmap: board.id });
      const dl = downloadIn(read);
      expect(dl, read).toBeTruthy();
      expect(dl!.startsWith(`${o.mindbox}/f/`), dl).toBe(true);
      const res = await fetched(dl!);
      expect(res.status()).toBe(200);
      expect(Buffer.from(res.body()).equals(bytes)).toBe(true);
    });

    test("the REST routes build the same URLs: frame, file list, share link and shared view", async ({ page, account, request }) => {
      void account;
      const mcp = await connectMcp(request);
      const board = await createBoard(request, "REST urls");
      const html = idOf(await mcpOk(mcp, "create_artefact", { mindmap_id: board.id, type: "html", title: "Shared page", html: PAGE_HTML("shared-marker") }));

      const frame = (await (await request.get(`/api/artefacts/${html}/frame`)).json()).url as string;
      expect(frame.startsWith(`${o.mindbox}/s/${html}?exp=`), frame).toBe(true);

      const file = idOf(await mcpOk(mcp, "put_file", { mindmap_id: board.id, name: "r.txt", content: "rest bytes", description: "r" }));
      const files = (await (await request.get(`/api/nodes/${file}/files`)).json()).files as { url: string }[];
      expect(files[0]!.url.startsWith(`${o.mindbox}/f/`), files[0]!.url).toBe(true);
      const dl = await fetched(files[0]!.url);
      expect(dl.text()).toBe("rest bytes");

      const link = await createLink(request, html);
      expect(link.url).toBe(`${o.app}/v/${link.token}`);
      const listed = (await (await request.get(`/api/artefacts/${html}/share`)).json()) as { url: string }[];
      expect(listed[0]!.url).toBe(`${o.app}/v/${link.token}`);

      const shared = await anonymous(async (r) => (await r.get(`${new URL(o.app).origin}/api/shared/${link.token}`)).json());
      expect(shared.frame.startsWith(`${o.mindbox}/s/${html}?t=`), shared.frame).toBe(true);
      const body = await fetched(shared.frame);
      expect(body.status()).toBe(200);
      expect(body.text()).toContain("shared-marker");

      // The link itself opens the shared view, signed out.
      await page.context().clearCookies();
      await page.goto(link.url);
      await expect(page.getByText("Shared page").first()).toBeVisible();
    });

    test("a node's own type, never the caller's, decides its URL", async ({ account, request }) => {
      void account;
      const board = await createBoard(request, "Types");
      const mcp = await connectMcp(request);
      const id = idOf(await mcpOk(mcp, "create_artefact", { mindmap_id: board.id, type: "doc", title: "D", blocks: DOC }));
      expect((await nodeById(request, id)).type).toBe("doc");
      expectRef(o, await mcpOk(mcp, "get_card", { id }), { id, type: "doc", mindmap: board.id });
    });
  });
}
