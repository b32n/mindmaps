import { test, expect } from "@playwright/test";
import { PrivateWorker } from "../../support/private-worker";
import { createBoard, inviteRaw, listBoards } from "../../support/api";
import { acceptInvite, pendingInvites } from "../../support/lifecycle";
import { connectMcp, consentPage } from "../../support/mcp";
import { createOrganisation, signUp } from "../../support/organisation";
import { register } from "../../fixtures";
import { newUser } from "../../support/users";

// An agent connecting to an org-mode instance is pointed at the organisation by
// default (the consent page's default, and so where new mindmaps go and what it
// looks at first), for the people who are in it. Nobody else is affected.

test.describe("MCP on an org-mode instance", () => {
  let w: PrivateWorker;
  test.beforeEach(async () => {
    w = await new PrivateWorker({ mode: "org", signup: "closed" }).start();
  });
  test.afterEach(async () => w.dispose());

  test("a member's default is the organisation; Personal is still choosable; an outsider keeps Personal", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();
    await createBoard(owner, "Plans", { workspace_id: org.id });

    const html = await consentPage(owner);
    expect(html).toMatch(new RegExp(`<option value="${org.id}" selected>Acme</option>`));
    expect(html).not.toMatch(/<option value="[^"]+" selected>Personal<\/option>/);

    const agent = await connectMcp(owner);
    const listed = await agent.call("list_mindmaps", {});
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain("Plans");
    await agent.call("recall", { query: "agent notes" }); // create_mindmap is refused without one
    const made = await agent.call("create_mindmap", { name: "Agent notes", nodes: [{ key: "a", title: "One" }] });
    expect(made.isError, made.text).toBe(false);
    const inOrg = (await listBoards(owner)).find((b) => b.name === "Agent notes");
    expect(inOrg?.workspace_id).toBe(org.id);

    // choosing Personal explicitly still works
    const personal = await connectMcp(owner, { workspace: (await owner.get("/api/workspaces").then((r) => r.json())).find((x: any) => x.personal).id });
    await personal.call("recall", { query: "private notes" });
    await personal.call("create_mindmap", { name: "Private notes", nodes: [{ key: "a", title: "One" }] });
    expect((await listBoards(owner)).find((b) => b.name === "Private notes")?.workspace_id).not.toBe(org.id);

    // an invited person who has not accepted yet is outside: Personal, as before
    const guest = newUser("guest");
    await inviteRaw(owner, "workspaces", org.id, guest.email, "editor");
    const g = await w.client();
    await register(g, guest);
    expect(await consentPage(g)).toMatch(/Workspace: <b>Personal<\/b>/);
    for (const inv of await pendingInvites(g)) await acceptInvite(g, inv.token);
    expect(await consentPage(g)).toMatch(new RegExp(`<option value="${org.id}" selected>Acme</option>`));
  });
});
