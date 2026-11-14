import { randomUUID } from "node:crypto";
import { test, expect } from "../../fixtures";
import {
  addMember, contents, createArtefact, createBoard, createEdge, createNode, deleteNode, listFiles, membersOf, nodeById, uploadFile,
} from "../../support/api";
import { connectMcp } from "../../support/mcp";

// Authorisation regressions that were found by reading the routes and trying
// them: things one person must not be able to do to another person's data.
// (Reads and plain writes across workspaces are in workspaces/isolation.spec.ts.)

test.describe("ids are not credentials", () => {
  test("asking to create a node with an id that is taken is a 409 and leaves the other node alone", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const card = await createNode(request, board.id, { title: "Original", x: 0, y: 0 });
    const mine = await createBoard(existing.request, "Theirs");
    const res = await existing.request.post("/api/nodes", { data: { id: card.id, board_id: mine.id, type: "card", title: "Takeover" } });
    expect(res.status()).toBe(409);
    expect((await contents(request, board.id)).nodes.map((n) => n.title)).toEqual(["Original"]);
    expect((await contents(existing.request, mine.id)).nodes).toEqual([]);
  });

  test("the same id on the owner's own mindmap is refused too, not duplicated or replaced", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Mine");
    const card = await createNode(request, board.id, { title: "Original", x: 5, y: 6 });
    const res = await request.post("/api/nodes", { data: { id: card.id, board_id: board.id, type: "card", title: "Again" } });
    expect(res.status()).toBe(409);
    const nodes = (await contents(request, board.id)).nodes;
    expect(nodes.map((n) => [n.title, n.x, n.y])).toEqual([["Original", 5, 6]]);
  });

  test("creating a node with the id of someone else's artefact does not overwrite its contents", async ({ account, request, existing }) => {
    // POST /api/nodes used to write the artefact payload to R2 (`artefacts/<id>`)
    // before inserting the row, so a refused insert had already replaced the
    // owner's payload. Anyone who knew the id (a viewer, a grantee, anyone who
    // had seen it) could rewrite another person's sheet, document, deck or page.
    void account;
    const board = await createBoard(request, "Owner's");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "Victim", sheets: [{ name: "Original", rows: [["secret", 1]] }] });
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const mine = await createBoard(existing.request, "Theirs");
    const before = JSON.stringify(await (await request.get(`/api/artefacts/${sheet.id}`)).json());

    const res = await existing.request.post("/api/nodes", {
      data: { id: sheet.id, board_id: mine.id, type: "sheet", title: "x", sheets: [{ name: "Pwned", rows: [["pwned", 1]] }] },
    });
    expect(res.status()).toBe(409);
    const after = JSON.stringify(await (await request.get(`/api/artefacts/${sheet.id}`)).json());
    expect(after).toContain("secret");
    expect(after).not.toContain("Pwned");
    expect(after).toBe(before);
    // the owner's node row is unchanged and nothing appeared on the attacker's mindmap
    expect(await nodeById(request, sheet.id)).toMatchObject({ board_id: board.id, type: "sheet", title: "Victim" });
    expect((await contents(existing.request, mine.id)).nodes).toEqual([]);
  });

  test("a stranger who knows only the id of a document cannot overwrite it either, whatever kind they claim", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const doc = await createArtefact(request, board.id, "doc", { title: "Notes", blocks: ["the original text"] });
    const mine = await createBoard(existing.request, "Theirs");
    const before = JSON.stringify(await (await request.get(`/api/artefacts/${doc.id}`)).json());
    expect(before).toContain("the original text");

    for (const attempt of [
      { type: "doc", blocks: ["pwned doc"] },
      { type: "sheet", sheets: [{ name: "Pwned", rows: [["pwned sheet"]] }] },
      { type: "deck", slides: [{ title: "pwned deck" }] },
      { type: "html", html: "<p>pwned page</p>" },
    ]) {
      const res = await existing.request.post("/api/nodes", { data: { id: doc.id, board_id: mine.id, title: "x", ...attempt } });
      expect(res.status(), attempt.type).toBe(409);
    }
    expect(JSON.stringify(await (await request.get(`/api/artefacts/${doc.id}`)).json())).toBe(before);
    expect((await contents(existing.request, mine.id)).nodes).toEqual([]);
  });

  test("a file or folder id that is taken is refused and its file is untouched", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const file = await createArtefact(request, board.id, "file", { title: "Report" });
    expect((await uploadFile(request, file.id, { name: "r.txt", type: "text/plain", data: "owner bytes", description: "the report" })).ok()).toBe(true);
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const mine = await createBoard(existing.request, "Theirs");

    for (const type of ["file", "folder", "image"]) {
      const res = await existing.request.post("/api/nodes", { data: { id: file.id, board_id: mine.id, type, title: "x" } });
      expect(res.status(), type).toBe(409);
    }
    const files = await listFiles(request, file.id);
    expect(files.map((f) => f.name)).toEqual(["r.txt"]);
    expect(await (await request.get(files[0]!.url!)).text()).toBe("owner bytes");
    expect((await contents(existing.request, mine.id)).nodes).toEqual([]);
  });

  test("two creates racing for one fresh id: one wins, the other gets a 409, and the stored payload is the winner's", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Race");
    const nodeId = randomUUID();
    const make = (word: string) =>
      request.post("/api/nodes", { data: { id: nodeId, board_id: board.id, type: "doc", title: word, blocks: [`only ${word}`] } });
    const results = await Promise.all([make("first"), make("second")]);
    expect(results.map((r) => r.status()).sort()).toEqual([201, 409]);
    const winner = (await nodeById(request, nodeId)).title;
    const payload = JSON.stringify(await (await request.get(`/api/artefacts/${nodeId}`)).json());
    expect(payload).toContain(`only ${winner}`);
    expect(payload).not.toContain(`only ${winner === "first" ? "second" : "first"}`);
  });

  test("a deleted artefact's id cannot be claimed by someone else, and the owner's undo still brings it back", async ({ account, request, existing }) => {
    // The object stays in R2 for a week after a delete so undo works; a create
    // under that id by anyone else must not replace it.
    void account;
    const board = await createBoard(request, "Owner's");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "Gone", sheets: [{ name: "Original", rows: [["secret", 1]] }] });
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const mine = await createBoard(existing.request, "Theirs");
    await deleteNode(request, sheet.id);

    const res = await existing.request.post("/api/nodes", {
      data: { id: sheet.id, board_id: mine.id, type: "sheet", title: "x", sheets: [{ name: "Pwned", rows: [["pwned", 1]] }] },
    });
    expect(res.status()).toBe(409);
    expect((await contents(existing.request, mine.id)).nodes).toEqual([]);

    // what the web app's undo sends: the node it captured, a pointer and no payload
    const undo = await request.post("/api/nodes", { data: { id: sheet.id, board_id: board.id, type: "sheet", title: "Gone", data: sheet.data } });
    expect(undo.status()).toBe(201);
    const back = JSON.stringify(await (await request.get(`/api/artefacts/${sheet.id}`)).json());
    expect(back).toContain("secret");
    expect(back).not.toContain("Pwned");
  });

  test("a chosen id that is free still works, and a restore of an existing artefact never rewrites its payload", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Mine");
    const chosen = randomUUID();
    const made = await request.post("/api/nodes", { data: { id: chosen, board_id: board.id, type: "doc", title: "Chosen", blocks: ["kept"] } });
    expect(made.status()).toBe(201);
    expect((await made.json()).id).toBe(chosen);
    expect(JSON.stringify(await (await request.get(`/api/artefacts/${chosen}`)).json())).toContain("kept");

    // undo after a delete of this one: same id, pointer only
    const node = await nodeById(request, chosen);
    await deleteNode(request, chosen);
    const restored = await request.post("/api/nodes", { data: { id: chosen, board_id: board.id, type: "doc", title: "Chosen", data: node.data } });
    expect(restored.status()).toBe(201);
    expect(JSON.stringify(await (await request.get(`/api/artefacts/${chosen}`)).json())).toContain("kept");
    expect((await nodeById(request, chosen)).data).toMatchObject({ kind: "doc" });
  });

  test("a restore that points at a missing payload is still a 410 and writes nothing", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Mine");
    const ghost = randomUUID();
    const res = await request.post("/api/nodes", { data: { id: ghost, board_id: board.id, type: "doc", title: "Ghost", data: { r2: `artefacts/${ghost}`, kind: "doc" } } });
    expect(res.status()).toBe(410);
    expect((await request.get(`/api/nodes/${ghost}`)).status()).toBe(404);
    expect((await request.get(`/api/artefacts/${ghost}`)).status()).toBe(404);
  });

  test("a create the caller may not make leaves no object behind", async ({ account, request, existing }) => {
    // Not allowed on that mindmap: refused before anything is written, under a
    // fresh id nobody could later find an orphan for.
    void account;
    const board = await createBoard(request, "Owner's");
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const nodeId = randomUUID();
    const res = await existing.request.post("/api/nodes", { data: { id: nodeId, board_id: board.id, type: "sheet", title: "x", sheets: [{ name: "S", rows: [["a"]] }] } });
    expect(res.status()).toBe(403);
    expect((await request.get(`/api/artefacts/${nodeId}`)).status()).toBe(404);
    // and the id is still free for its rightful use
    const ok = await request.post("/api/nodes", { data: { id: nodeId, board_id: board.id, type: "sheet", title: "x", sheets: [{ name: "S", rows: [["fine"]] }] } });
    expect(ok.status()).toBe(201);
    expect(JSON.stringify(await (await request.get(`/api/artefacts/${nodeId}`)).json())).toContain("fine");
  });

  test("creating a link with the id of someone else's link does not replace it", async ({ account, request, existing }) => {
    // POST /api/edges was INSERT OR REPLACE keyed on the id the caller supplied
    // and only checked that the caller may write the two cards named in the
    // request (their own). A viewer who had seen the id (it is in the mindmap's
    // contents) could delete the owner's link by re-creating it between two of
    // their own cards.
    void account;
    const board = await createBoard(request, "Owner's");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "owner's link", source_handle: "right", target_handle: "left" });
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const mine = await createBoard(existing.request, "Theirs");
    const m1 = await createNode(existing.request, mine.id, { title: "m1", x: 0, y: 0 });
    const m2 = await createNode(existing.request, mine.id, { title: "m2", x: 300, y: 0 });
    const before = (await contents(request, board.id)).edges;

    const res = await existing.request.post("/api/edges", { data: { id: edge.id, source_id: m1.id, target_id: m2.id, label: "hijacked" } });
    expect(res.status()).toBe(409);
    expect((await contents(request, board.id)).edges.map((e) => e.label)).toEqual(["owner's link"]);
    // untouched in every column, not just the label
    expect((await contents(request, board.id)).edges).toEqual(before);
    // and nothing appeared on the attacker's side
    expect((await contents(existing.request, mine.id)).edges).toEqual([]);
  });

  test("an editor of the mindmap cannot take over an existing link's id either, even between cards they may write", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Shared");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const c = await createNode(request, board.id, { title: "C", x: 600, y: 0 });
    const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "original" });
    await addMember(request, "boards", board.id, existing.user.email, "editor");
    const before = (await contents(request, board.id)).edges;

    for (const attempt of [
      { source_id: a.id, target_id: c.id, label: "original" }, // other end
      { source_id: b.id, target_id: a.id, label: "original" }, // reversed
      { source_id: a.id, target_id: b.id, label: "relabelled" }, // other label
      { source_id: a.id, target_id: b.id, label: "original", source_handle: "top" }, // other side
    ]) {
      const res = await existing.request.post("/api/edges", { data: { id: edge.id, ...attempt } });
      expect(res.status(), JSON.stringify(attempt)).toBe(409);
    }
    expect((await contents(request, board.id)).edges).toEqual(before);
  });

  test("sending the very same link again is an idempotent retry: it is answered with the stored link and changes nothing", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Mine");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "kept", source_handle: "right", target_handle: "left" });
    const before = (await contents(request, board.id)).edges;

    const again = await request.post("/api/edges", {
      data: { id: edge.id, source_id: a.id, target_id: b.id, label: "kept", source_handle: "right", target_handle: "left" },
    });
    expect(again.status()).toBe(200);
    expect(await again.json()).toMatchObject({ id: edge.id, source_id: a.id, target_id: b.id, label: "kept" });
    expect((await contents(request, board.id)).edges).toEqual(before);

    // a retry that carries different content is not a retry
    const changed = await request.post("/api/edges", { data: { id: edge.id, source_id: a.id, target_id: b.id, label: "other" } });
    expect(changed.status()).toBe(409);
    expect((await contents(request, board.id)).edges).toEqual(before);
  });

  test("a deleted link can be created again under its own id (what undo and redo send)", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Mine");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "back" });
    expect((await request.delete(`/api/edges/${edge.id}`)).ok()).toBe(true);
    expect((await contents(request, board.id)).edges).toEqual([]);

    const res = await request.post("/api/edges", { data: { id: edge.id, source_id: a.id, target_id: b.id, label: "back" } });
    expect(res.status()).toBe(201);
    expect((await contents(request, board.id)).edges.map((e) => [e.id, e.label])).toEqual([[edge.id, "back"]]);
  });

  test("a link without an id still gets one, and two such links are two links", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Mine");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const one = await createEdge(request, { source_id: a.id, target_id: b.id });
    const two = await createEdge(request, { source_id: a.id, target_id: b.id });
    expect(one.id).not.toBe(two.id);
    expect((await contents(request, board.id)).edges).toHaveLength(2);
  });

  test("a link's end cannot be moved onto a card the caller cannot write", async ({ account, request, existing }) => {
    // PATCH /api/edges/:id checked the edge's current ends and then accepted any
    // new source_id / target_id, so a link of your own could be pointed at a
    // card on someone else's mindmap, which then showed it.
    void account;
    const board = await createBoard(request, "Owner's");
    const secret = await createNode(request, board.id, { title: "Owner's card", x: 0, y: 0 });
    const readOnly = await createNode(request, board.id, { title: "Read only", x: 0, y: 200 });
    await addMember(request, "boards", board.id, existing.user.email, "viewer");

    const mine = await createBoard(existing.request, "Theirs");
    const m1 = await createNode(existing.request, mine.id, { title: "m1", x: 0, y: 0 });
    const m2 = await createNode(existing.request, mine.id, { title: "m2", x: 300, y: 0 });
    const m3 = await createNode(existing.request, mine.id, { title: "m3", x: 600, y: 0 });
    const link = await createEdge(existing.request, { source_id: m1.id, target_id: m2.id });

    // a viewer of the card: seen, not writable
    expect((await existing.request.patch(`/api/edges/${link.id}`, { data: { target_id: readOnly.id } })).status()).toBe(404);
    // not seen at all: the same answer
    expect((await existing.request.patch(`/api/edges/${link.id}`, { data: { source_id: randomUUID() } })).status()).toBe(404);
    expect((await contents(request, board.id)).edges).toEqual([]);
    expect((await contents(existing.request, mine.id)).edges.map((e) => [e.source_id, e.target_id])).toEqual([[m1.id, m2.id]]);
    void secret;

    // re-attaching to a card of their own still works, together with a label
    const ok = await existing.request.patch(`/api/edges/${link.id}`, { data: { target_id: m3.id, label: "moved" } });
    expect(ok.ok()).toBe(true);
    expect((await contents(existing.request, mine.id)).edges.map((e) => [e.target_id, e.label])).toEqual([[m3.id, "moved"]]);
  });
});

test.describe("links between cards", () => {
  test("need write access to both ends; one end you cannot see is a 404", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const theirs = await createNode(request, board.id, { title: "Theirs", x: 0, y: 0 });
    const mineBoard = await createBoard(existing.request, "Mine");
    const mine = await createNode(existing.request, mineBoard.id, { title: "Mine", x: 0, y: 0 });
    const res = await existing.request.post("/api/edges", { data: { source_id: mine.id, target_id: theirs.id } });
    expect(res.status()).toBe(404);
    expect((await contents(existing.request, mineBoard.id)).edges).toEqual([]);
  });

  test("a viewer cannot edit or delete an existing link", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "keep" });
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    expect((await existing.request.patch(`/api/edges/${edge.id}`, { data: { label: "changed" } })).status()).toBe(404);
    expect((await existing.request.delete(`/api/edges/${edge.id}`)).status()).toBe(404);
    expect((await contents(request, board.id)).edges.map((e) => e.label)).toEqual(["keep"]);
  });
});

test.describe("a made-up id and a real one look the same", () => {
  test("members, files, shares and frames of ids that do not exist", async ({ account, request }) => {
    void account;
    const missing = randomUUID();
    for (const path of [
      `/api/boards/${missing}/members`,
      `/api/workspaces/${missing}/members`,
      `/api/artefacts/${missing}`,
      `/api/artefacts/${missing}/frame`,
      `/api/nodes/${missing}/files`,
      `/api/nodes/${missing}`,
    ]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
    expect((await request.delete(`/api/files/${missing}`)).status()).toBe(404);
    expect((await request.delete(`/api/shares/${missing}`)).status()).toBe(404);
    expect((await request.delete(`/api/invites/${missing}`)).status()).toBe(404);
  });

  test("only whoever sent an invite can revoke it", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Inviting");
    const sent = await addMember(request, "boards", board.id, "nobody-yet@example.test");
    const token = sent.invited!.token;
    expect((await existing.request.delete(`/api/invites/${token}`)).status()).toBe(404);
    expect((await request.delete(`/api/invites/${token}`)).ok()).toBe(true);
    expect((await membersOf(request, "boards", board.id)).pending).toEqual([]);
  });
});

test.describe("links over MCP", () => {
  // update_link and unlink_cards accepted any link the caller could *read*, so a
  // viewer's agent could relabel or delete the owner's links by id.
  test("an agent of a viewer cannot relabel or remove the owner's link", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "keep", source_handle: "right", target_handle: "left" });
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const before = (await contents(request, board.id)).edges;
    const agent = await connectMcp(existing.request);

    const relabel = await agent.call("update_link", { id: edge.id, label: "changed", direction: "down" });
    expect(relabel.isError).toBe(true);
    const removed = await agent.call("unlink_cards", { id: edge.id });
    expect(removed.isError).toBe(true);
    const byPair = await agent.call("unlink_cards", { from: a.id, to: b.id });
    expect(byPair.isError).toBe(true);
    expect((await contents(request, board.id)).edges).toEqual(before);
  });

  test("an agent of someone with no access to the mindmap gets the same refusal", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "keep" });
    const before = (await contents(request, board.id)).edges;
    const agent = await connectMcp(existing.request);
    expect((await agent.call("update_link", { id: edge.id, label: "changed" })).isError).toBe(true);
    expect((await agent.call("unlink_cards", { id: edge.id })).isError).toBe(true);
    expect((await contents(request, board.id)).edges).toEqual(before);
  });

  test("an editor's agent can still relabel and remove a link by id, and by the cards it joins", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Shared");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const c = await createNode(request, board.id, { title: "C", x: 600, y: 0 });
    const first = await createEdge(request, { source_id: a.id, target_id: b.id, label: "one" });
    await createEdge(request, { source_id: b.id, target_id: c.id, label: "two" });
    await addMember(request, "boards", board.id, existing.user.email, "editor");
    const agent = await connectMcp(existing.request);

    const relabel = await agent.call("update_link", { id: first.id, label: "renamed" });
    expect(relabel.isError, relabel.text).toBe(false);
    expect((await contents(request, board.id)).edges.map((e) => e.label).sort()).toEqual(["renamed", "two"]);
    const byId = await agent.call("unlink_cards", { id: first.id });
    expect(byId.isError, byId.text).toBe(false);
    const byPair = await agent.call("unlink_cards", { from: b.id, to: c.id });
    expect(byPair.isError, byPair.text).toBe(false);
    expect((await contents(request, board.id)).edges).toEqual([]);
  });

  test("the owner's agent works on its own links", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Mine");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "mine" });
    const agent = await connectMcp(request);
    expect((await agent.call("update_link", { id: edge.id, label: "still mine" })).isError).toBe(false);
    expect((await contents(request, board.id)).edges.map((e) => e.label)).toEqual(["still mine"]);
    expect((await agent.call("unlink_cards", { id: edge.id })).isError).toBe(false);
    expect((await contents(request, board.id)).edges).toEqual([]);
  });
});
