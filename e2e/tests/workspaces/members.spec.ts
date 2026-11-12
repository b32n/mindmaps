import { test, expect } from "../../fixtures";
import {
  addMember,
  contents,
  createBoard,
  createNode,
  createWorkspace,
  listBoards,
  listWorkspaces,
  membersOf,
} from "../../support/api";
import { openWorkspacePeople, switchWorkspace } from "../../support/members";
import { Rail } from "../../support/rail";
import { signUpViaForm, expectSignedInShell } from "../../support/auth";
import { newUser } from "../../support/users";

// Workspace membership through the People dialog (the workspace menu's people
// icon), seen from both sides: the owner who invites and the person who is
// invited. Two browser contexts, two cookie jars.

test.describe("inviting someone who already has an account", () => {
  test("they are added at once, and see the workspace with its mindmaps in their own menu", async ({
    page,
    account,
    request,
    existing,
    openAs,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Platform team");
    await createBoard(request, "Roadmap", { workspace_id: ws.id });

    await page.goto("/app");
    const { panel } = await openWorkspacePeople(page, "Platform team");
    const { status, body } = await panel.invite(existing.user.email);
    expect(status).toBe(201);
    expect(body.added).toMatchObject({ email: existing.user.email, role: "editor" });

    await expect(panel.note()).toHaveText(`${existing.user.email} now has access.`);
    await expect(panel.row(existing.user.email)).toContainText("Can edit");
    await expect(panel.row(existing.user.name)).toBeVisible();

    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await theirs.locator(".ws-trigger").click();
    await expect(theirs.getByRole("menuitem", { name: /Platform team/ })).toContainText("Can edit");
    await theirs.getByRole("menuitem", { name: /Platform team/ }).click();
    await expect(new Rail(theirs).names()).toHaveText(["Roadmap"]);
    // a member does not get the owner's People button
    await theirs.locator(".ws-trigger").click();
    await expect(theirs.getByRole("menuitem", { name: /Platform team/ }).locator(".ws-item-people")).toHaveCount(0);
  });

  test("a viewer is listed as Can view, and the workspace says so in their menu", async ({
    page,
    account,
    request,
    existing,
    openAs,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Read only crowd");
    await page.goto("/app");
    const { panel } = await openWorkspacePeople(page, "Read only crowd");
    await panel.invite(existing.user.email, "Can view");
    await expect(panel.row(existing.user.email)).toContainText("Can view");
    expect((await membersOf(request, "workspaces", ws.id)).members.map((m) => m.role)).toEqual(["viewer"]);

    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await theirs.locator(".ws-trigger").click();
    await expect(theirs.getByRole("menuitem", { name: /Read only crowd/ })).toContainText("Can view");
  });

  test("the address is matched case-insensitively and with stray spaces", async ({ page, account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Casing");
    await page.goto("/app");
    const { panel } = await openWorkspacePeople(page, "Casing");
    const { body } = await panel.invite(`  ${existing.user.email.toUpperCase()}  `);
    expect(body.added).toBeTruthy();
    expect((await membersOf(request, "workspaces", ws.id)).members).toHaveLength(1);
  });

  test("inviting again with another role changes the role (there is no per-row role control)", async ({
    page,
    account,
    request,
    existing,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Re-roled");
    await addMember(request, "workspaces", ws.id, existing.user.email, "viewer");
    await page.goto("/app");
    const { panel } = await openWorkspacePeople(page, "Re-roled");
    await expect(panel.row(existing.user.email)).toContainText("Can view");
    await panel.invite(existing.user.email, "Can edit");
    await expect(panel.row(existing.user.email)).toContainText("Can edit");
    const { members } = await membersOf(request, "workspaces", ws.id);
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("editor");
  });

  test("an address that is not an email is refused with a message and nothing is created", async ({
    page,
    account,
    request,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Strict");
    await page.goto("/app");
    const { dialog, panel } = await openWorkspacePeople(page, "Strict");
    const { status } = await panel.invite("not-an-address");
    expect(status).toBe(400);
    await expect(dialog.getByText("That does not look like an email address.")).toBeVisible();
    expect(await membersOf(request, "workspaces", ws.id)).toEqual({ members: [], pending: [] });
  });

  test("inviting your own address changes nothing", async ({ page, account, request }) => {
    const ws = await createWorkspace(request, "Just me");
    await page.goto("/app");
    const { panel } = await openWorkspacePeople(page, "Just me");
    await panel.invite(account.email);
    expect(await membersOf(request, "workspaces", ws.id)).toEqual({ members: [], pending: [] });
    await expect(panel.rows()).toHaveText(["YouOwner"]);
  });
});

test.describe("inviting someone with no account yet", () => {
  test("the invite waits as a pending row, and Cancel withdraws it", async ({ page, account, request }) => {
    void account;
    const ws = await createWorkspace(request, "Waiting room");
    const who = newUser("later");
    await page.goto("/app");
    const { panel } = await openWorkspacePeople(page, "Waiting room");
    const { status, body } = await panel.invite(who.email, "Can view");
    expect(status).toBe(201);
    expect(body.invited).toMatchObject({ email: who.email, role: "viewer" });

    await expect(panel.note()).toHaveText(`Invited ${who.email}. They will get access when they sign up with that address.`);
    await expect(panel.row(who.email)).toContainText("waiting for them to sign up");
    await expect(panel.row(who.email)).toContainText("Can view");
    expect((await membersOf(request, "workspaces", ws.id)).pending.map((p) => p.email)).toEqual([who.email]);

    const revoked = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/invites/"));
    await panel.row(who.email).getByRole("button", { name: "Cancel" }).click();
    expect((await revoked).ok()).toBe(true);
    await expect(panel.row(who.email)).toHaveCount(0);
    expect((await membersOf(request, "workspaces", ws.id)).pending).toEqual([]);
  });

  test("signing up with that address through the form lands in the workspace, with the role invited", async ({
    page,
    account,
    request,
    browser,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Welcome");
    await createBoard(request, "Onboarding", { workspace_id: ws.id });
    const who = newUser("newcomer");
    // the invitation is typed in a different case from the later sign-up
    await addMember(request, "workspaces", ws.id, who.email.toUpperCase(), "viewer");

    const context = await browser.newContext();
    const theirs = await context.newPage();
    await signUpViaForm(theirs, who);
    await expectSignedInShell(theirs, who.name);
    await theirs.locator(".ws-trigger").click();
    await expect(theirs.getByRole("menuitem", { name: /Welcome/ })).toContainText("Can view");
    await theirs.getByRole("menuitem", { name: /Welcome/ }).click();
    await expect(new Rail(theirs).names()).toHaveText(["Onboarding"]);
    await context.close();

    // and the invite is no longer pending for the owner
    const after = await membersOf(request, "workspaces", ws.id);
    expect(after.pending).toEqual([]);
    expect(after.members.map((m) => m.email)).toEqual([who.email]);
  });

  test("once an invited address has an account, it cannot register a second one", async ({
    account,
    request,
    playwright,
    baseURL,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Once");
    const who = newUser("once");
    await addMember(request, "workspaces", ws.id, who.email);
    const first = await playwright.request.newContext({ baseURL });
    const ok = await first.post("/api/auth/register", { data: { email: who.email, password: who.password, name: who.name } });
    expect(ok.status()).toBe(200);
    const second = await first.post("/api/auth/register", { data: { email: who.email, password: who.password, name: who.name } });
    expect(second.status()).toBe(409);
    await first.dispose();
  });
});

test.describe("removing and leaving", () => {
  test("Remove takes the member out; their menu, mindmap list and API access go with it", async ({
    page,
    account,
    request,
    existing,
    openAs,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Shrinking");
    const board = await createBoard(request, "Shared plan", { workspace_id: ws.id });
    await addMember(request, "workspaces", ws.id, existing.user.email);
    expect((await existing.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);

    await page.goto("/app");
    const { panel } = await openWorkspacePeople(page, "Shrinking");
    const removed = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/members/"));
    await panel.row(existing.user.email).getByRole("button", { name: "Remove" }).click();
    expect((await removed).ok()).toBe(true);
    await expect(panel.row(existing.user.email)).toHaveCount(0);

    expect((await listWorkspaces(existing.request)).map((w) => w.name)).toEqual(["Personal"]);
    expect((await listBoards(existing.request)).map((b) => b.name)).not.toContain("Shared plan");
    expect((await existing.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);

    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await theirs.locator(".ws-trigger").click();
    await expect(theirs.getByRole("menuitem")).toHaveText(["Personal", "New workspace"]);
  });

  test("a member can leave on their own (API); the workspace stays for everyone else", async ({
    account,
    request,
    existing,
    makePerson,
  }) => {
    void account;
    const other = await makePerson("stays");
    const ws = await createWorkspace(request, "Leavable");
    await addMember(request, "workspaces", ws.id, existing.user.email);
    await addMember(request, "workspaces", ws.id, other.user.email);
    const me = (await (await existing.request.get("/api/auth/me")).json()).user.id;

    const res = await existing.request.delete(`/api/workspaces/${ws.id}/members/${me}`);
    expect(res.status()).toBe(200);
    expect((await listWorkspaces(existing.request)).map((w) => w.name)).toEqual(["Personal"]);
    expect((await membersOf(request, "workspaces", ws.id)).members.map((m) => m.email)).toEqual([other.user.email]);
    expect((await listWorkspaces(other.request)).map((w) => w.name)).toContain("Leavable");
  });

  test("the owner is not a member row, so cannot leave their own workspace", async ({ account, request }) => {
    void account;
    const ws = await createWorkspace(request, "Mine");
    const me = (await (await request.get("/api/auth/me")).json()).user.id;
    expect((await request.delete(`/api/workspaces/${ws.id}/members/${me}`)).status()).toBe(404);
    expect((await listWorkspaces(request)).map((w) => w.name)).toContain("Mine");
  });

  test("removing someone who is not a member is a 404", async ({ account, request, existing }) => {
    void account;
    const ws = await createWorkspace(request, "Nobody");
    const them = (await (await existing.request.get("/api/auth/me")).json()).user.id;
    expect((await request.delete(`/api/workspaces/${ws.id}/members/${them}`)).status()).toBe(404);
  });
});

test.describe("what a member can do in a shared workspace", () => {
  test("an editor's card shows up for the owner, and the owner's for the editor, after a reload", async ({
    page,
    account,
    request,
    existing,
    openAs,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Both write");
    const board = await createBoard(request, "Written together", { workspace_id: ws.id });
    await addMember(request, "workspaces", ws.id, existing.user.email, "editor");
    await createNode(request, board.id, { title: "From the owner", x: 0, y: 0 });
    await createNode(existing.request, board.id, { title: "From the editor", x: 300, y: 0 });

    await page.goto(`/app/${board.id}`);
    await expect(page.locator(".react-flow__node input.card-title")).toHaveCount(2);
    await expect(page.locator(".react-flow__node input.card-title[value='From the editor']")).toHaveCount(1);

    const theirs = await openAs(existing);
    await theirs.goto(`/app/${board.id}`);
    await expect(theirs.locator(".react-flow__node input.card-title")).toHaveCount(2);
    expect((await contents(existing.request, board.id)).nodes.map((n) => n.title).sort()).toEqual([
      "From the editor",
      "From the owner",
    ]);
  });

  test("an editor makes a mindmap from the rail while in the workspace; it lands there, for the owner too", async ({
    account,
    request,
    existing,
    openAs,
    page,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Shared desk");
    await addMember(request, "workspaces", ws.id, existing.user.email, "editor");
    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await switchWorkspace(theirs, /Shared desk/);
    const made = theirs.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/boards"));
    await new Rail(theirs).create("Made by the editor");
    expect(((await (await made).json()) as { workspace_id: string }).workspace_id).toBe(ws.id);

    await page.goto("/app");
    await switchWorkspace(page, /Shared desk/);
    await expect(new Rail(page).names()).toHaveText(["Made by the editor"]);
  });

  test("a viewer who tries to make a mindmap in the workspace is refused, and nothing is made", async ({
    account,
    request,
    existing,
    openAs,
  }) => {
    void account;
    const ws = await createWorkspace(request, "Look only");
    await addMember(request, "workspaces", ws.id, existing.user.email, "viewer");
    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await switchWorkspace(theirs, /Look only/);
    const rail = new Rail(theirs);
    await rail.openNewDialog();
    const dialog = theirs.getByRole("dialog", { name: "New mindmap" });
    await dialog.getByLabel("Name").fill("Should not exist");
    const refused = theirs.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/boards"));
    await dialog.getByRole("button", { name: "Create mindmap" }).click();
    expect((await refused).status()).toBe(403);
    await expect(dialog.getByRole("button", { name: "Create mindmap" })).toBeEnabled();
    expect((await listBoards(request)).map((b) => b.name)).not.toContain("Should not exist");
    await expect(rail.names()).toHaveCount(0);
  });

  test.fixme("a viewer whose new mindmap is refused is told why", async ({ account, request, existing, openAs }) => {
    // Expected: the dialog says "You cannot add mindmaps to that workspace."
    // (the server's 403 message), as the workspace and Share dialogs do for
    // their own errors. Actual: MindmapDialog's submit has try/finally and no
    // catch, so the refusal is an unhandled rejection and the dialog just sits
    // there, unchanged, with the button re-enabled. Seen by trying to create a
    // mindmap as a viewer of a workspace.
    void account;
    const ws = await createWorkspace(request, "Look only 2");
    await addMember(request, "workspaces", ws.id, existing.user.email, "viewer");
    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await switchWorkspace(theirs, /Look only 2/);
    await new Rail(theirs).openNewDialog();
    const dialog = theirs.getByRole("dialog", { name: "New mindmap" });
    await dialog.getByLabel("Name").fill("Should not exist");
    await dialog.getByRole("button", { name: "Create mindmap" }).click();
    await expect(dialog.getByText("You cannot add mindmaps to that workspace.")).toBeVisible();
  });
});
