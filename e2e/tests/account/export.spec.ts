import { test, expect } from "../../fixtures";
import {
  addMember, createArtefact, createBoard, createEdge, createLink, createNode, createWorkspace, shareBoard, uploadFile,
} from "../../support/api";
import { exportZip, meId } from "../../support/account";
import { PIXEL_PNG } from "../../support/files";
import { allText, jsonEntry } from "../../support/zip";

// Self-serve export: GET /api/account/export answers with one zip of JSON plus
// the original files. Only what the signed-in user owns goes in; things shared
// with them are listed by reference and carry none of the owner's content.

const SHEET = [{ name: "Q1", rows: [["item", "cost"], ["tea", 3]] }];

test.describe("the export endpoint", () => {
  test("needs a session", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    expect((await anon.get("/api/account/export")).status()).toBe(401);
    await anon.dispose();
  });

  test("answers with a zip the browser saves as a download, never cached", async ({ account, request }) => {
    void account;
    const { res, body } = await exportZip(request);
    expect(res.headers()["content-type"]).toBe("application/zip");
    expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="mindmaps-export-\d{4}-\d{2}-\d{2}\.zip"$/);
    expect(res.headers()["cache-control"]).toMatch(/no-store/);
    expect(body.subarray(0, 2).toString()).toBe("PK");
  });

  test("a fresh account exports its manifest, its personal workspace and its starter mindmap", async ({ account, request }) => {
    const { zip } = await exportZip(request);
    const manifest = jsonEntry(zip, "manifest.json");
    expect(manifest).toMatchObject({ format: "mindmaps-export", version: 1 });
    expect(manifest.account).toMatchObject({ id: await meId(request), email: account.email, name: account.name });
    expect(jsonEntry(zip, "workspaces.json").map((w: any) => w.personal)).toEqual([1]);
    expect(jsonEntry(zip, "mindmaps.json").length).toBeGreaterThan(0);
    for (const name of ["cards.json", "links.json", "artefacts.json", "files.json", "versions.json", "shared-with-me.json", "sharing.json"])
      expect(Array.isArray(jsonEntry(zip, name)), name).toBe(true);
  });
});

test.describe("what the archive holds", () => {
  test("mindmaps, cards, links, artefact payloads, files, images and version metadata, all of the user's own", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Export me", { description: "about export" });
    const a = await createNode(request, board.id, { title: "Alpha card", body: "alpha body text", x: 0, y: 0 });
    const b = await createNode(request, board.id, { title: "Beta card", body: "beta body text", x: 300, y: 0 });
    const edge = await createEdge(request, { source_id: a.id, target_id: b.id, label: "relates to" });
    const sheet = await createArtefact(request, board.id, "sheet", { title: "Budget", sheets: SHEET } as any);
    const payload = await (await request.get(`/api/artefacts/${sheet.id}`)).json();

    const fileNode = await createArtefact(request, board.id, "file", { title: "Report" });
    const bytes = Buffer.from("quarterly findings\nsecond line, with ünïcode");
    const up = await uploadFile(request, fileNode.id, { name: "notes d'été.txt", type: "text/plain", data: bytes, description: "the notes" });
    expect(up.status()).toBe(201);

    const img = await request.post("/api/images", { data: PIXEL_PNG, headers: { "content-type": "image/png" } });
    const { key, url } = await img.json();
    const imageNode = await createNode(request, board.id, { type: "image", title: "pic", data: { url } as any });

    const { zip } = await exportZip(request);

    const boards = jsonEntry(zip, "mindmaps.json");
    expect(boards.find((x: any) => x.id === board.id)).toMatchObject({ name: "Export me", description: "about export" });

    const cards = jsonEntry(zip, "cards.json");
    expect(cards.find((x: any) => x.id === a.id)).toMatchObject({ title: "Alpha card", board_id: board.id });
    expect(cards.find((x: any) => x.id === a.id).body).toContain("alpha body text");
    expect(cards.find((x: any) => x.id === b.id).title).toBe("Beta card");

    expect(jsonEntry(zip, "links.json").find((x: any) => x.id === edge.id)).toMatchObject({
      source_id: a.id, target_id: b.id, label: "relates to",
    });

    const artefacts = jsonEntry(zip, "artefacts.json");
    const entry = artefacts.find((x: any) => x.node_id === sheet.id);
    expect(entry).toMatchObject({ type: "sheet", title: "Budget" });
    expect(JSON.parse(zip.get(entry.path)!.toString())).toEqual(payload);

    const files = jsonEntry(zip, "files.json");
    const f = files.find((x: any) => x.node_id === fileNode.id);
    expect(f).toMatchObject({ name: "notes d'été.txt", size: bytes.length, content_type: "text/plain", description: "the notes" });
    expect(zip.get(f.path)!.equals(bytes)).toBe(true);
    expect(f.path).toMatch(/^files\/[^/]+\/[^/]+$/);

    const images = zip.get(`images/${key}`);
    expect(images?.equals(PIXEL_PNG)).toBe(true);
    expect(cards.find((x: any) => x.id === imageNode.id)).toBeTruthy();

    const versions = jsonEntry(zip, "versions.json");
    const mine = versions.filter((v: any) => v.node_id === sheet.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]).toMatchObject({ node_type: "sheet", op: "create", actor_via: "web", actor: "you" });
    expect(mine[0]).not.toHaveProperty("doc");
    expect(mine[0]).not.toHaveProperty("body");
    expect(mine[0]).not.toHaveProperty("payload_key");
  });

  test("no entry escapes the archive: names are plain relative paths", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Names");
    const node = await createArtefact(request, board.id, "file", { title: "F" });
    expect((await uploadFile(request, node.id, { name: "../../etc/passwd", type: "text/plain", data: "x" })).status()).toBe(201);
    const { zip } = await exportZip(request);
    for (const name of zip.keys()) {
      expect(name, name).not.toMatch(/^\/|\.\.\/|\\|[\x00-\x1f]/);
    }
    expect([...zip.keys()].some((n) => n.startsWith("files/"))).toBe(true);
  });
});

test.describe("what the archive leaves out", () => {
  test("another person's content and identity never appear, even where they share with the user", async ({ account, request, makePerson }) => {
    const me = await meId(request);
    const other = await makePerson("other");
    const otherId = await meId(other.request);

    // The other person's own content, plus things they hand to this user.
    const secretBoard = await createBoard(other.request, "OTHER-BOARD-NAME-8841");
    await createNode(other.request, secretBoard.id, { title: "OTHER-CARD-TITLE-8841", body: "OTHER-CARD-BODY-8841" });
    const sharedBoard = await createBoard(other.request, "OTHER-SHARED-BOARD-8841");
    const sharedCard = await createNode(other.request, sharedBoard.id, { title: "OTHER-SHARED-CARD-8841", body: "OTHER-SHARED-BODY-8841" });
    await shareBoard(other.request, sharedBoard.id, account.email, "viewer");
    const grantBoard = await createBoard(other.request, "OTHER-GRANT-BOARD-8841");
    const grantSheet = await createArtefact(other.request, grantBoard.id, "sheet", { title: "OTHER-SHEET-8841", sheets: SHEET } as any);
    await addMember(other.request, "artefacts", grantSheet.id, account.email, "editor");
    const ws = await createWorkspace(other.request, "OTHER-WORKSPACE-8841");
    await addMember(other.request, "workspaces", ws.id, account.email, "editor");

    // What this user has, shared outward to the other person.
    const mine = await createBoard(request, "Mine");
    await createNode(request, mine.id, { title: "mine", body: "mine" });
    await shareBoard(request, mine.id, other.user.email, "editor");
    const mineSheet = await createArtefact(request, mine.id, "sheet", { title: "Mine sheet", sheets: SHEET } as any);
    const link = await createLink(request, mineSheet.id);

    const { zip } = await exportZip(request);
    const text = allText(zip);

    // none of the other person's content or identity
    for (const needle of [
      "OTHER-BOARD-NAME-8841", "OTHER-CARD-TITLE-8841", "OTHER-CARD-BODY-8841", "OTHER-SHARED-CARD-8841",
      "OTHER-SHARED-BODY-8841", "OTHER-SHEET-8841", other.user.email, other.user.name, otherId,
    ])
      expect(text.includes(needle), `archive mentions ${needle}`).toBe(false);
    // nor the secret a link share is made of
    expect(text.includes(link.token)).toBe(false);
    expect(zip.has(`cards/${sharedCard.id}.json`)).toBe(false);
    expect(jsonEntry(zip, "cards.json").some((c: any) => c.id === sharedCard.id)).toBe(false);
    expect(jsonEntry(zip, "mindmaps.json").some((b: any) => b.id === sharedBoard.id)).toBe(false);
    expect(jsonEntry(zip, "workspaces.json").some((w: any) => w.id === ws.id)).toBe(false);

    // shared with this user: by reference, with the role and nothing of the content
    const refs = jsonEntry(zip, "shared-with-me.json");
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "mindmap", id: sharedBoard.id, role: "viewer" }),
        expect.objectContaining({ kind: "artefact", id: grantSheet.id, role: "editor" }),
        expect.objectContaining({ kind: "workspace", id: ws.id, role: "editor" }),
      ]),
    );
    for (const r of refs) expect(Object.keys(r).sort()).toEqual(["id", "kind", "role"]);

    // shared by this user: counted by role, no one identified
    const sharing = jsonEntry(zip, "sharing.json");
    expect(sharing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "mindmap", id: mine.id, role: "editor", people: 1 }),
        expect.objectContaining({ kind: "artefact", id: mineSheet.id, links: 1 }),
      ]),
    );
    void me;
  });

  test("a second user's export has none of the first's data", async ({ account, request, makePerson }) => {
    void account;
    const board = await createBoard(request, "First user board");
    await createNode(request, board.id, { title: "FIRST-USER-CARD-5530", body: "FIRST-USER-BODY-5530" });
    const second = await makePerson("second");
    const { zip } = await exportZip(second.request);
    expect(allText(zip)).not.toContain("FIRST-USER");
    expect(jsonEntry(zip, "mindmaps.json").some((b: any) => b.id === board.id)).toBe(false);
  });

  test("a mindmap in a workspace the user owns is exported, with the member count but not the members", async ({ account, request, makePerson }) => {
    void account;
    const member = await makePerson("member");
    const ws = await createWorkspace(request, "Team space");
    await addMember(request, "workspaces", ws.id, member.user.email, "editor");
    const board = await createBoard(request, "In team space", { workspace_id: ws.id });
    const { zip } = await exportZip(request);
    expect(jsonEntry(zip, "workspaces.json").find((w: any) => w.id === ws.id)).toMatchObject({ name: "Team space", personal: 0, members: 1 });
    expect(jsonEntry(zip, "mindmaps.json").some((b: any) => b.id === board.id)).toBe(true);
    expect(allText(zip)).not.toContain(member.user.email);
  });
});
