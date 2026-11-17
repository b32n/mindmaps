import { test, expect } from "../../fixtures";
import { addMember, contents, createArtefact, createBoard, nodeById, uploadFile } from "../../support/api";
import { connectMcp, type McpClient } from "../../support/mcp";

// An agent that reuses a key, or an id, for a node of another kind must be
// told what is there instead of overwriting it. These cover the writes that used
// to destroy a card, a sheet or a file's name without a word.

const idIn = (text: string) => /card id: `([^`]+)`/.exec(text)![1]!;
const SHEET = [{ name: "Q1", rows: [["item", "cost"], ["tea", 3]] }];

async function snapshot(request: any, id: string) {
  const node = await nodeById(request, id);
  const res = await request.get(`/api/artefacts/${id}`);
  return { node: JSON.stringify(node), payload: res.ok() ? JSON.stringify(await res.json()) : `status ${res.status()}` };
}

test.describe("a keyed create over a node of another kind", () => {
  test("create_artefact over a card's key is refused, naming the card, and the card is untouched", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Keys");
    const mcp = await connectMcp(request);
    const card = await mcp.call("add_card", { mindmap_id: board.id, title: "C1", content: "original words", key: "k" });
    const id = idIn(card.text);
    const before = await snapshot(request, id);

    const r = await mcp.call("create_artefact", { mindmap_id: board.id, type: "sheet", key: "k", title: "Clobber", sheets: SHEET });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain("card");
    expect(r.text).toContain(id);
    expect(await snapshot(request, id)).toEqual(before);
    expect((await nodeById(request, id)).type).toBe("card");
  });

  test("create_artefact of another type over an artefact's key is refused and the sheet is untouched", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Keys");
    const mcp = await connectMcp(request);
    const made = await mcp.call("create_artefact", { mindmap_id: board.id, type: "sheet", key: "k", title: "Budget", sheets: SHEET });
    const id = idIn(made.text);
    const before = await snapshot(request, id);

    const r = await mcp.call("create_artefact", { mindmap_id: board.id, type: "html", key: "k", title: "Page", html: "<p>now html</p>" });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain("sheet");
    expect(r.text).toContain(id);
    expect(await snapshot(request, id)).toEqual(before);
  });

  test("create_artefact of the same type over its own key still updates it", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Keys");
    const mcp = await connectMcp(request);
    const made = await mcp.call("create_artefact", { mindmap_id: board.id, type: "sheet", key: "k", title: "Budget", sheets: SHEET });
    const r = await mcp.call("create_artefact", { mindmap_id: board.id, type: "sheet", key: "k", title: "Budget v2", sheets: [{ name: "Q2", rows: [["a"]] }] });
    expect(r.isError, r.text).toBe(false);
    expect(idIn(r.text)).toBe(idIn(made.text));
    expect(JSON.stringify(await (await request.get(`/api/artefacts/${idIn(made.text)}`)).json())).toContain("Q2");
  });

  test("add_card over an artefact's key is refused and the artefact is untouched", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Keys");
    const mcp = await connectMcp(request);
    const made = await mcp.call("create_artefact", { mindmap_id: board.id, type: "sheet", key: "k", title: "Budget", sheets: SHEET });
    const id = idIn(made.text);
    const before = await snapshot(request, id);

    const r = await mcp.call("add_card", { mindmap_id: board.id, key: "k", title: "Prose", content: "words" });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain("sheet");
    expect(r.text).toContain(id);
    expect(await snapshot(request, id)).toEqual(before);
  });

  test("add_to_mindmap with a key that holds an artefact is refused and nothing is written", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Keys");
    const mcp = await connectMcp(request);
    const made = await mcp.call("create_artefact", { mindmap_id: board.id, type: "doc", key: "k", title: "Notes", blocks: [{ paragraph: "hello" }] });
    const id = idIn(made.text);
    const before = await snapshot(request, id);
    const count = (await contents(request, board.id)).nodes.length;

    const r = await mcp.call("add_to_mindmap", { id: board.id, nodes: [{ key: "other", title: "New" }, { key: "k", title: "Prose", content: "words" }] });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain("doc");
    expect(r.text).toContain(id);
    expect(await snapshot(request, id)).toEqual(before);
    expect((await contents(request, board.id)).nodes.length).toBe(count);
  });
});

test.describe("update_card and append_to_card", () => {
  for (const tool of ["update_card", "append_to_card"] as const) {
    for (const type of ["sheet", "doc", "deck", "html"] as const) {
      test(`${tool} refuses a ${type} and points to update_artefact`, async ({ account, request }) => {
        void account;
        const board = await createBoard(request, "Kinds");
        const mcp = await connectMcp(request);
        const content = { sheet: { sheets: SHEET }, doc: { blocks: [{ paragraph: "hello" }] }, deck: { slides: [{ title: "S" }] }, html: { html: "<p>page</p>" } }[type];
        const made = await mcp.call("create_artefact", { mindmap_id: board.id, type, title: "Thing", ...content });
        expect(made.isError, made.text).toBe(false);
        const id = idIn(made.text);
        const before = await snapshot(request, id);

        const r = await mcp.call(tool, { id, content: "prose that must not land" });
        expect(r.isError, r.text).toBe(true);
        expect(r.text).toContain(type);
        expect(r.text).toContain("update_artefact");
        expect(await snapshot(request, id)).toEqual(before);
      });
    }

    test(`${tool} refuses a file card and its name does not change`, async ({ account, request }) => {
      void account;
      const board = await createBoard(request, "Kinds");
      const file = await createArtefact(request, board.id, "file", { title: "Report" });
      expect((await uploadFile(request, file.id, { name: "r.txt", type: "text/plain", data: "bytes" })).ok()).toBe(true);
      const before = await snapshot(request, file.id);
      const mcp = await connectMcp(request);

      const r = await mcp.call(tool, { id: file.id, title: "renamed", content: "prose" });
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toContain("file");
      expect(await snapshot(request, file.id)).toEqual(before);
    });
  }

  test("a plain card is still updated and appended to", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Kinds");
    const mcp = await connectMcp(request);
    const id = idIn((await mcp.call("add_card", { mindmap_id: board.id, title: "C", content: "one" })).text);
    expect((await mcp.call("update_card", { id, content: "two" })).isError).toBe(false);
    expect((await mcp.call("append_to_card", { id, content: "three" })).isError).toBe(false);
    expect((await nodeById(request, id)).body).toContain("three");
  });
});

test.describe("update_artefact", () => {
  async function sheetOn(mcp: McpClient, boardId: string) {
    const made = await mcp.call("create_artefact", { mindmap_id: boardId, type: "sheet", title: "Budget", sheets: SHEET });
    return idIn(made.text);
  }

  test("a person with view-only access is told so, not that the artefact does not exist", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Shared");
    const owner = await connectMcp(request);
    const id = await sheetOn(owner, board.id);
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const before = await snapshot(request, id);

    const theirs = await connectMcp(existing.request);
    expect((await theirs.call("get_card", { id })).isError).toBe(false);
    const r = await theirs.call("update_artefact", { id, sheets: [{ rows: [["x"]] }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("view-only");
    expect(r.text).not.toContain("No artefact");
    expect(await snapshot(request, id)).toEqual(before);
  });

  test("an id nobody can see still reads as not found", async ({ account, request }) => {
    void account;
    const mcp = await connectMcp(request);
    const r = await mcp.call("update_artefact", { id: "no-such-id", sheets: [{ rows: [["x"]] }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No artefact with id no-such-id");
  });

  test("a title alone renames it and leaves the contents alone", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Rename");
    const mcp = await connectMcp(request);
    const id = await sheetOn(mcp, board.id);
    const payloadBefore = JSON.stringify(await (await request.get(`/api/artefacts/${id}`)).json());

    const r = await mcp.call("update_artefact", { id, title: "Renamed budget" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("Renamed budget");
    expect((await nodeById(request, id)).title).toBe("Renamed budget");
    expect(JSON.stringify(await (await request.get(`/api/artefacts/${id}`)).json())).toBe(payloadBefore);
  });

  test("with neither a title nor contents it says what to pass", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Rename");
    const mcp = await connectMcp(request);
    const id = await sheetOn(mcp, board.id);
    const r = await mcp.call("update_artefact", { id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("title");
  });

  test("it moves the mindmap's updated time, as other writes do", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Touch");
    const mcp = await connectMcp(request);
    const id = await sheetOn(mcp, board.id);
    const stamp = async () => ((await (await request.get("/api/boards")).json()) as any[]).find((b) => b.id === board.id).updated_at as number;
    const before = await stamp();
    await new Promise((r) => setTimeout(r, 15));

    expect((await mcp.call("update_artefact", { id, sheets: [{ rows: [["new"]] }] })).isError).toBe(false);
    const afterContent = await stamp();
    expect(afterContent).toBeGreaterThan(before);
    await new Promise((r) => setTimeout(r, 15));

    expect((await mcp.call("update_artefact", { id, title: "Again" })).isError).toBe(false);
    expect(await stamp()).toBeGreaterThan(afterContent);
  });
});

test.describe("hits and cards say what kind of node they are", () => {
  test("search, recall and get_card show the type", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Kinds");
    const mcp = await connectMcp(request);
    await mcp.call("add_card", { mindmap_id: board.id, title: "Zebra card", content: "zebra notes" });
    const sheet = idIn((await mcp.call("create_artefact", { mindmap_id: board.id, type: "sheet", title: "Zebra budget", sheets: [{ rows: [["zebra", 1]] }] })).text);

    const search = await mcp.call("search", { query: "zebra" });
    expect(search.text).toMatch(/Zebra budget\*\* \(sheet\)/);
    expect(search.text).toMatch(/Zebra card\*\* \(card\)/);

    const recall = await mcp.call("recall", { query: "zebra" });
    expect(recall.text).toMatch(/## Zebra budget \(sheet\)/);
    expect(recall.text).toMatch(/## Zebra card \(card\)/);

    const read = await mcp.call("get_card", { id: sheet });
    expect(read.text).toMatch(/type: sheet/);
  });

  test("get_card on a keyed card shows its type and key", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Kinds");
    const mcp = await connectMcp(request);
    const id = idIn((await mcp.call("add_card", { mindmap_id: board.id, title: "Keyed", content: "x", key: "kk" })).text);
    const read = await mcp.call("get_card", { id });
    expect(read.text).toMatch(/type: card/);
    expect(read.text).toContain("key: `kk`");
  });
});
