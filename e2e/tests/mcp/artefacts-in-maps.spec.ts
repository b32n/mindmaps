import { test, expect, type Person } from "../../fixtures";
import { addMember, createArtefact, createBoard, deleteNode, uploadFile } from "../../support/api";
import { MAIN_PORT } from "../../support/hosts";
import { connectMcp, type McpClient } from "../../support/mcp";
import { expectRef, refs } from "../../support/urls";

// A mindmap holds more than cards: sheets, documents, decks, pages, files and
// folders. The read tools used to show only cards and notes, so an agent that
// read a map did not know half of it was there, and `get_context` on a card
// linked to a sheet said "has no links yet". Each read tool names every kind,
// with its type, key, id and URL, to whoever may read the map and no one else.

const o = { app: `http://127.0.0.1:${MAIN_PORT}`, mindbox: `http://127.0.0.1:${MAIN_PORT}` };

const SHEET = [{ name: "Q1", rows: [["item", "cost"], ["tea", 3]] }];
const DOC = [{ heading: "Quokka plan" }, { text: "quokka steps" }];
const DECK = [{ title: "Quokka intro", bullets: ["one", "two"] }];
const HTML = "<!doctype html><html><body><p>quokka page</p></body></html>";

const idOf = (text: string) => /card id: `([^`]+)`/.exec(text)![1]!;

async function ok(mcp: McpClient, tool: string, args: Record<string, unknown>) {
  const r = await mcp.call(tool, args);
  expect(r.isError, `${tool}: ${r.text}`).toBe(false);
  return r.text;
}

interface Node {
  id: string;
  type: string;
  key?: string;
}

/** A map with a card and one of each artefact kind and a file, all linked from the card, plus a trashed sheet and file. */
async function fill(request: Parameters<typeof connectMcp>[0], mcp: McpClient) {
  const board = await createBoard(request, "Quokka map");
  const nodes: Node[] = [];

  const card = idOf(await ok(mcp, "add_card", { mindmap_id: board.id, title: "Quokka card", content: "quokka facts", key: "card-k" }));
  nodes.push({ id: card, type: "card", key: "card-k" });

  const kinds: Array<[string, Record<string, unknown>]> = [
    ["sheet", { sheets: SHEET }],
    ["doc", { blocks: DOC }],
    ["deck", { slides: DECK }],
    ["html", { html: HTML }],
  ];
  for (const [type, extra] of kinds) {
    const text = await ok(mcp, "create_artefact", { mindmap_id: board.id, type, title: `Quokka ${type}`, key: `${type}-k`, ...extra });
    nodes.push({ id: idOf(text), type, key: `${type}-k` });
  }
  for (const type of ["file", "folder"] as const) {
    const n = await createArtefact(request, board.id, type, { title: `Quokka ${type}` });
    const res = await uploadFile(request, n.id, { name: `quokka-${type}.txt`, type: "text/plain", data: "quokka bytes" });
    expect(res.ok(), `upload to ${type}`).toBe(true);
    nodes.push({ id: n.id, type });
  }
  for (const n of nodes.slice(1)) await ok(mcp, "link_cards", { from: card, to: n.id, label: "relates" });

  // Things in the trash are not on the map, whatever they were.
  const gone: Node[] = [];
  const sheet = await createArtefact(request, board.id, "sheet", { title: "Quokka trashed sheet" });
  const file = await createArtefact(request, board.id, "file", { title: "Quokka trashed file" });
  for (const n of [sheet, file]) {
    await ok(mcp, "link_cards", { from: card, to: n.id, label: "relates" });
    await deleteNode(request, n.id);
    gone.push({ id: n.id, type: n.type });
  }
  return { board, card, nodes, gone };
}

function expectAll(text: string, board: string, nodes: Node[], what: string) {
  for (const n of nodes) {
    const r = expectRef(o, text, { id: n.id, type: n.type, mindmap: board });
    if (n.key) expect(r.line, `${what}: key of ${n.type}`).toContain(`key: \`${n.key}\``);
  }
}

function expectNone(text: string, nodes: Node[], what: string) {
  for (const n of nodes) expect(text, `${what} must not name ${n.id}`).not.toContain(n.id);
}

test.describe("artefacts and files in the read tools", () => {
  test("get_mindmap lists every kind of node with type, key, id and URL, and not what is in the trash", async ({ account, request }) => {
    void account;
    const mcp = await connectMcp(request);
    const { board, nodes, gone } = await fill(request, mcp);
    const text = await ok(mcp, "get_mindmap", { id: board.id });
    expectAll(text, board.id, nodes, "get_mindmap");
    expectNone(text, gone, "get_mindmap");
  });

  test("list_mindmaps counts each kind on a map, and not what is in the trash", async ({ account, request }) => {
    void account;
    const mcp = await connectMcp(request);
    const { board } = await fill(request, mcp);
    const text = await ok(mcp, "list_mindmaps", {});
    const entry = text.split("\n- ").find((e) => e.includes(`id: \`${board.id}\``))!;
    expect(entry).toContain("1 card");
    for (const t of ["sheet", "doc", "deck", "html", "file", "folder"]) expect(entry, t).toMatch(new RegExp(`\\b1 ${t}\\b`));
    expect(entry).not.toMatch(/\b[2-9] (sheet|file)/);
    expectRef(o, entry, { id: board.id, type: "mindmap", mindmap: board.id });
  });

  test("get_context walks to artefacts and files, naming each one's type, and from an artefact back to the card", async ({ account, request }) => {
    void account;
    const mcp = await connectMcp(request);
    const { board, card, nodes, gone } = await fill(request, mcp);
    const text = await ok(mcp, "get_context", { id: card });
    expect(text).not.toContain("has no links yet");
    expectAll(text, board.id, nodes.slice(1), "get_context");
    expectNone(text, gone, "get_context");
    for (const n of nodes.slice(1)) {
      const bullet = text.split("\n- ").find((b) => b.includes(`id: \`${n.id}\``))!;
      expect(bullet.split("\n")[0], `heading of ${n.type}`).toContain(`(${n.type})`);
    }
    expect(text).toContain(`\`${card}\` (card)`);

    const sheet = nodes.find((n) => n.type === "sheet")!;
    const back = await ok(mcp, "get_context", { id: sheet.id });
    expect(back).toContain(`\`${sheet.id}\` (sheet)`);
    expectAll(back, board.id, [nodes[0]!], "get_context from a sheet");
  });

  test("recall finds artefacts and files with type, key, id and URL, and shows them as links of the card", async ({ account, request }) => {
    void account;
    const mcp = await connectMcp(request);
    const { board, card, nodes, gone } = await fill(request, mcp);
    const text = await ok(mcp, "recall", { query: "quokka" });
    expectAll(text, board.id, nodes, "recall");
    expectNone(text, gone, "recall");

    const block = text.split("\n## ").find((b) => b.includes(`id: \`${card}\``))!;
    // Recall shows at most a few links per match, so not every node is among them.
    const linked = block.slice(block.indexOf("Connects to:")).split("\n").filter((l) => l.startsWith("- "));
    expect(linked.length, "links shown under the card").toBeGreaterThanOrEqual(3);
    for (const line of linked) {
      const n = nodes.slice(1).find((x) => line.includes(`\`${x.id}\``));
      expect(n, `a node on the map: ${line}`).toBeTruthy();
      expect(line).toContain(`type: ${n!.type}`);
      expect(line).toContain(`mindmap: \`${board.id}\``);
      expect(line).toContain(`url: ${appUrlOf(n!, board.id)}`);
      if (n!.key) expect(line).toContain(`key: \`${n!.key}\``);
    }
  });

  test("a viewer of the map sees all of it, and someone it is not shared with sees none of it", async ({ account, request, makePerson }) => {
    void account;
    const mcp = await connectMcp(request);
    const { board, card, nodes } = await fill(request, mcp);
    const viewer: Person = await makePerson("viewer");
    const stranger: Person = await makePerson("stranger");
    await addMember(request, "boards", board.id, viewer.user.email, "viewer");

    const theirs = await connectMcp(viewer.request);
    expectAll(await ok(theirs, "get_mindmap", { id: board.id }), board.id, nodes, "viewer get_mindmap");
    expectAll(await ok(theirs, "get_context", { id: card }), board.id, nodes.slice(1), "viewer get_context");
    expectAll(await ok(theirs, "recall", { query: "quokka" }), board.id, nodes, "viewer recall");
    expect(await ok(theirs, "list_mindmaps", {})).toContain(`id: \`${board.id}\``);

    const none = await connectMcp(stranger.request);
    const denied = await none.call("get_mindmap", { id: board.id });
    expect(denied.isError).toBe(true);
    // A refusal repeats the id that was asked for, and says nothing about what is there.
    expect(refs(denied.text)).toEqual([]);
    expect(denied.text).not.toContain("Quokka");
    const noContext = await none.call("get_context", { id: card });
    expect(noContext.isError).toBe(true);
    expect(refs(noContext.text)).toEqual([]);
    expect(noContext.text).not.toContain("Quokka");
    expectNone(await ok(none, "recall", { query: "quokka" }), nodes, "stranger recall");
    expectNone(await ok(none, "list_mindmaps", {}), [{ id: board.id, type: "mindmap" }], "stranger list_mindmaps");
    expect(refs(await ok(none, "recall", { query: "quokka" }))).toEqual([]);
  });
});

function appUrlOf(n: Node, mindmap: string) {
  const route: Record<string, string> = { sheet: "sheet", doc: "doc", deck: "deck", html: "page", file: "file", folder: "file" };
  return route[n.type] ? `${o.app}/${route[n.type]}/${n.id}` : `${o.app}/app/${mindmap}?card=${n.id}`;
}
