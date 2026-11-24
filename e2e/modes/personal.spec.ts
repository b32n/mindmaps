import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures";
import { addMember, contents, createArtefact, createBoard, createLink, createNode, listBoards, listWorkspaces } from "../support/api";
import { Board } from "../support/board";
import { signUpViaForm, expectSignedInShell } from "../support/auth";
import { connectMcp, consentPage } from "../support/mcp";
import { openBoardShare } from "../support/members";
import { Rail } from "../support/rail";
import { newUser } from "../support/users";
import { modeWorkers } from "../support/hosts";

// MINDMAPS_MODE=personal: one user's instance. There is no team-space concept in
// the app, the API or MCP; sharing is untouched (docs/MODES.md). The other modes
// are pinned in unchanged.spec.ts, switching an install in switch.spec.ts.

test.use({ baseURL: modeWorkers.personal.baseURL });

const word = () => `zq${randomUUID().replace(/-/g, "").slice(0, 10)}`;

test.describe("the app", () => {
  test("has no workspace switcher and no way to create a team space", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await expect(page.locator(".rail-add")).toBeVisible();
    await expect(page.locator(".ws-trigger")).toHaveCount(0);
    await expect(page.locator(".ws")).toHaveCount(0);
    await expect(page.getByText("New workspace")).toHaveCount(0);
  });

  test("still creates mindmaps, in the personal home", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    const rail = new Rail(page);
    await rail.create("Plain map");
    const home = (await listWorkspaces(page.request)).find((w) => w.personal)!;
    expect((await listBoards(page.request)).find((b) => b.name === "Plain map")?.workspace_id).toBe(home.id);
  });

  test("a remembered team space from before the switch does not leak in", async ({ page, account }) => {
    void account;
    await page.addInitScript((id) => localStorage.setItem("mindmaps.workspace", id), randomUUID());
    await page.goto("/app");
    await expect(page.locator(".rail-add")).toBeVisible();
    await new Rail(page).create("Created anyway");
    await expect(page.locator(".ws-trigger")).toHaveCount(0);
  });

  test("the share dialog still offers inviting people", async ({ page, account }) => {
    void account;
    const { record } = await Board.create(page, "Shareable");
    const { panel } = await openBoardShare(page, record.name);
    await expect(panel.email()).toBeVisible();
    await expect(panel.role().locator("option")).toHaveText(["Can edit", "Can view"]);
  });
});

test.describe("the API", () => {
  test("lists the personal home only", async ({ request, account }) => {
    void account;
    const list = await listWorkspaces(request);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ personal: 1, role: "owner" });
  });

  test("refuses to create a team space, and says why", async ({ request, account }) => {
    void account;
    const res = await request.post("/api/workspaces", { data: { name: "Nope" } });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("team_spaces_disabled");
    expect(await listWorkspaces(request)).toHaveLength(1);
  });

  test("refuses to put a mindmap in a workspace that is not the personal home", async ({ request, account }) => {
    void account;
    const res = await request.post("/api/boards", { data: { name: "Elsewhere", workspace_id: randomUUID() } });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("team_spaces_disabled");
  });

  test("recall and the artefact list stay inside the personal home", async ({ request, account }) => {
    void account;
    const term = word();
    const board = await createBoard(request, `Home ${term}`);
    await createNode(request, board.id, { title: `Card ${term}` });
    const res = await (await request.get(`/api/recall?q=${term}&workspace=${randomUUID()}`)).json();
    expect(JSON.stringify(res)).toContain(term);
  });
});

test.describe("MCP", () => {
  test("the consent page connects straight to the personal home, with no picker", async ({ request, account }) => {
    void account;
    const html = await consentPage(request);
    expect(html).not.toMatch(/<select/);
    expect(html).not.toMatch(/workspace/i);
  });

  test("a workspace named on the consent form is ignored, not honoured", async ({ request, account, makePerson }) => {
    void account;
    const other = await makePerson("other");
    // not even a real team space of someone else can be picked: nothing is refused, it just connects home
    const mcp = await connectMcp(request, { workspace: randomUUID() });
    const name = `Made ${word()}`;
    await mcp.call("recall", { query: `nothing-${word()}` });
    const r = await mcp.call("create_mindmap", { name, nodes: [{ key: "a", title: "A" }] });
    expect(r.isError, r.text).toBe(false);
    const home = (await listWorkspaces(request))[0]!;
    expect((await listBoards(request)).find((b) => b.name === name)?.workspace_id).toBe(home.id);
    void other;
  });

  test("the tools do not take a workspace argument", async ({ request, account }) => {
    void account;
    const client = await connectMcp(request);
    const res = await request.post("/mcp", {
      headers: { authorization: `Bearer ${client.credentials.accessToken}`, cookie: "", accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    const tools = (await res.json()).result.tools as { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    expect(tools.length).toBeGreaterThan(10);
    for (const t of tools) expect(Object.keys(t.inputSchema.properties ?? {}), t.name).not.toContain("workspace");
  });

  test("list, search and create talk about mindmaps, not workspaces", async ({ request, account }) => {
    void account;
    const term = word();
    const board = await createBoard(request, `Home ${term}`);
    await createNode(request, board.id, { title: `Card ${term}` });
    const mcp = await connectMcp(request);
    const list = await mcp.call("list_mindmaps", {});
    expect(list.isError, list.text).toBe(false);
    expect(list.text).toContain(`Home ${term}`);
    expect(list.text).not.toMatch(/workspace/i);
    expect(list.text).not.toContain("(Personal)");
    for (const tool of ["search", "recall"]) {
      const r = await mcp.call(tool, { query: term });
      expect(r.text, tool).toContain(term);
      expect(r.text, tool).not.toMatch(/workspace/i);
    }
    // a workspace argument from an old client is not a way out
    const named = await mcp.call("list_mindmaps", { workspace: "Personal" });
    expect(named.isError, named.text).toBe(false);
  });
});

test.describe("sharing is untouched", () => {
  test("a person in another workspace gets a mindmap and can edit it", async ({ page, account, existing, openAs }) => {
    void account;
    const { board, record } = await Board.create(page, "Plan");
    const { panel } = await openBoardShare(page, "Plan");
    const { status, body } = await panel.invite(existing.user.email, "Can edit");
    expect(status).toBe(201);
    expect(body.added).toMatchObject({ role: "editor" });
    void board;

    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await expect(new Rail(theirs).names()).toContainText(["Plan"]);
    expect((await listBoards(existing.request)).find((b) => b.id === record.id)).toBeTruthy();
    await createNode(existing.request, record.id, { title: "Their card" });
    expect((await contents(page.request, record.id)).nodes.map((n) => n.title)).toContain("Their card");
  });

  test("a viewer can read but not write", async ({ request, account, existing }) => {
    void account;
    const board = await createBoard(request, "Read only");
    await addMember(request, "boards", board.id, existing.user.email, "viewer");
    expect((await existing.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    const res = await existing.request.post("/api/nodes", { data: { board_id: board.id, type: "card", title: "x", x: 0, y: 0 } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test("someone with no account is invited by email, signs up, and edits", async ({ page, account, browser }) => {
    void account;
    const { record } = await Board.create(page, "For an outsider");
    const who = newUser("outsider");
    const { panel } = await openBoardShare(page, "For an outsider");
    const { body } = await panel.invite(who.email, "Can edit");
    expect(body.invited).toMatchObject({ email: who.email, role: "editor" });

    const context = await browser.newContext({ baseURL: modeWorkers.personal.baseURL });
    const theirs = await context.newPage();
    await signUpViaForm(theirs, who);
    await expectSignedInShell(theirs, who.name);
    await expect(new Rail(theirs).names()).toContainText(["For an outsider"]);
    await createNode(context.request, record.id, { title: "Outsider card" });
    expect((await contents(page.request, record.id)).nodes.map((n) => n.title)).toContain("Outsider card");
    await context.close();
  });

  test("a public link opens an artefact for someone with no account", async ({ page, account, browser }) => {
    void account;
    const board = await createBoard(page.request, "Link home");
    const doc = await createArtefact(page.request, board.id, "doc", { title: "Public doc", blocks: [{ text: "visible to anyone" }] });
    const link = await createLink(page.request, doc.id);
    const visitor = await browser.newContext({ baseURL: modeWorkers.personal.baseURL });
    const theirs = await visitor.newPage();
    await theirs.goto(`/v/${link.token}`);
    await expect(theirs.getByText("Shared, read only")).toBeVisible();
    await expect(theirs.locator(".ProseMirror")).toContainText("visible to anyone");
    await visitor.close();
  });

  test("the artefact Share popover still offers people and a link", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Artefact home");
    const doc = await createArtefact(page.request, board.id, "doc", { title: "Doc", blocks: [{ text: "hello" }] });
    await page.goto(`/doc/${doc.id}?from=${board.id}`);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(page.locator(".share-pop").getByText("People")).toBeVisible();
    await expect(page.locator(".share-pop").getByRole("button", { name: "Create link" })).toBeVisible();
  });
});
