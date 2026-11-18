import { test, expect } from "../../fixtures";
import { connectMcp } from "../../support/mcp";
import { createArtefact, createBoard, createNode, deleteNode, listFiles, trash, uploadFile } from "../../support/api";
import { expectVersions, headOf, query, versionsOf } from "../../support/versions";

// Every way a card, an artefact or a file changes records a version: who wrote
// it, through which door, and when. Nothing reads the history yet, so these read
// the database (support/versions.ts) and, for what an agent can see, the tool text.

const idIn = (text: string) => /(?:card|file) id: `([^`]+)`/.exec(text)![1]!;
const SHEET = [{ name: "Q1", rows: [["item", "cost"], ["tea", 3]] }];

async function me(request: any): Promise<{ id: string; name: string }> {
  return (await (await request.get("/api/auth/me")).json()).user;
}

test.describe("the tables", () => {
  test("versions and version_heads exist, with the columns the design names", async ({ account }) => {
    void account;
    const cols = async (t: string) => (await query<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`)).map((c) => c.name);
    expect(await cols("versions")).toEqual(
      expect.arrayContaining([
        "id", "node_id", "board_id", "workspace_id", "seq", "node_type", "op", "title", "body", "doc", "data_json",
        "payload_key", "payload_bytes", "content_hash", "restored_from", "actor_user_id", "actor_client_id",
        "actor_client_name", "actor_via", "actor_note", "label", "pinned", "status", "created_at", "sealed_at",
        "status_changed_at",
      ]),
    );
    expect(await cols("version_heads")).toEqual(
      expect.arrayContaining(["node_id", "head_seq", "head_version_id", "updated_by_user", "updated_by_client", "updated_at"]),
    );
  });

  test("a node's sequence numbers are unique", async ({ account }) => {
    void account;
    const idx = await query<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'versions' AND sql LIKE '%UNIQUE%'`,
    );
    expect(idx.length + (await query(`SELECT 1 FROM sqlite_master WHERE name = 'versions' AND sql LIKE '%UNIQUE%'`)).length).toBeGreaterThan(0);
  });
});

test.describe("REST writes by the app", () => {
  test("creating a card records v1 with the person who made it, in the mindmap's workspace", async ({ account, request }) => {
    const user = await me(request);
    const board = await createBoard(request, "H1");
    const card = await createNode(request, board.id, { title: "First", body: "" });
    const [v] = await expectVersions(card.id, 1);
    expect(v).toMatchObject({
      seq: 1, op: "create", node_type: "card", title: "First", board_id: board.id,
      workspace_id: board.workspace_id, actor_user_id: user.id, actor_via: "web", actor_client_id: null,
    });
    expect(v!.content_hash).toBeTruthy();
    expect(v!.created_at).toBeGreaterThan(0);
    expect(account.email).toBeTruthy();
  });

  test("edits by the same person inside the window fold into the open version", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "H2");
    const card = await createNode(request, board.id, { title: "Draft" });
    for (const t of ["Draft 2", "Draft 3"]) {
      const r = await request.patch(`/api/nodes/${card.id}`, { data: { title: t } });
      expect(r.ok()).toBe(true);
    }
    const [v] = await expectVersions(card.id, 1);
    expect(v).toMatchObject({ seq: 1, status: "open", title: "Draft 3" });
    expect((await headOf(card.id))!.head_seq).toBe(1);
  });

  test("a doc edit stores the document and the markdown derived from it", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "H3");
    const card = await createNode(request, board.id, { title: "Doc" });
    const doc = JSON.stringify([{ id: "a", type: "paragraph", text: "hello versions" }]);
    expect((await request.patch(`/api/nodes/${card.id}`, { data: { doc } })).ok()).toBe(true);
    const [v] = await expectVersions(card.id, 1);
    expect(v!.doc).toBe(doc);
    expect(v!.body).toContain("hello versions");
  });

  test("saving what is already stored, or only moving the card, records nothing", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "H4");
    const card = await createNode(request, board.id, { title: "Same" });
    const before = await versionsOf(card.id);
    expect((await request.patch(`/api/nodes/${card.id}`, { data: { title: "Same" } })).ok()).toBe(true);
    expect((await request.patch(`/api/nodes/${card.id}`, { data: { x: 400, y: 300 } })).ok()).toBe(true);
    expect((await request.patch(`/api/nodes/${card.id}`, { data: { w: 300, h: 200 } })).ok()).toBe(true);
    expect(await versionsOf(card.id)).toEqual(before);
  });

  test("an image is not content: pasting one records no version", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "H5");
    const img = await createNode(request, board.id, { type: "image", title: "pic" });
    expect(await versionsOf(img.id)).toEqual([]);
  });

  test("a sheet saved by the editor: v1 on create, autosaves fold in, an identical save is a no-op", async ({ account, request }) => {
    const user = await me(request);
    const board = await createBoard(request, "H6");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "Budget", sheets: SHEET });
    let [v] = await expectVersions(sheet.id, 1);
    expect(v).toMatchObject({ op: "create", node_type: "sheet", actor_user_id: user.id, actor_via: "web", status: "open" });
    const first = v!.content_hash;

    const next = { sheets: [{ name: "Q1", rows: [["item", "cost"], ["tea", 4]] }] };
    const got = await (await request.get(`/api/artefacts/${sheet.id}`)).json();
    const edited = JSON.parse(JSON.stringify(got).replace(`"value":3`, `"value":4`));
    expect((await request.put(`/api/artefacts/${sheet.id}`, { data: edited })).ok()).toBe(true);
    [v] = await expectVersions(sheet.id, 1);
    expect(v!.content_hash).not.toBe(first);
    expect(v!.status).toBe("open");
    expect(v!.payload_key).toBeNull(); // the head object is the state while it is open

    const hash = v!.content_hash;
    expect((await request.put(`/api/artefacts/${sheet.id}`, { data: edited })).ok()).toBe(true);
    [v] = await expectVersions(sheet.id, 1);
    expect(v!.content_hash).toBe(hash);
    void next;
    void account;
  });

  test("a refused write records nothing", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "H7");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "Budget", sheets: SHEET });
    const before = await versionsOf(sheet.id);
    expect((await request.put(`/api/artefacts/${sheet.id}`, { data: null })).status()).toBe(400);
    expect(await versionsOf(sheet.id)).toEqual(before);
  });

  test("a file upload and a rename each record a version of the node, and the folder grows by one per file", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "H8");
    const folder = await createArtefact(request, board.id, "folder", { title: "Papers" });
    await expectVersions(folder.id, 1);
    for (const n of ["a.md", "b.md"]) {
      const r = await uploadFile(request, folder.id, { name: n, type: "text/markdown", data: `# ${n}` });
      expect(r.status()).toBe(201);
    }
    const rows = await versionsOf(folder.id);
    // the same person inside the window: one open version, updated
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.data_json!)).toMatchObject({ files: 2 });
    expect(rows[0]!.body).toContain("a.md");
    const [f] = await listFiles(request, folder.id);
    expect((await request.patch(`/api/files/${f!.id}`, { data: { description: "renamed one" } })).ok()).toBe(true);
    expect((await versionsOf(folder.id))[0]!.body).toContain("renamed one");
  });

  test("a card restored from the trash keeps its history instead of starting over", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "H9");
    const card = await createNode(request, board.id, { title: "Back" });
    await deleteNode(request, card.id);
    const entry = (await trash(request)).find((t) => t.id === card.id)!;
    expect((await request.post(`/api/trash/${entry.id}/restore`)).ok()).toBe(true);
    expect((await versionsOf(card.id)).map((v) => v.seq)).toEqual([1]);
    expect((await request.patch(`/api/nodes/${card.id}`, { data: { title: "Back, edited" } })).ok()).toBe(true);
    const rows = await versionsOf(card.id);
    expect(rows.map((v) => v.seq)).toEqual([1]);
    expect(rows[0]!.title).toBe("Back, edited");
  });

  test("a new account's starter mindmap has a first version for each card", async ({ account, request }) => {
    void account;
    const boards = await (await request.get("/api/boards")).json();
    const start = boards.find((b: any) => b.name === "Start here");
    const nodes = (await (await request.get(`/api/boards/${start.id}/contents`)).json()).nodes;
    expect(nodes.length).toBeGreaterThan(2);
    for (const n of nodes) {
      const [v] = await expectVersions(n.id, 1);
      expect(v).toMatchObject({ op: "create", actor_via: "system" });
    }
  });
});

test.describe("MCP writes by an agent", () => {
  test("each card tool records a sealed version naming the client; identical re-adds record nothing", async ({ account, request }) => {
    const user = await me(request);
    const board = await createBoard(request, "M1");
    const mcp = await connectMcp(request, { clientName: "agent-one" });
    const added = await mcp.call("add_card", { mindmap_id: board.id, title: "Note", content: "first", key: "k1" });
    const id = idIn(added.text);
    let rows = await expectVersions(id, 1);
    expect(rows[0]).toMatchObject({
      op: "create", status: "sealed", actor_via: "mcp", actor_user_id: user.id,
      actor_client_id: mcp.credentials.clientId, actor_client_name: "agent-one", title: "Note",
    });
    expect(rows[0]!.sealed_at).toBeGreaterThan(0);

    await mcp.call("update_card", { id, content: "second" });
    rows = await expectVersions(id, 2);
    expect(rows[1]).toMatchObject({ seq: 2, op: "edit", status: "sealed", actor_client_name: "agent-one" });
    expect(rows[1]!.body).toContain("second");

    await mcp.call("append_to_card", { id, content: "third" });
    rows = await expectVersions(id, 3);
    expect(rows[2]!.body).toContain("third");

    // a keyed re-add with new words is an edit; with the same words it is nothing
    await mcp.call("add_card", { mindmap_id: board.id, title: "Note", content: "fourth", key: "k1" });
    rows = await expectVersions(id, 4);
    await mcp.call("add_card", { mindmap_id: board.id, title: "Note", content: "fourth", key: "k1" });
    await expectVersions(id, 4);
    void account;
  });

  test("an agent's consecutive writes are separate versions, never folded together", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "M2");
    const mcp = await connectMcp(request);
    const id = idIn((await mcp.call("add_card", { mindmap_id: board.id, title: "T", content: "a" })).text);
    await mcp.call("update_card", { id, content: "b" });
    await mcp.call("update_card", { id, content: "c" });
    expect((await expectVersions(id, 3)).map((v) => v.status)).toEqual(["sealed", "sealed", "sealed"]);
  });

  test("create_mindmap and add_to_mindmap record a version for every card", async ({ account, request }) => {
    void account;
    const mcp = await connectMcp(request, { clientName: "builder" });
    const made = await mcp.call("create_mindmap", {
      name: "Built", cards: [{ key: "a", title: "A", content: "x" }, { key: "b", title: "B", content: "y" }], links: [{ from: "a", to: "b" }],
    });
    expect(made.isError, made.text).toBe(false);
    const board = (await (await request.get("/api/boards")).json()).find((b: any) => b.name === "Built");
    const nodes = (await (await request.get(`/api/boards/${board.id}/contents`)).json()).nodes;
    expect(nodes).toHaveLength(2);
    for (const n of nodes) expect((await expectVersions(n.id, 1))[0]).toMatchObject({ op: "create", actor_client_name: "builder" });

    const more = await mcp.call("add_to_mindmap", { mindmap_id: board.id, cards: [{ key: "a", title: "A", content: "changed" }, { key: "c", title: "C", content: "z" }] });
    expect(more.isError, more.text).toBe(false);
    const after = (await (await request.get(`/api/boards/${board.id}/contents`)).json()).nodes;
    expect(after).toHaveLength(3);
    const byTitle = Object.fromEntries(after.map((n: any) => [n.title, n.id]));
    expect(await versionsOf(byTitle["A"])).toHaveLength(2);
    expect(await versionsOf(byTitle["B"])).toHaveLength(1);
    expect(await versionsOf(byTitle["C"])).toHaveLength(1);
  });

  test("create_artefact, a keyed re-create, update_artefact and a rename each record, sealed with the old payload kept", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "M3");
    const mcp = await connectMcp(request, { clientName: "sheet-agent" });
    const made = await mcp.call("create_artefact", { mindmap_id: board.id, type: "sheet", key: "s", title: "Budget", sheets: SHEET });
    const id = idIn(made.text);
    let rows = await expectVersions(id, 1);
    expect(rows[0]).toMatchObject({ op: "create", node_type: "sheet", status: "sealed", actor_client_name: "sheet-agent" });
    expect(rows[0]!.payload_key).toMatch(new RegExp(`^versions/${id}/`));
    expect(rows[0]!.payload_bytes).toBeGreaterThan(10);

    await mcp.call("create_artefact", { mindmap_id: board.id, type: "sheet", key: "s", title: "Budget", sheets: [{ name: "Q2", rows: [["x"]] }] });
    await mcp.call("update_artefact", { id, sheets: [{ name: "Q3", rows: [["y"]] }] });
    await mcp.call("update_artefact", { id, title: "Budget, renamed" });
    rows = await expectVersions(id, 4);
    expect(new Set(rows.map((r) => r.content_hash)).size).toBe(4);
    expect(rows[3]).toMatchObject({ title: "Budget, renamed" });
    expect(new Set(rows.map((r) => r.payload_key)).size).toBeGreaterThanOrEqual(3);
    // the same update again changes nothing
    await mcp.call("update_artefact", { id, title: "Budget, renamed" });
    await expectVersions(id, 4);
  });

  test("put_file makes one version for a new file node, and one for each file added to a folder", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "M4");
    const mcp = await connectMcp(request, { clientName: "filer" });
    const one = await mcp.call("put_file", { mindmap_id: board.id, name: "notes.md", content: "# hi", description: "notes" });
    expect(one.isError, one.text).toBe(false);
    const fileNode = idIn(one.text);
    const rows = await expectVersions(fileNode, 1);
    expect(rows[0]).toMatchObject({ op: "create", node_type: "file", actor_client_name: "filer" });
    expect(JSON.parse(rows[0]!.data_json!)).toMatchObject({ files: 1 });

    const f1 = await mcp.call("put_file", { mindmap_id: board.id, folder: "Box", name: "a.md", content: "# a", description: "a" });
    const folder = idIn(f1.text);
    await expectVersions(folder, 1);
    await mcp.call("put_file", { id: folder, name: "b.md", content: "# b", description: "b" });
    const fr = await expectVersions(folder, 2);
    expect(JSON.parse(fr[1]!.data_json!)).toMatchObject({ files: 2 });
  });
});

test.describe("provenance and windows across people and doors", () => {
  test("two agents and the app are each named; a different writer seals the last version", async ({ account, request }) => {
    const user = await me(request);
    const board = await createBoard(request, "P1");
    const one = await connectMcp(request, { clientName: "agent-one" });
    const two = await connectMcp(request, { clientName: "agent-two" });
    expect(one.credentials.clientId).not.toBe(two.credentials.clientId);

    const card = await createNode(request, board.id, { title: "Shared" });            // v1 web, open
    await one.call("update_card", { id: card.id, content: "from one" });             // v2 agent-one
    await two.call("update_card", { id: card.id, content: "from two" });             // v3 agent-two
    expect((await request.patch(`/api/nodes/${card.id}`, { data: { title: "Shared, by hand" } })).ok()).toBe(true); // v4 web, not folded into an agent's
    expect((await request.patch(`/api/nodes/${card.id}`, { data: { title: "Shared, by hand again" } })).ok()).toBe(true); // folds into v4
    const rows = await expectVersions(card.id, 4);
    expect(rows.map((r) => [r.actor_via, r.actor_client_name, r.status])).toEqual([
      ["web", null, "sealed"],
      ["mcp", "agent-one", "sealed"],
      ["mcp", "agent-two", "sealed"],
      ["web", null, "open"],
    ]);
    expect(rows.every((r) => r.actor_user_id === user.id)).toBe(true);
    expect(rows[1]!.actor_client_id).toBe(one.credentials.clientId);
    expect(rows[2]!.actor_client_id).toBe(two.credentials.clientId);
    expect(rows[3]!.title).toBe("Shared, by hand again");
    const head = (await headOf(card.id))!;
    expect(head).toMatchObject({ head_seq: 4, updated_by_user: user.id, updated_by_client: null });
    void account;
  });

  test("a human's open sheet is sealed with its payload before an agent replaces it; both stay recoverable", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "P2");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "Plan", sheets: SHEET });
    const got = await (await request.get(`/api/artefacts/${sheet.id}`)).json();
    const edited = JSON.parse(JSON.stringify(got).replace(`"value":3`, `"value":99`));
    expect((await request.put(`/api/artefacts/${sheet.id}`, { data: edited })).ok()).toBe(true);
    const human = (await expectVersions(sheet.id, 1))[0]!;
    expect(human.status).toBe("open");

    const agent = await connectMcp(request, { clientName: "overwriter" });
    await agent.call("update_artefact", { id: sheet.id, sheets: [{ name: "Z", rows: [["gone"]] }] });
    const rows = await expectVersions(sheet.id, 2);
    expect(rows[0]).toMatchObject({ seq: 1, status: "sealed", content_hash: human.content_hash });
    expect(rows[0]!.payload_key).toMatch(new RegExp(`^versions/${sheet.id}/`));
    expect(rows[1]).toMatchObject({ seq: 2, status: "sealed", actor_client_name: "overwriter" });
    expect(rows[1]!.payload_key).not.toBe(rows[0]!.payload_key);
  });

  test("a different person writing never folds into someone else's open version", async ({ account, request, makePerson }) => {
    void account;
    const other = await makePerson("editor");
    const board = await createBoard(request, "P3");
    expect((await request.post(`/api/boards/${board.id}/members`, { data: { email: other.user.email, role: "editor" } })).ok()).toBe(true);
    const card = await createNode(request, board.id, { title: "Ours" });
    expect((await other.request.patch(`/api/nodes/${card.id}`, { data: { title: "Theirs" } })).ok()).toBe(true);
    const rows = await expectVersions(card.id, 2);
    expect(rows.map((r) => r.status)).toEqual(["sealed", "open"]);
    expect(rows[0]!.actor_user_id).not.toBe(rows[1]!.actor_user_id);
  });
});

test.describe("what an agent reads back", () => {
  test("get_card says which version it is and who wrote it", async ({ account, request }) => {
    const board = await createBoard(request, "R1");
    const mcp = await connectMcp(request, { clientName: "agent-two" });
    const id = idIn((await mcp.call("add_card", { mindmap_id: board.id, title: "T", content: "a" })).text);
    expect((await mcp.call("get_card", { id })).text).toMatch(/v1 by agent-two \(MCP\)/);
    await mcp.call("update_card", { id, content: "b" });
    expect((await mcp.call("get_card", { id })).text).toMatch(/v2 by agent-two \(MCP\)/);
    expect((await request.patch(`/api/nodes/${id}`, { data: { title: "By hand" } })).ok()).toBe(true);
    expect((await mcp.call("get_card", { id })).text).toContain(`v3 by ${account.name} (web)`);
  });

  test("get_artefact says the same, for a sheet written in the app and rewritten by an agent", async ({ account, request }) => {
    const board = await createBoard(request, "R2");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "Plan", sheets: SHEET });
    const mcp = await connectMcp(request, { clientName: "agent-one" });
    expect((await mcp.call("get_artefact", { id: sheet.id })).text).toContain(`v1 by ${account.name} (web)`);
    await mcp.call("update_artefact", { id: sheet.id, sheets: [{ name: "Z", rows: [["n"]] }] });
    expect((await mcp.call("get_artefact", { id: sheet.id })).text).toMatch(/v2 by agent-one \(MCP\)/);
  });
});
