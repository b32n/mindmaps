import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures";
import { addMember, createBoard, createNode, createWorkspace, listBoards, listWorkspaces } from "../support/api";
import { connectMcp, consentPage } from "../support/mcp";
import { openWorkspacePeople, switchWorkspace } from "../support/members";
import { Rail } from "../support/rail";
import { MAIN_PORT, modeWorkers } from "../support/hosts";

// Every mode except personal keeps team spaces exactly as they were: the
// switcher, creating a workspace, the consent picker, the `workspace` argument
// on the tools. Production (multitenant) must not notice the mode UI at all, and
// org keeps today's shared-workspace behaviour (organisation lifecycle is later
// work). Unset and empty behave as multitenant.

const CASES = [
  { name: "unset", baseURL: `http://127.0.0.1:${MAIN_PORT}` },
  { name: "multitenant", baseURL: modeWorkers.multitenant.baseURL },
  { name: "empty", baseURL: modeWorkers.empty.baseURL },
  { name: "org", baseURL: modeWorkers.org.baseURL },
];

const word = () => `zq${randomUUID().replace(/-/g, "").slice(0, 10)}`;

for (const c of CASES) {
  test.describe(`${c.name}: team spaces are offered`, () => {
    test.use({ baseURL: c.baseURL });

    test("the switcher creates a team space and switches into it", async ({ page, account }) => {
      void account;
      await page.goto("/app");
      await expect(page.locator(".ws-trigger")).toBeVisible();
      await page.locator(".ws-trigger").click();
      await page.getByRole("menuitem", { name: "New workspace" }).click();
      const dialog = page.getByRole("dialog", { name: "New workspace" });
      await expect(dialog).toContainText("A shared space. Everyone you invite sees every mindmap in it.");
      await dialog.getByLabel("Name").fill("Platform");
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(page.locator(".ws-trigger .ws-name")).toHaveText("Platform");
      const list = await listWorkspaces(page.request);
      expect(list.map((w) => w.name)).toEqual(["Personal", "Platform"]);
    });

    test("People opens for a team space, and a member joins it", async ({ page, account, existing, openAs }) => {
      void account;
      const team = await createWorkspace(page.request, "Crew");
      await page.goto("/app");
      const { panel } = await openWorkspacePeople(page, "Crew");
      const { status } = await panel.invite(existing.user.email, "Can edit");
      expect(status).toBe(201);
      const theirs = await openAs(existing);
      await theirs.goto("/app");
      await switchWorkspace(theirs, /Crew/);
      await expect(theirs.locator(".ws-trigger .ws-name")).toHaveText("Crew");
      expect((await listWorkspaces(existing.request)).map((w) => w.id)).toContain(team.id);
    });

    test("API: workspaces list, create, and boards in a team space", async ({ request, account }) => {
      void account;
      const team = await createWorkspace(request, "Atlas");
      expect((await listWorkspaces(request)).map((w) => w.id)).toContain(team.id);
      const board = await createBoard(request, "In team", { workspace_id: team.id });
      expect(board.workspace_id).toBe(team.id);
      expect((await listBoards(request)).map((b) => b.id)).toContain(board.id);
    });

    test("the consent page offers the workspaces, and the choice is honoured", async ({ request, account }) => {
      void account;
      const team = await createWorkspace(request, `Atlas ${word()}`);
      const html = await consentPage(request);
      expect(html).toMatch(/<select[^>]*name="workspace"/);
      expect(html).toContain(team.name);
      const mcp = await connectMcp(request, { workspace: team.id });
      const name = `Made ${word()}`;
      await mcp.call("recall", { query: `nothing-${word()}` });
      const r = await mcp.call("create_mindmap", { name, nodes: [{ key: "a", title: "A" }] });
      expect(r.isError, r.text).toBe(false);
      expect((await listBoards(request)).find((b) => b.name === name)?.workspace_id).toBe(team.id);
    });

    test("a one-workspace person sees the plain Workspace line on the consent page", async ({ request, account }) => {
      void account;
      const html = await consentPage(request);
      expect(html).not.toMatch(/<select/);
      expect(html).toContain("Workspace: <b>Personal</b>");
    });

    test("the tools take a workspace argument, and list_mindmaps names the others", async ({ request, account }) => {
      void account;
      const team = await createWorkspace(request, `Atlas ${word()}`);
      const client = await connectMcp(request);
      const res = await request.post("/mcp", {
        headers: { authorization: `Bearer ${client.credentials.accessToken}`, cookie: "", accept: "application/json, text/event-stream" },
        data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      const tools = (await res.json()).result.tools as { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
      for (const n of ["list_mindmaps", "search", "recall", "create_mindmap"])
        expect(Object.keys(tools.find((t) => t.name === n)!.inputSchema.properties ?? {}), n).toContain("workspace");
      const list = await client.call("list_mindmaps", {});
      expect(list.text).toContain(team.name);
      expect(list.text).toContain("Other workspaces you can reach");
    });

    test("workspace roles still gate the members API", async ({ request, account, existing }) => {
      void account;
      const team = await createWorkspace(request, "Roles");
      await addMember(request, "workspaces", team.id, existing.user.email, "viewer");
      const board = await createBoard(request, "Team map", { workspace_id: team.id });
      const denied = await existing.request.post("/api/nodes", { data: { board_id: board.id, type: "card", title: "x", x: 0, y: 0 } });
      expect(denied.status()).toBeGreaterThanOrEqual(400);
      await createNode(request, board.id, { title: "owner can" });
    });

    test("the Personal rail still lists boards without a switcher change", async ({ page, account }) => {
      void account;
      await createBoard(page.request, "Home board");
      await page.goto("/app");
      await expect(new Rail(page).names()).toContainText(["Home board"]);
    });
  });
}
