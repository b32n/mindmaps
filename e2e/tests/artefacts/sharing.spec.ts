import { test, expect } from "../../fixtures";
import { addMember, createArtefact, createBoard, createLink, membersOf, nodeById, trash } from "../../support/api";
import { MembersPanel } from "../../support/members";
import type { Page } from "@playwright/test";

// Sharing a single artefact: with a person (a grant: "Can edit" / "Can view",
// nothing around it comes along) and with the world (a public read-only link).
// Both live in the Share popover on every artefact editor.

async function sharedDoc(page: Page) {
  const board = await createBoard(page.request, "Private mindmap");
  const doc = await createArtefact(page.request, board.id, "doc", {
    title: "Shared doc",
    blocks: [{ heading: "Findings" }, { text: "alpha beta gamma" }],
  });
  return { board, doc };
}

const popover = (page: Page) => page.locator(".share-pop");

async function openShare(page: Page) {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(popover(page)).toBeVisible();
  return popover(page);
}

test.describe("granting an artefact to a person", () => {
  test("inviting from the Share popover gives them that artefact, in their Artefacts list, and nothing around it", async ({
    page,
    account,
    existing,
    openAs,
  }) => {
    void account;
    const { board, doc } = await sharedDoc(page);
    await page.goto(`/doc/${doc.id}?from=${board.id}`);
    const pop = await openShare(page);
    const panel = new MembersPanel(pop);
    const { status, body } = await panel.invite(existing.user.email, "Can view");
    expect(status).toBe(201);
    expect(body.added).toMatchObject({ email: existing.user.email, role: "viewer" });
    await expect(panel.row(existing.user.email)).toContainText("Can view");

    const theirs = await openAs(existing);
    await theirs.goto("/artefacts");
    await expect(theirs.locator(".arte-tr .arte-label")).toHaveText(["Shared doc"]);
    await theirs.goto(`/doc/${doc.id}`);
    await expect(theirs.locator("input.sheet-title")).toHaveValue("Shared doc");
    await expect(theirs.locator(".ProseMirror")).toContainText("alpha beta gamma");

    // the mindmap it sits on stays closed
    expect((await existing.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
  });

  test("an editor's changes in the editor are stored and the owner sees them after a reload", async ({ page, account, existing, openAs }) => {
    void account;
    const { doc } = await sharedDoc(page);
    await addMember(page.request, "artefacts", doc.id, existing.user.email, "editor");

    const theirs = await openAs(existing);
    await theirs.goto(`/doc/${doc.id}`);
    const editor = theirs.locator(".ProseMirror");
    await expect(editor).toContainText("alpha beta gamma");
    await editor.focus();
    await theirs.keyboard.press("Control+End");
    const saved = theirs.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/artefacts/${doc.id}`) && r.ok());
    await theirs.keyboard.type(" from the guest");
    await saved;

    await page.goto(`/doc/${doc.id}`);
    await expect(page.locator(".ProseMirror")).toContainText("from the guest");
  });

  test("a viewer can open it, but a save is refused and the stored text is unchanged", async ({ page, account, existing, openAs }) => {
    void account;
    const { doc } = await sharedDoc(page);
    await addMember(page.request, "artefacts", doc.id, existing.user.email, "viewer");
    const v = existing.request;
    expect((await v.get(`/api/artefacts/${doc.id}`)).status()).toBe(200);
    expect((await v.put(`/api/artefacts/${doc.id}`, { data: { id: "x", title: "overwritten", pages: [] } })).status()).toBe(403);
    expect((await v.patch(`/api/nodes/${doc.id}`, { data: { title: "renamed" } })).status()).toBe(403);
    expect((await v.delete(`/api/nodes/${doc.id}`)).status()).toBe(403);
    expect((await nodeById(page.request, doc.id)).title).toBe("Shared doc");

    // in the editor the refusal is shown rather than swallowed
    const theirs = await openAs(existing);
    await theirs.goto(`/doc/${doc.id}`);
    const editor = theirs.locator(".ProseMirror");
    await expect(editor).toContainText("alpha beta gamma");
    await editor.focus();
    await theirs.keyboard.press("Control+End");
    await theirs.keyboard.type(" sneaky");
    await expect(theirs.locator(".sheet-err")).toHaveText("You have view-only access to this.");
    expect((await nodeById(page.request, doc.id)).body).not.toContain("sneaky");
  });

  test("a viewer cannot pass it on or publish it; an editor can (a grant on one artefact cannot widen)", async ({
    page,
    account,
    existing,
    makePerson,
  }) => {
    void account;
    const { doc } = await sharedDoc(page);
    const third = await makePerson("third");
    await addMember(page.request, "artefacts", doc.id, existing.user.email, "viewer");
    const v = existing.request;
    expect((await v.post(`/api/artefacts/${doc.id}/members`, { data: { email: third.user.email } })).status()).toBe(403);
    expect((await v.get(`/api/artefacts/${doc.id}/members`)).status()).toBe(404);
    expect((await v.post(`/api/artefacts/${doc.id}/share`, { data: {} })).status()).toBe(404);
    expect(await (await v.get(`/api/artefacts/${doc.id}/share`)).json()).toEqual([]);

    await addMember(page.request, "artefacts", doc.id, existing.user.email, "editor");
    expect((await v.post(`/api/artefacts/${doc.id}/members`, { data: { email: third.user.email, role: "viewer" } })).status()).toBe(201);
    expect((await v.post(`/api/artefacts/${doc.id}/share`, { data: {} })).status()).toBe(201);
    expect((await third.request.get(`/api/artefacts/${doc.id}`)).status()).toBe(200);
  });

  test("Remove in the popover ends their access at once", async ({ page, account, existing }) => {
    void account;
    const { board, doc } = await sharedDoc(page);
    await addMember(page.request, "artefacts", doc.id, existing.user.email, "editor");
    expect((await existing.request.get(`/api/artefacts/${doc.id}`)).status()).toBe(200);

    await page.goto(`/doc/${doc.id}?from=${board.id}`);
    const panel = new MembersPanel(await openShare(page));
    const removed = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/members/"));
    await panel.row(existing.user.email).getByRole("button", { name: "Remove" }).click();
    expect((await removed).ok()).toBe(true);
    expect((await membersOf(page.request, "artefacts", doc.id)).members).toEqual([]);
    expect((await existing.request.get(`/api/artefacts/${doc.id}`)).status()).toBe(404);
    expect(await (await existing.request.get("/api/artefacts")).json()).toEqual([]);
  });

  test("an invite to an address with no account is claimed at sign-up and opens the artefact", async ({
    page,
    account,
    playwright,
    baseURL,
  }) => {
    void account;
    const { doc } = await sharedDoc(page);
    const email = `e2e-artefact-${doc.id.slice(0, 8)}@example.test`;
    const res = await addMember(page.request, "artefacts", doc.id, email, "viewer");
    expect(res.invited).toBeTruthy();
    const fresh = await playwright.request.newContext({ baseURL });
    const signup = await fresh.post("/api/auth/register", { data: { email, password: "Aa1!kP7wQz3mXv", name: "Fresh" } });
    expect(signup.status()).toBe(200);
    expect((await fresh.get(`/api/artefacts/${doc.id}`)).status()).toBe(200);
    await fresh.dispose();
  });
});

test.describe("a public link", () => {
  test("create it in the popover; anyone without an account can read it, read-only; the owner sees it was opened", async ({
    page,
    account,
    browser,
  }) => {
    void account;
    const { board, doc } = await sharedDoc(page);
    await page.goto(`/doc/${doc.id}?from=${board.id}`);
    const pop = await openShare(page);
    await expect(pop.getByText("No link yet.")).toBeVisible();
    const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/artefacts/${doc.id}/share`));
    await pop.getByRole("button", { name: "Create link" }).click();
    const link = (await (await created).json()) as { token: string; url: string };
    await expect(pop.locator("input.share-url")).toHaveValue(link.url);
    await expect(pop.getByText("not opened yet")).toBeVisible();

    const visitor = await browser.newContext();
    const theirs = await visitor.newPage();
    await theirs.goto(`/v/${link.token}`);
    await expect(theirs.locator(".shared-title")).toHaveText("Shared doc");
    await expect(theirs.getByText("Shared, read only")).toBeVisible();
    await expect(theirs.getByText("alpha beta gamma").first()).toBeVisible();
    await expect(theirs.locator("[contenteditable=true]")).toHaveCount(0);
    await expect(theirs.getByRole("button", { name: "Share" })).toHaveCount(0);
    expect((await (await visitor.request.get("/api/auth/me")).json()).user).toBeNull();
    await visitor.close();

    // the counter is bumped after the response, so wait for the owner's view of it
    await expect
      .poll(async () => ((await (await page.request.get(`/api/artefacts/${doc.id}/share`)).json()) as { views: number }[])[0].views)
      .toBe(1);
    await page.reload();
    await (await openShare(page)).getByText(/1 view, last/).waitFor();
  });

  test("Revoke turns the link into 'not available' for the visitor", async ({ page, account, browser }) => {
    void account;
    const { board, doc } = await sharedDoc(page);
    const link = await createLink(page.request, doc.id);
    const visitor = await browser.newContext();
    const theirs = await visitor.newPage();
    await theirs.goto(`/v/${link.token}`);
    await expect(theirs.getByText("Shared, read only")).toBeVisible();

    await page.goto(`/doc/${doc.id}?from=${board.id}`);
    const pop = await openShare(page);
    const revoked = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/shares/"));
    await pop.getByRole("button", { name: "Revoke" }).click();
    expect((await revoked).ok()).toBe(true);
    await expect(pop.getByText("No link yet.")).toBeVisible();

    await theirs.reload();
    await expect(theirs.getByRole("heading", { name: "This link is not available" })).toBeVisible();
    expect((await visitor.request.get(`/api/shared/${link.token}`)).status()).toBe(404);
    await visitor.close();
  });

  test("a link with an expiry in the past is not available, and says the same as one that never existed", async ({
    page,
    account,
    playwright,
    baseURL,
  }) => {
    void account;
    const { doc } = await sharedDoc(page);
    const res = await page.request.post(`/api/artefacts/${doc.id}/share`, { data: { expires_at: Date.now() - 1000 } });
    const { token } = await res.json();
    const anon = await playwright.request.newContext({ baseURL });
    const expired = await anon.get(`/api/shared/${token}`);
    const unknown = await anon.get(`/api/shared/${"b".repeat(20)}`);
    expect(expired.status()).toBe(404);
    expect(await expired.text()).toBe(await unknown.text());
    await anon.dispose();
  });

  test("a link can be created for a sheet, a deck and a page too, and each reads back as its own kind", async ({
    page,
    account,
    playwright,
    baseURL,
  }) => {
    void account;
    const board = await createBoard(page.request, "Kinds");
    const anon = await playwright.request.newContext({ baseURL });
    const made = {
      sheet: await createArtefact(page.request, board.id, "sheet", { title: "S", sheets: [{ name: "S", rows: [["x", 1]] }] }),
      deck: await createArtefact(page.request, board.id, "deck", { title: "D", slides: [{ title: "One" }] }),
      html: await createArtefact(page.request, board.id, "html", { title: "H", html: "<p>h</p>" }),
    };
    for (const [kind, node] of Object.entries(made)) {
      const link = await createLink(page.request, node.id);
      const shared = await (await anon.get(`/api/shared/${link.token}`)).json();
      expect(shared.kind).toBe(kind);
      expect(shared.title).toBe(node.title);
    }
    await anon.dispose();
  });

  test("a card or a note cannot be shared by link", async ({ page, account }) => {
    void account;
    const board = await createBoard(page.request, "Cards");
    const card = await (await page.request.post("/api/nodes", { data: { board_id: board.id, type: "card", title: "c" } })).json();
    const res = await page.request.post(`/api/artefacts/${card.id}/share`, { data: {} });
    expect(res.ok()).toBe(true); // the row is made ...
    const { token } = await res.json();
    expect((await page.request.get(`/api/shared/${token}`)).status()).toBe(404); // ... but resolves to nothing
  });

  test("deleting the artefact switches its link off; restoring it from the trash brings the link and its content back", async ({
    page,
    account,
    playwright,
    baseURL,
  }) => {
    void account;
    const board = await createBoard(page.request, "Trash and links");
    const sheet = await createArtefact(page.request, board.id, "sheet", { title: "Kept sheet", sheets: [{ name: "S", rows: [["alpha", 42]] }] });
    const link = await createLink(page.request, sheet.id);
    const anon = await playwright.request.newContext({ baseURL });
    expect((await anon.get(`/api/shared/${link.token}`)).status()).toBe(200);

    expect((await page.request.delete(`/api/nodes/${sheet.id}`)).ok()).toBe(true);
    expect((await anon.get(`/api/shared/${link.token}`)).status()).toBe(404);
    expect((await page.request.get(`/api/artefacts/${sheet.id}`)).status()).toBe(404);

    const entry = (await trash(page.request)).find((t) => t.label === "Kept sheet");
    expect(entry, "the deleted sheet is in the trash").toBeTruthy();
    expect(entry!.node_type).toBe("sheet");
    expect((await page.request.post(`/api/trash/${entry!.id}/restore`)).ok()).toBe(true);

    const back = await (await page.request.get(`/api/artefacts/${sheet.id}`)).json();
    expect(JSON.stringify(back)).toContain("alpha");
    const again = await anon.get(`/api/shared/${link.token}`);
    expect(again.status()).toBe(200);
    expect(JSON.stringify(await again.json())).toContain("alpha");
    await anon.dispose();
  });
});
