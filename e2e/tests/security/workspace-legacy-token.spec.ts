import { test, expect } from "@playwright/test";
import { register } from "../../fixtures";
import { createBoard, createWorkspace, listBoards, listWorkspaces } from "../../support/api";
import { ExpiryWorker } from "../../support/expiry";
import { clientFor, connectMcp } from "../../support/mcp";
import { newUser } from "../../support/users";

// A token issued before workspaces were chosen at connect time has no workspace
// on it. It has to keep doing what it always did: create in Personal, and look
// across every workspace the person belongs to. Runs on its own Worker (see
// support/expiry.ts) because the only way to get such a token now is to clear
// the column on one, with the Worker stopped.

test.describe.configure({ mode: "serial" });

const worker = new ExpiryWorker();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await worker.start();
});
test.afterAll(async () => {
  await worker.dispose();
});

test("a token with no workspace creates in Personal and reads everywhere, also after a refresh", async () => {
  test.setTimeout(240_000);
  const me = await worker.client();
  await register(me, newUser("legacy"));
  const personal = (await listWorkspaces(me)).find((w) => w.personal)!;
  const team = await createWorkspace(me, "Legacy team");
  const home = await createBoard(me, "Legacy home", { workspace_id: personal.id });
  const crew = await createBoard(me, "Legacy crew", { workspace_id: team.id });

  const fresh = await connectMcp(me, { workspace: team.id });
  const { clientId, accessToken, refreshToken } = fresh.credentials;
  await fresh.call("add_card", { mindmap_id: home.id, title: "Home zebra" });
  await fresh.call("add_card", { mindmap_id: crew.id, title: "Crew zebra" });

  // what every token issued before this change looks like
  await worker.execute("UPDATE oauth_tokens SET workspace_id = NULL");

  const check = async (mcp: ReturnType<typeof clientFor>) => {
    for (const tool of ["recall", "search"]) {
      const r = await mcp.call(tool, { query: "zebra" });
      expect(r.text, tool).toContain("Home zebra");
      expect(r.text, tool).toContain("Crew zebra");
    }
    const list = await mcp.call("list_mindmaps", {});
    expect(list.text).toContain("Legacy home");
    expect(list.text).toContain("Legacy crew");
    await mcp.call("recall", { query: "nothing-at-all" });
    const made = await mcp.call("create_mindmap", { name: `Legacy new ${Math.random()}`, nodes: [{ key: "a", title: "A" }] });
    expect(made.isError, made.text).toBe(false);
  };
  const legacy = clientFor(me, clientId, accessToken, refreshToken);
  await check(legacy);
  await check(await legacy.refresh());

  const boards = await listBoards(me);
  const created = boards.filter((b) => b.name.startsWith("Legacy new"));
  expect(created).toHaveLength(2);
  for (const b of created) expect(b.workspace_id).toBe(personal.id);
});
