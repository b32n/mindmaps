import { test, expect } from "../../fixtures";
import { createBoard } from "../../support/api";
import { connectMcp } from "../../support/mcp";

// Tool calls that used to come back as a JSON-RPC -32603 with SQL or a stack in
// the message. The MCP client helper only reads `result`, so a crash shows up
// here as an empty `text` and a failed expectation.

test.describe("a first, empty recall", () => {
  test("recall with no hits says where to write instead of crashing", async ({ account, request }) => {
    void account;
    await createBoard(request, "Kitchen notes", { description: "recipes and shopping" });
    const mcp = await connectMcp(request);
    const r = await mcp.call("recall", { query: "qwertyuiop-no-such-thing" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Nothing recorded");
    expect(r.text).toContain("This is the moment to write it down");
    expect(r.text).toContain("Kitchen notes");
  });

  test("create_mindmap before any recall asks for a recall first and names the existing mindmaps", async ({ account, request }) => {
    void account;
    await createBoard(request, "Garden plan", { description: "beds and seeds" });
    const mcp = await connectMcp(request);
    const r = await mcp.call("create_mindmap", { name: "Another", nodes: [{ title: "x" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Call `recall` before creating a mindmap");
    expect(r.text).toContain("Garden plan");
  });
});

test.describe("create_artefact", () => {
  test("without a type it creates a sheet", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Numbers");
    const mcp = await connectMcp(request);
    const r = await mcp.call("create_artefact", {
      mindmap_id: board.id,
      title: "Budget",
      sheets: [{ name: "Q1", rows: [["item", "cost"], ["tea", 3]] }],
    });
    expect(r.isError, r.text).toBe(false);
    const id = /card id: `([^`]+)`/.exec(r.text)?.[1];
    expect(id, r.text).toBeTruthy();
    const art = await (await request.get(`/api/artefacts/${id}`)).json();
    expect(JSON.stringify(art)).toContain("Q1");
    const node = await (await request.get(`/api/nodes/${id}`)).json().catch(() => null);
    if (node?.type) expect(node.type).toBe("sheet");
  });

  test("an unknown type still falls back to a sheet, as before", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Numbers");
    const mcp = await connectMcp(request);
    const r = await mcp.call("create_artefact", { mindmap_id: board.id, type: "bogus", sheets: [{ rows: [["a"]] }] });
    expect(r.isError, r.text).toBe(false);
  });

  for (const [label, args, field] of [
    ["a null sheet", { type: "sheet", sheets: [null] }, "sheets[0]"],
    ["rows that are not a list", { type: "sheet", sheets: [{ rows: "abc" }] }, "sheets[0].rows"],
    ["a sheet that is a string", { type: "sheet", sheets: ["x"] }, "sheets[0]"],
    ["a null slide", { type: "deck", slides: [null] }, "slides[0]"],
    ["slide bullets that are a string", { type: "deck", slides: [{ bullets: "x" }] }, "slides[0].bullets"],
  ] as const) {
    test(`junk input (${label}) names the bad field`, async ({ account, request }) => {
      void account;
      const board = await createBoard(request, "Junk");
      const mcp = await connectMcp(request);
      const r = await mcp.call("create_artefact", { mindmap_id: board.id, title: "T", ...args });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(field);
      expect(r.text).not.toMatch(/Cannot read|is not a function|undefined/);
    });
  }

  test("junk input on update_artefact is named too, and nothing is changed", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Junk");
    const mcp = await connectMcp(request);
    const made = await mcp.call("create_artefact", { mindmap_id: board.id, type: "sheet", sheets: [{ rows: [["keep"]] }] });
    const id = /card id: `([^`]+)`/.exec(made.text)![1];
    const r = await mcp.call("update_artefact", { id, sheets: [null] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("sheets[0]");
    expect(JSON.stringify(await (await request.get(`/api/artefacts/${id}`)).json())).toContain("keep");
  });
});

test.describe("unexpected failures", () => {
  test("come back as a tool error with a generic message, not SQL or a stack", async ({ account, request }) => {
    void account;
    const mcp = await connectMcp(request);
    // A real recall first so create_mindmap gets past its gate to the code that
    // chokes on a null node.
    await mcp.call("recall", { query: "anything at all" });
    const r = await mcp.call("create_mindmap", { name: "Boom", nodes: [null] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/That failed \(ref [a-z0-9]+\)/);
    expect(r.text).toContain("nothing was written");
    expect(r.text).not.toMatch(/Cannot read|TypeError|D1_ERROR|SELECT|\n\s+at /);
  });
});
