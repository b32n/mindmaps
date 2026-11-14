import { randomUUID } from "node:crypto";
import { test, expect } from "../../fixtures";
import { addMember, contents, createArtefact, createBoard, createEdge, createNode, membersOf } from "../../support/api";

// Authorisation regressions that were found by reading the routes and trying
// them: things one person must not be able to do to another person's data.
// (Reads and plain writes across workspaces are in workspaces/isolation.spec.ts.)

test.describe("ids are not credentials", () => {
  test("asking to create a node with an id that is taken fails and leaves the other node alone", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Owner's");
    const card = await createNode(request, board.id, { title: "Original", x: 0, y: 0 });
    const mine = await createBoard(existing.request, "Theirs");
    const res = await existing.request.post("/api/nodes", { data: { id: card.id, board_id: mine.id, type: "card", title: "Takeover" } });
    expect(res.ok()).toBe(false);
    expect((await contents(request, board.id)).nodes.map((n) => n.title)).toEqual(["Original"]);
    expect((await contents(existing.request, mine.id)).nodes).toEqual([]);
  });

  test.fixme("creating a node with the id of someone else's artefact does not overwrite its contents", async ({ account, request, existing }) => {
    // Expected: the attempt is refused (it already fails with a 500 on the
    // primary key) and the existing artefact is untouched. Actual:
    // POST /api/nodes writes the artefact payload to R2 (`artefacts/<id>`)
    // BEFORE inserting the row, so the insert fails but the owner's payload
    // has already been replaced. Anyone who knows the id (a viewer, a person
    // it was granted to, or anyone who has seen it) can rewrite another
    // person's sheet, document, deck or page. Observed with a viewer of the
    // owner's mindmap: the owner's sheet read back as the viewer's "Pwned"
    // sheet; and with an unrelated account that knew only the id of a doc.
    void account;
    const board = await createBoard(request, "Owner's");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "Victim", sheets: [{ name: "Original", rows: [["secret", 1]] }] });
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const mine = await createBoard(existing.request, "Theirs");

    await existing.request.post("/api/nodes", {
      data: { id: sheet.id, board_id: mine.id, type: "sheet", title: "x", sheets: [{ name: "Pwned", rows: [["pwned", 1]] }] },
    });
    const after = JSON.stringify(await (await request.get(`/api/artefacts/${sheet.id}`)).json());
    expect(after).toContain("secret");
    expect(after).not.toContain("Pwned");
  });

  test.fixme("creating a link with the id of someone else's link does not replace it", async ({ account, request, existing }) => {
    // Expected: a link (edge) id that already exists is refused, or at least
    // only its owner can rewrite it. Actual: POST /api/edges is
    // INSERT OR REPLACE keyed on the id the caller supplies, and only checks
    // that the caller may write the two nodes named in the request (their own).
    // So a viewer who has seen the id (it is in the mindmap's contents) can
    // delete the owner's link by re-creating it between two of their own
    // cards: the owner's mindmap loses the link. Observed: the owner's edge
    // list went from one link to none.
    void account;
    const board = await createBoard(request, "Owner's");
    const a = await createNode(request, board.id, { title: "A", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "B", x: 300, y: 0 });
    const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "owner's link" });
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    const mine = await createBoard(existing.request, "Theirs");
    const m1 = await createNode(existing.request, mine.id, { title: "m1", x: 0, y: 0 });
    const m2 = await createNode(existing.request, mine.id, { title: "m2", x: 300, y: 0 });

    await existing.request.post("/api/edges", { data: { id: edge.id, source_id: m1.id, target_id: m2.id, label: "hijacked" } });
    expect((await contents(request, board.id)).edges.map((e) => e.label)).toEqual(["owner's link"]);
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
