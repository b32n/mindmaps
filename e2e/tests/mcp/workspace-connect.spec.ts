import { randomUUID } from "node:crypto";
import { test, expect } from "../../fixtures";
import { createBoard, createWorkspace, listBoards, listWorkspaces, addMember } from "../../support/api";
import { clientFor, connectMcp, consentPage, type McpClient } from "../../support/mcp";

// The workspace is chosen when an agent connects. It becomes where new mindmaps
// go and what list_mindmaps, recall and search look at; an optional `workspace`
// argument (name or id) reaches another one the person belongs to. Personal is
// only reached when asked for. A workspace the person cannot reach is answered
// exactly like one that does not exist.

const word = () => `zq${randomUUID().replace(/-/g, "").slice(0, 10)}`;

async function ok(mcp: McpClient, tool: string, args: Record<string, unknown>) {
  const r = await mcp.call(tool, args);
  expect(r.isError, `${tool}: ${r.text}`).toBe(false);
  return r.text;
}

/** One person with Personal and a team workspace, a card with the same word in each. */
async function setup(request: any) {
  const term = word();
  const personal = (await listWorkspaces(request)).find((w) => w.personal)!;
  const team = await createWorkspace(request, `Atlas ${term}`);
  const personalBoard = await createBoard(request, `Home ${term}`, { workspace_id: personal.id });
  const teamBoard = await createBoard(request, `Crew ${term}`, { workspace_id: team.id });
  const seed = await connectMcp(request, { workspace: personal.id });
  await ok(seed, "add_card", { mindmap_id: personalBoard.id, title: `Personal zebra ${term}` });
  await ok(seed, "add_card", { mindmap_id: teamBoard.id, title: `Team zebra ${term}` });
  return { term, personal, team, personalBoard, teamBoard };
}

const workspaceOf = async (request: any, name: string) =>
  (await listBoards(request)).find((b) => b.name === name)?.workspace_id;

/** Recall must have happened for create_mindmap to be allowed. */
const createMap = async (mcp: McpClient, name: string, extra: Record<string, unknown> = {}) => {
  await ok(mcp, "recall", { query: `nothing-${word()}` });
  return await mcp.call("create_mindmap", { name, nodes: [{ key: "a", title: "A" }], ...extra });
};

test.describe("consent", () => {
  test("the page offers the person's workspaces by name, Personal chosen", async ({ account, request }) => {
    void account;
    const { personal, team } = await setup(request);
    const html = await consentPage(request);
    expect(html).toMatch(/<select[^>]*name="workspace"/);
    expect(html).toContain(team.name);
    expect(html).toMatch(new RegExp(`<option[^>]*value="${personal.id}"[^>]*selected`));
    expect(html).not.toMatch(new RegExp(`<option[^>]*value="${team.id}"[^>]*selected`));
  });

  test("a person with one workspace is not asked to choose", async ({ account, request }) => {
    void account;
    const html = await consentPage(request);
    expect(html).not.toMatch(/<select/);
    expect(html).toContain("Personal");
    const mcp = await connectMcp(request);
    await ok(mcp, "list_mindmaps", {});
  });

  test("the choice decides where the agent works", async ({ account, request }) => {
    void account;
    const s = await setup(request);
    const team = await connectMcp(request, { workspace: s.team.id });
    expect(await ok(team, "search", { query: s.term })).not.toContain("Personal zebra");
    const personal = await connectMcp(request, { workspace: s.personal.id });
    expect(await ok(personal, "search", { query: s.term })).not.toContain("Team zebra");
  });

  test("a workspace the person is not in is refused and no code is issued", async ({ account, request, makePerson }) => {
    void account;
    const other = await makePerson("other");
    const theirs = await createWorkspace(other.request, `Theirs ${word()}`);
    for (const id of [theirs.id, randomUUID()]) {
      await expect(connectMcp(request, { workspace: id })).rejects.toThrow(/approve/);
    }
  });
});

test.describe("defaults to the workspace chosen at connect time", () => {
  test("create_mindmap writes into it", async ({ account, request }) => {
    void account;
    const s = await setup(request);
    const mcp = await connectMcp(request, { workspace: s.team.id });
    const name = `Made ${s.term}`;
    const r = await createMap(mcp, name);
    expect(r.isError, r.text).toBe(false);
    expect(await workspaceOf(request, name)).toBe(s.team.id);
  });

  test("unchanged Approve means Personal", async ({ account, request }) => {
    void account;
    const s = await setup(request);
    const mcp = await connectMcp(request);
    const name = `Made ${s.term}`;
    expect((await createMap(mcp, name)).isError).toBe(false);
    expect(await workspaceOf(request, name)).toBe(s.personal.id);
  });

  test("list_mindmaps lists it, names the workspace, and leaves the rest out", async ({ account, request }) => {
    void account;
    const s = await setup(request);
    const mcp = await connectMcp(request, { workspace: s.team.id });
    const text = await ok(mcp, "list_mindmaps", {});
    expect(text).toContain(s.teamBoard.name);
    expect(text).toContain(s.team.name);
    expect(text).not.toContain(s.personalBoard.name);
    // the way to the others is named
    expect(text).toContain("Personal");
  });

  test("recall and search stay inside it", async ({ account, request }) => {
    void account;
    const s = await setup(request);
    const mcp = await connectMcp(request, { workspace: s.team.id });
    for (const tool of ["recall", "search"]) {
      const text = await ok(mcp, tool, { query: s.term });
      expect(text, tool).toContain("Team zebra");
      expect(text, tool).not.toContain("Personal zebra");
    }
  });

  test("a board named by id still works wherever it is", async ({ account, request }) => {
    void account;
    const s = await setup(request);
    const mcp = await connectMcp(request, { workspace: s.team.id });
    await ok(mcp, "add_card", { mindmap_id: s.personalBoard.id, title: `Extra ${s.term}` });
    expect(await ok(mcp, "get_mindmap", { id: s.personalBoard.id })).toContain(`Extra ${s.term}`);
    // and a search narrowed to that board finds it, workspace or not
    expect(await ok(mcp, "search", { query: s.term, mindmap_id: s.personalBoard.id })).toContain("Personal zebra");
  });

  test("it survives a refresh", async ({ account, request }) => {
    void account;
    const s = await setup(request);
    const mcp = await (await connectMcp(request, { workspace: s.team.id })).refresh();
    const name = `Made ${s.term}`;
    expect((await createMap(mcp, name)).isError).toBe(false);
    expect(await workspaceOf(request, name)).toBe(s.team.id);
    expect(await ok(mcp, "search", { query: s.term })).not.toContain("Personal zebra");
  });
});

test.describe("the workspace argument", () => {
  test("targets another workspace by name or id, on every defaulted tool", async ({ account, request }) => {
    void account;
    const s = await setup(request);
    const mcp = await connectMcp(request, { workspace: s.team.id });

    // Personal, by name (any case) and by id
    for (const ref of ["Personal", "personal", s.personal.id]) {
      for (const tool of ["recall", "search"]) {
        const text = await ok(mcp, tool, { query: s.term, workspace: ref });
        expect(text, `${tool} ${ref}`).toContain("Personal zebra");
        expect(text, `${tool} ${ref}`).not.toContain("Team zebra");
      }
      const list = await ok(mcp, "list_mindmaps", { workspace: ref });
      expect(list).toContain(s.personalBoard.name);
      expect(list).not.toContain(s.teamBoard.name);
    }

    const name = `Elsewhere ${s.term}`;
    expect((await createMap(mcp, name, { workspace: "Personal" })).isError).toBe(false);
    expect(await workspaceOf(request, name)).toBe(s.personal.id);
  });

  test("Personal is only reached when asked: a team connection never writes there unprompted", async ({ account, request }) => {
    void account;
    const s = await setup(request);
    const mcp = await connectMcp(request, { workspace: s.team.id });
    const before = (await listBoards(request)).filter((b) => b.workspace_id === s.personal.id).length;
    for (let i = 0; i < 2; i++) await createMap(mcp, `Unprompted ${i} ${s.term}`);
    const after = (await listBoards(request)).filter((b) => b.workspace_id === s.personal.id).length;
    expect(after).toBe(before);
  });

  test("an unreachable workspace is answered as a missing one, on every defaulted tool", async ({ account, request, makePerson }) => {
    void account;
    const s = await setup(request);
    const other = await makePerson("other");
    const theirs = await createWorkspace(other.request, `Theirs ${word()}`);
    const mcp = await connectMcp(request, { workspace: s.team.id });

    const calls: Array<[string, Record<string, unknown>]> = [
      ["recall", { query: s.term }],
      ["search", { query: s.term }],
      ["list_mindmaps", {}],
    ];
    const answer = async (tool: string, args: Record<string, unknown>, ref: string) => {
      const r = tool === "create_mindmap"
        ? await createMap(mcp, `Nope ${s.term}`, { workspace: ref })
        : await mcp.call(tool, { ...args, workspace: ref });
      expect(r.isError, `${tool} ${ref}: ${r.text}`).toBe(true);
      return r.text.split(ref).join("<ref>");
    };
    for (const [tool, args] of [...calls, ["create_mindmap", {}] as [string, Record<string, unknown>]]) {
      const missing = await answer(tool, args, randomUUID());
      expect(await answer(tool, args, theirs.id), tool).toBe(missing);
      expect(await answer(tool, args, theirs.name), tool).toBe(
        (await answer(tool, args, `No such ${word()}`)),
      );
    }
    // and nothing leaked into their workspace
    expect((await listBoards(other.request)).filter((b) => b.workspace_id === theirs.id)).toEqual([]);
  });

  test("a view-only member can look in a workspace but not create there", async ({ account, request, makePerson }) => {
    void account;
    const s = await setup(request);
    const viewer = await makePerson("viewer");
    await addMember(request, "workspaces", s.team.id, viewer.user.email, "viewer");
    const mcp = await connectMcp(viewer.request, { workspace: s.team.id });
    expect(await ok(mcp, "list_mindmaps", {})).toContain(s.teamBoard.name);
    const r = await createMap(mcp, `Viewer ${s.term}`);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/view-only/i);
    expect(await workspaceOf(viewer.request, `Viewer ${s.term}`)).toBeUndefined();
  });
});
