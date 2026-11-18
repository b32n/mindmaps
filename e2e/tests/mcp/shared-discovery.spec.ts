import { randomUUID } from "node:crypto";
import { test, expect } from "../../fixtures";
import { addMember, createBoard } from "../../support/api";
import { connectMcp, type McpClient } from "../../support/mcp";

// An artefact handed to one person on its own (a grant, not a share of its
// mindmap) has to be findable by them: `search` and `recall` return it and
// `list_mindmaps` lists it under "shared with you". Every artefact tool then
// behaves by role: a viewer reads but cannot write, an editor does both, and a
// stranger gets exactly what a missing id gets.

const idOf = (text: string) => /card id: `([^`]+)`/.exec(text)![1]!;
const word = () => `zq${randomUUID().replace(/-/g, "").slice(0, 10)}`;

async function ok(mcp: McpClient, tool: string, args: Record<string, unknown>) {
  const r = await mcp.call(tool, args);
  expect(r.isError, `${tool}: ${r.text}`).toBe(false);
  return r.text;
}

async function setup(makePerson: (l?: string) => Promise<any>, request: any) {
  const term = word();
  const board = await createBoard(request, `Private ${term}`);
  const owner = await connectMcp(request);
  const id = idOf(
    await ok(owner, "create_artefact", {
      mindmap_id: board.id,
      type: "doc",
      title: `Findings ${term}`,
      blocks: [{ heading: `Heading ${term}` }, { text: `body about ${term}` }],
    }),
  );
  const who = async (role: string) => {
    const p = await makePerson(role);
    return { mcp: await connectMcp(p.request), email: p.user.email as string };
  };
  const viewer = await who("viewer");
  const editor = await who("editor");
  const stranger = await who("stranger");
  await addMember(request, "artefacts", id, viewer.email, "viewer");
  await addMember(request, "artefacts", id, editor.email, "editor");
  return { term, board, owner, id, viewer, editor, stranger };
}

test.describe("an artefact shared on its own", () => {
  for (const role of ["viewer", "editor"] as const) {
    test(`${role}: search, recall and list_mindmaps find it`, async ({ account, request, makePerson }) => {
      void account;
      const s = await setup(makePerson, request);
      const who = s[role].mcp;

      const found = await ok(who, "search", { query: s.term });
      expect(found).toContain(s.id);
      expect(found).toContain(`Findings ${s.term}`);

      const recalled = await ok(who, "recall", { query: s.term });
      expect(recalled).toContain(s.id);

      const listed = await ok(who, "list_mindmaps", {});
      expect(listed).toMatch(/shared with you/i);
      expect(listed).toContain(s.id);
      expect(listed).toContain(`Findings ${s.term}`);
      // the mindmap it sits on stays private and unnamed
      expect(listed).not.toContain(`Private ${s.term}`);
      expect(listed).not.toContain(s.board.id);
    });
  }

  test("the owner's list_mindmaps has no shared-with-you section for their own work", async ({ account, request, makePerson }) => {
    void account;
    const s = await setup(makePerson, request);
    expect(await ok(s.owner, "list_mindmaps", {})).not.toMatch(/shared with you/i);
  });

  test("a stranger finds nothing, and is told what a missing id is told", async ({ account, request, makePerson }) => {
    void account;
    const s = await setup(makePerson, request);
    const them = s.stranger.mcp;
    expect(await ok(them, "search", { query: s.term })).not.toContain(s.id);
    expect(await ok(them, "recall", { query: s.term })).not.toContain(s.id);
    expect(await ok(them, "list_mindmaps", {})).not.toContain(s.id);

    const missing = "nope-" + randomUUID();
    const norm = (t: string, id: string) => t.split(id).join("<id>");
    for (const [tool, args] of [
      ["get_artefact", {}],
      ["get_card", {}],
      ["update_artefact", { blocks: [{ text: "x" }] }],
      ["get_context", {}],
    ] as const) {
      const real = await them.call(tool, { id: s.id, ...args });
      const gone = await them.call(tool, { id: missing, ...args });
      expect(real.isError, tool).toBe(true);
      expect(norm(real.text, s.id), tool).toBe(norm(gone.text, missing));
    }
    const m = await them.call("get_mindmap", { id: s.board.id });
    const g = await them.call("get_mindmap", { id: missing });
    expect(m.isError).toBe(true);
    expect(norm(m.text, s.board.id)).toBe(norm(g.text, missing));
  });

  test("a viewer reads but cannot write; an editor does both", async ({ account, request, makePerson }) => {
    void account;
    const s = await setup(makePerson, request);

    for (const who of [s.viewer.mcp, s.editor.mcp]) {
      expect(await ok(who, "get_artefact", { id: s.id })).toContain(`body about ${s.term}`);
      expect(await ok(who, "get_card", { id: s.id })).toContain(`Findings ${s.term}`);
    }

    const denied = await s.viewer.mcp.call("update_artefact", { id: s.id, blocks: [{ text: "viewer was here" }] });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/view-only/);
    const title = await s.viewer.mcp.call("update_artefact", { id: s.id, title: "renamed" });
    expect(title.isError).toBe(true);
    expect(await ok(s.owner, "get_artefact", { id: s.id })).not.toContain("viewer was here");

    await ok(s.editor.mcp, "update_artefact", { id: s.id, blocks: [{ text: `edited ${s.term}` }] });
    expect(await ok(s.owner, "get_artefact", { id: s.id })).toContain(`edited ${s.term}`);
    // a viewer sees the editor's change
    expect(await ok(s.viewer.mcp, "get_artefact", { id: s.id })).toContain(`edited ${s.term}`);
  });

  test("a grant on the artefact opens nothing else on its mindmap", async ({ account, request, makePerson }) => {
    void account;
    const s = await setup(makePerson, request);
    const other = await ok(s.owner, "add_card", { mindmap_id: s.board.id, title: `Sibling ${s.term}`, body: "private" });
    const siblingId = idOf(other);
    for (const who of [s.viewer.mcp, s.editor.mcp]) {
      const r = await who.call("get_card", { id: siblingId });
      expect(r.isError).toBe(true);
      expect((await ok(who, "search", { query: s.term })).includes(siblingId)).toBe(false);
      expect((await who.call("get_mindmap", { id: s.board.id })).isError).toBe(true);
    }
  });
});
