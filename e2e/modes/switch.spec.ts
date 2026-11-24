import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as pwRequest, type APIRequestContext, type Browser } from "@playwright/test";
import { expect, register, test } from "../fixtures";
import { addMember, contents, createBoard, createEdge, createNode, createWorkspace, listBoards, listWorkspaces } from "../support/api";
import { clientFor, connectMcp, type McpClient } from "../support/mcp";
import { Rail } from "../support/rail";
import { switchWorker } from "../support/hosts";
import { newUser } from "../support/users";

// Switching an install that already has team spaces. One database, three runs of
// the Worker (org, personal, multitenant): personal hides the team spaces in the
// app, the API and MCP, changes nothing in the data, and switching back shows
// them again with everything in them. Sharing keeps working throughout: a
// mindmap shared with a person stays theirs even when it sits in a hidden team
// space (docs/MODES.md).
//
// The Worker is started and stopped here (serve.mjs with E2E_KEEP_STATE) rather
// than by Playwright, because it has to restart on the same data.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const word = () => `zq${randomUUID().replace(/-/g, "").slice(0, 10)}`;

let child: ChildProcess | null = null;

async function startWorker(mode: string, fresh = false) {
  const env = {
    ...process.env,
    E2E_PORT: String(switchWorker.port),
    E2E_STATE_DIR: switchWorker.stateDir,
    E2E_VARS: JSON.stringify({ MINDMAPS_MODE: mode }),
    ...(fresh ? {} : { E2E_KEEP_STATE: "1" }),
  };
  if (fresh) delete (env as Record<string, unknown>).E2E_KEEP_STATE;
  child = spawn("node", ["e2e/support/serve.mjs"], { cwd: root, env, stdio: "ignore" });
  const deadline = Date.now() + 100_000;
  for (;;) {
    try {
      const res = await fetch(`${switchWorker.baseURL}/api/auth/me`);
      if (res.ok && (await res.json()).mode === mode) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`the ${mode} Worker did not come up`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function stopWorker() {
  const proc = child;
  child = null;
  if (!proc) return;
  const closed = new Promise<void>((r) => proc.once("exit", () => r()));
  proc.kill("SIGTERM");
  await closed;
  // the port frees once workerd is gone
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${switchWorker.baseURL}/api/auth/me`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("the Worker kept answering after it was stopped");
}

async function pageAs(browser: Browser, who: APIRequestContext) {
  const context = await browser.newContext({ baseURL: switchWorker.baseURL, storageState: await who.storageState() });
  return { context, page: await context.newPage() };
}

test.describe.configure({ mode: "serial" });

test.describe("switching an install that has team spaces", () => {
  test.setTimeout(420_000);
  test.afterAll(async () => {
    await stopWorker();
    rmSync(resolve(root, switchWorker.stateDir), { recursive: true, force: true });
  });

  const people: Record<string, { request: APIRequestContext; email: string }> = {};
  const s: Record<string, any> = {};
  let ownerMcp: McpClient;

  test("an org install is set up: a team space, boards in it, shares, an agent connected to it", async () => {
    await startWorker("org", true);
    const term = word();
    s.term = term;
    for (const label of ["owner", "member", "outsider"]) {
      const request = await pwRequest.newContext({ baseURL: switchWorker.baseURL });
      const user = newUser(label);
      await register(request, user);
      people[label] = { request, email: user.email };
    }
    const owner = people.owner!.request;
    s.team = await createWorkspace(owner, `Atlas ${term}`);
    s.home = (await listWorkspaces(owner)).find((w) => w.personal)!;
    await addMember(owner, "workspaces", s.team.id, people.member!.email, "editor");

    s.homeBoard = await createBoard(owner, `Home ${term}`, { workspace_id: s.home.id });
    s.teamBoard = await createBoard(owner, `Crew ${term}`, { workspace_id: s.team.id });
    s.sharedBoard = await createBoard(owner, `Shared ${term}`, { workspace_id: s.team.id });
    const homeCard = await createNode(owner, s.homeBoard.id, { title: `Home zebra ${term}` });
    const teamCard = await createNode(owner, s.teamBoard.id, { title: `Team zebra ${term}` });
    // a link across the boundary: following links from the home card must not
    // surface the hidden card's title
    await createEdge(owner, { source_id: homeCard.id, target_id: teamCard.id, label: "relates" });
    await createNode(owner, s.sharedBoard.id, { title: `Shared zebra ${term}` });
    // shared with a fellow member of the team space, and with someone outside it
    await addMember(owner, "boards", s.sharedBoard.id, people.member!.email, "editor");
    await addMember(owner, "boards", s.sharedBoard.id, people.outsider!.email, "editor");

    ownerMcp = await connectMcp(owner, { workspace: s.team.id });
    const text = (await ownerMcp.call("search", { query: term })).text;
    expect(text).toContain("Team zebra");
    s.mcp = ownerMcp.credentials;

    const orgBoards = (await listBoards(owner)).map((b) => b.id);
    expect(orgBoards).toEqual(expect.arrayContaining([s.homeBoard.id, s.teamBoard.id, s.sharedBoard.id]));
    s.cardsBefore = (await contents(owner, s.teamBoard.id)).nodes.map((n) => n.title).sort();
  });

  test("personal hides the team space in the API", async () => {
    await stopWorker();
    await startWorker("personal");
    const owner = people.owner!.request;

    const list = await listWorkspaces(owner);
    expect(list.map((w) => w.id)).toEqual([s.home.id]);

    const ids = (await listBoards(owner)).map((b) => b.id);
    expect(ids).toContain(s.homeBoard.id);
    expect(ids).not.toContain(s.teamBoard.id);
    expect(ids).not.toContain(s.sharedBoard.id);

    // nothing new can be made there, by creating a space or by naming it
    const make = await owner.post("/api/workspaces", { data: { name: "Another" } });
    expect(make.status()).toBe(403);
    const into = await owner.post("/api/boards", { data: { name: "Sneaky", workspace_id: s.team.id } });
    expect(into.status()).toBe(403);
    const invite = await owner.post(`/api/workspaces/${s.team.id}/members`, { data: { email: newUser("late").email } });
    expect(invite.status()).toBe(403);

    // recall and search do not reach into it either
    const recall = await (await owner.get(`/api/recall?q=${s.term}&workspace=${s.team.id}`)).json();
    const seen = JSON.stringify(recall);
    expect(seen).toContain("Home zebra");
    expect(seen).not.toContain("Team zebra");
    const recallAll = JSON.stringify(await (await owner.get(`/api/recall?q=${s.term}`)).json());
    expect(recallAll).not.toContain("Team zebra");
    const arte = await (await owner.get("/api/artefacts")).json();
    expect(JSON.stringify(arte)).not.toContain(s.teamBoard.id);
  });

  test("sharing keeps working for a mindmap inside the hidden team space", async () => {
    const member = people.member!.request;
    const outsider = people.outsider!.request;
    for (const who of [member, outsider]) {
      const ids = (await listBoards(who)).map((b) => b.id);
      expect(ids).toContain(s.sharedBoard.id);
      expect(ids).not.toContain(s.teamBoard.id);
      expect((await contents(who, s.sharedBoard.id)).nodes.map((n) => n.title)).toContain(`Shared zebra ${s.term}`);
      await createNode(who, s.sharedBoard.id, { title: `Edit by ${randomUUID().slice(0, 4)}` });
    }
    // the member is also in the team space, but the space is hidden: only the share lists it
    expect((await listWorkspaces(member)).map((w) => w.id)).not.toContain(s.team.id);
    // and a new share from the owner works too
    await addMember(people.owner!.request, "boards", s.sharedBoard.id, newUser("n").email, "viewer");
  });

  test("personal hides the team space in the app", async ({ browser }) => {
    const owner = await pageAs(browser, people.owner!.request);
    await owner.page.goto("/app");
    await expect(owner.page.locator(".rail-add")).toBeVisible();
    await expect(owner.page.locator(".ws-trigger")).toHaveCount(0);
    await expect(new Rail(owner.page).names()).toContainText([`Home ${s.term}`]);
    await expect(new Rail(owner.page).names()).not.toContainText([`Crew ${s.term}`]);
    // the safety rule for deleting an account that owns a shared space still holds,
    // and the dialog says where the space went instead of pointing at a hidden menu
    await owner.page.getByRole("button", { name: "Settings", exact: true }).click();
    const blockers = owner.page.getByRole("dialog", { name: "Settings" }).getByTestId("delete-blockers");
    await expect(blockers).toContainText(`Atlas ${s.term}`);
    await expect(blockers).toContainText(/hidden.*personal mode/i);
    await expect(blockers).not.toContainText("workspace menu");
    await expect(owner.page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Delete account…" })).toBeDisabled();
    await owner.context.close();

    const member = await pageAs(browser, people.member!.request);
    await member.page.goto("/app");
    await expect(member.page.locator(".ws-trigger")).toHaveCount(0);
    await expect(new Rail(member.page).names()).toContainText([`Shared ${s.term}`]);
    await expect(new Rail(member.page).names()).not.toContainText([`Crew ${s.term}`]);
    await member.context.close();
  });

  test("personal hides the team space from an agent connected to it", async () => {
    const owner = people.owner!.request;
    const mcp = clientFor(owner, s.mcp.clientId, s.mcp.accessToken, s.mcp.refreshToken);
    const list = await mcp.call("list_mindmaps", {});
    expect(list.isError, list.text).toBe(false);
    expect(list.text).toContain(`Home ${s.term}`);
    expect(list.text).not.toContain(`Crew ${s.term}`);
    for (const tool of ["search", "recall"]) {
      const r = await mcp.call(tool, { query: s.term });
      expect(r.text, tool).toContain("Home zebra");
      expect(r.text, tool).not.toContain("Team zebra");
    }
    // a workspace named by id is not a way back in
    const named = await mcp.call("search", { query: s.term, workspace: s.team.id });
    expect(named.text).not.toContain("Team zebra");
    // creating lands in the personal home, whatever the token was connected to
    await mcp.call("recall", { query: `nothing-${word()}` });
    const name = `Created ${s.term}`;
    const made = await mcp.call("create_mindmap", { name, nodes: [{ key: "a", title: "A" }] });
    expect(made.isError, made.text).toBe(false);
    expect((await listBoards(owner)).find((b) => b.name === name)?.workspace_id).toBe(s.home.id);
    s.created = name;
  });

  test("switching back shows the team space again, with its data intact", async ({ browser }) => {
    await stopWorker();
    await startWorker("multitenant");
    const owner = people.owner!.request;

    expect((await listWorkspaces(owner)).map((w) => w.id).sort()).toEqual([s.home.id, s.team.id].sort());
    const ids = (await listBoards(owner)).map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining([s.homeBoard.id, s.teamBoard.id, s.sharedBoard.id]));
    expect((await listBoards(owner)).find((b) => b.name === s.created)?.workspace_id).toBe(s.home.id);
    const cards = (await contents(owner, s.teamBoard.id)).nodes.map((n) => n.title).sort();
    expect(cards).toEqual(s.cardsBefore);
    expect((await contents(owner, s.sharedBoard.id)).nodes.length).toBeGreaterThanOrEqual(3);
    expect((await listWorkspaces(people.member!.request)).map((w) => w.id)).toContain(s.team.id);

    const mcp = clientFor(owner, s.mcp.clientId, s.mcp.accessToken, s.mcp.refreshToken);
    expect((await mcp.call("search", { query: s.term })).text).toContain("Team zebra");

    const { context, page } = await pageAs(browser, owner);
    await page.goto("/app");
    await expect(page.locator(".ws-trigger")).toBeVisible();
    await page.locator(".ws-trigger").click();
    await expect(page.getByRole("menuitem", { name: new RegExp(`Atlas ${s.term}`) })).toBeVisible();
    await context.close();
  });

  test("and org shows it too", async () => {
    await stopWorker();
    await startWorker("org");
    const owner = people.owner!.request;
    expect((await listWorkspaces(owner)).map((w) => w.id)).toContain(s.team.id);
    expect((await listBoards(owner)).map((b) => b.id)).toContain(s.teamBoard.id);
    const made = await createWorkspace(owner, "Created after switching back");
    expect(made.personal).toBe(0);
  });
});
