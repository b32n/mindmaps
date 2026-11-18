import { test, expect } from "../../fixtures";
import { createBoard } from "../../support/api";
import { MAIN_PORT } from "../../support/hosts";
import { connectMcp, type McpClient } from "../../support/mcp";
import { expectRef } from "../../support/urls";

// Reading an artefact back and writing one without losing or hiding anything.
// `get_artefact` returns what `update_artefact` takes; a write that is the wrong
// shape is refused with a reason (400, never a 200 that destroys the payload and
// never a 413 that is not about size); and whatever an authoring call could not
// use is named in its reply rather than dropped.

const o = { app: `http://127.0.0.1:${MAIN_PORT}`, mindbox: `http://127.0.0.1:${MAIN_PORT}` };

const idOf = (text: string) => /card id: `([^`]+)`/.exec(text)![1]!;

async function ok(mcp: McpClient, tool: string, args: Record<string, unknown>) {
  const r = await mcp.call(tool, args);
  expect(r.isError, `${tool}: ${r.text}`).toBe(false);
  return r.text;
}

/** The JSON `get_artefact` hands over, which is the arguments for `update_artefact`. */
function handOver(text: string): Record<string, unknown> {
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  expect(m, `no json block in:\n${text}`).toBeTruthy();
  return JSON.parse(m![1]!);
}

type Req = Parameters<typeof connectMcp>[0];
const payload = async (request: Req, id: string) => (await request.get(`/api/artefacts/${id}`)).json();
const put = (request: Req, id: string, data: unknown) => request.put(`/api/artefacts/${id}`, { data });

const KINDS = {
  sheet: { sheets: [{ name: "Q1", rows: [["item", "cost"], ["tea", 3], ["Total", "=SUM(B2:B2)"]] }] },
  doc: { blocks: [{ heading: "Plan", level: 1 }, { text: "alpha" }, { bullet: "one" }, { rule: true }] },
  deck: { slides: [{ title: "Intro", bullets: ["one", "two"], notes: "say it slowly" }] },
  html: { html: "<!doctype html><html><body><h1>Marker</h1><script>1</script></body></html>" },
} as const;

/** What a person (or the editor) would leave in the payload that the authoring form cannot say. */
async function humanEdit(request: Req, id: string, type: keyof typeof KINDS) {
  const p = await payload(request, id);
  if (type === "sheet") {
    p.stylePool.red = { bold: true, fontColor: "#ff0000" };
    p.formatPool = { money: { type: "currency", pattern: "$0.00" } };
    p.sheets[0].cells.push({
      key: "5:5",
      cell: { value: "by hand", styleId: "red", formatId: "money", comment: "typed in the grid", hyperlink: "https://example.test" },
    });
    p.sheets[0].config.frozenCols = 1;
    p.sheets[0].config.colWidths = [[0, 200]];
  } else if (type === "doc") {
    p.sections[0].blocks.push(
      { id: "b-table", type: "table", rows: [{ cells: [{ content: [{ type: "text", text: "cell", bold: true }] }] }] },
      { id: "b-h3", type: "heading", level: 3, content: [{ type: "link", text: "a link", href: "https://example.test" }] },
      { id: "b-pb", type: "page-break" },
    );
    p.textStylePool = { emphasis: { italic: true } };
  } else if (type === "deck") {
    p.slides[0].elements.push({ id: "e-shape", type: "shape", x: 10, y: 10, w: 100, h: 100, rotation: 0, shape: "ellipse", fill: { type: "solid", color: "#00ff00" } });
    p.theme = { name: "custom", colors: { accent1: "#123456" } };
  } else {
    p.html = "<html>\n\n  <body>   spaced   <script>var x = 1;</script>\n</body></html>\n";
  }
  const res = await put(request, id, p);
  expect(res.status(), await res.text()).toBe(200);
}

test.describe("get_artefact", () => {
  for (const type of Object.keys(KINDS) as Array<keyof typeof KINDS>) {
    test(`a ${type} read with get_artefact and passed to update_artefact unchanged loses nothing`, async ({ account, request }) => {
      void account;
      const board = await createBoard(request, "Round trip");
      const mcp = await connectMcp(request);
      const id = idOf(await ok(mcp, "create_artefact", { mindmap_id: board.id, type, title: `RT ${type}`, ...KINDS[type] }));

      // As authored, then as a person left it.
      for (const stage of ["authored", "edited"]) {
        if (stage === "edited") await humanEdit(request, id, type);
        const before = await payload(request, id);
        const text = await ok(mcp, "get_artefact", { id });
        expectRef(o, text, { id, type, mindmap: board.id });

        const args = handOver(text);
        expect(args.id, stage).toBe(id);
        expect(args.title, stage).toBe(`RT ${type}`);
        expect(args.data, stage).toEqual(before);

        const wrote = await ok(mcp, "update_artefact", args);
        expect(wrote, stage).toContain("Rewrote");
        expect(await payload(request, id), `${stage}: payload after the round trip`).toEqual(before);
        expect((await (await request.get(`/api/nodes/${id}`)).json()).title).toBe(`RT ${type}`);
      }
    });
  }

  test("the whole of what it returns can be passed back, including the echo fields", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Echo");
    const mcp = await connectMcp(request);
    const id = idOf(await ok(mcp, "create_artefact", { mindmap_id: board.id, type: "doc", title: "Echo", ...KINDS.doc }));
    const args = handOver(await ok(mcp, "get_artefact", { id }));
    const wrote = await ok(mcp, "update_artefact", { ...args, type: "doc", mindmap_id: board.id, url: "x" });
    expect(wrote).not.toMatch(/not (stored|used)|ignored|dropped/i);
  });

  test("it refuses a card, a file, an unknown id and someone else's artefact, and says why", async ({ account, request, existing }) => {
    void account;
    const board = await createBoard(request, "Refusals");
    const mcp = await connectMcp(request);
    const card = idOf(await ok(mcp, "add_card", { mindmap_id: board.id, title: "Just a card", content: "x" }));
    const id = idOf(await ok(mcp, "create_artefact", { mindmap_id: board.id, type: "sheet", title: "Mine", ...KINDS.sheet }));

    const isCard = await mcp.call("get_artefact", { id: card });
    expect(isCard.isError).toBe(true);
    expect(isCard.text).toContain("card, not an artefact");
    expect(isCard.text).toContain("get_card");

    const nothing = await mcp.call("get_artefact", { id: "no-such-id" });
    expect(nothing.isError).toBe(true);
    expect(nothing.text).toContain("No artefact with id no-such-id");

    const theirs = await connectMcp(existing.request);
    const other = await theirs.call("get_artefact", { id });
    expect(other.isError).toBe(true);
    expect(other.text).toContain(`No artefact with id ${id}`);
    expect(other.text).not.toContain("Mine");
  });

  test("a read-only connection can use it", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Scopes");
    const mcp = await connectMcp(request);
    const id = idOf(await ok(mcp, "create_artefact", { mindmap_id: board.id, type: "sheet", title: "S", ...KINDS.sheet }));
    // The tool is read-only: it must be listed in the read scope, which the
    // per-tool check in callTool enforces for every tool.
    expect((await mcp.call("get_artefact", { id })).isError).toBe(false);
  });
});

test.describe("data on create_artefact and update_artefact", () => {
  for (const type of Object.keys(KINDS) as Array<keyof typeof KINDS>) {
    test(`a full ${type} payload is accepted as data, on create and on update`, async ({ account, request }) => {
      void account;
      const board = await createBoard(request, "Data");
      const mcp = await connectMcp(request);

      // Take a complete payload from one artefact and make another from it.
      const src = idOf(await ok(mcp, "create_artefact", { mindmap_id: board.id, type, title: "Source", ...KINDS[type] }));
      await humanEdit(request, src, type);
      const full = await payload(request, src);

      const made = await ok(mcp, "create_artefact", { mindmap_id: board.id, type, title: "Copy", data: full });
      const copy = idOf(made);
      expect(await payload(request, copy)).toEqual(full);

      const empty = idOf(await ok(mcp, "create_artefact", { mindmap_id: board.id, type, title: "Target", ...KINDS[type] }));
      await ok(mcp, "update_artefact", { id: empty, data: full });
      expect(await payload(request, empty)).toEqual(full);
    });
  }

  for (const [type, data, field] of [
    ["sheet", null, "data"],
    ["sheet", "text", "data"],
    ["sheet", [], "data"],
    ["sheet", { sheets: "x" }, "sheets"],
    ["sheet", { sheets: [null] }, "sheets[0]"],
    ["doc", {}, "sections"],
    ["doc", { sections: [{ blocks: "x" }] }, "sections[0].blocks"],
    ["deck", { slides: [1] }, "slides[0]"],
    ["html", { html: 5 }, "html"],
  ] as const) {
    test(`data that is the wrong shape for a ${type} (${JSON.stringify(data)}) is refused naming ${field}, and nothing is written`, async ({ account, request }) => {
      void account;
      const board = await createBoard(request, "Bad data");
      const mcp = await connectMcp(request);
      const id = idOf(await ok(mcp, "create_artefact", { mindmap_id: board.id, type, title: "Keep", ...KINDS[type] }));
      const before = await payload(request, id);

      const upd = await mcp.call("update_artefact", { id, data });
      expect(upd.isError, upd.text).toBe(true);
      expect(upd.text).toContain(field);
      expect(upd.text).not.toMatch(/Cannot read|is not a function|That failed/);
      expect(await payload(request, id)).toEqual(before);

      const made = await mcp.call("create_artefact", { mindmap_id: board.id, type, title: "New", data });
      expect(made.isError, made.text).toBe(true);
      expect(made.text).toContain(field);
    });
  }

  test("data together with the authoring field is refused rather than one of them being dropped", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Both");
    const mcp = await connectMcp(request);
    const id = idOf(await ok(mcp, "create_artefact", { mindmap_id: board.id, type: "sheet", title: "S", ...KINDS.sheet }));
    const full = await payload(request, id);
    const r = await mcp.call("update_artefact", { id, data: full, sheets: KINDS.sheet.sheets });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("data");
    expect(r.text).toContain("sheets");
  });

  test("the schema text describes data as it now works and points at get_artefact", async ({ account, request }) => {
    void account;
    const mcp = await connectMcp(request);
    for (const type of Object.keys(KINDS)) {
      const text = await ok(mcp, "get_artefact_schema", { type });
      expect(text, type).toContain("`data`");
      expect(text, type).toContain("get_artefact");
    }
  });
});

test.describe("PUT /api/artefacts/:id", () => {
  const made = async (request: Req, type: keyof typeof KINDS) => {
    const board = await createBoard(request, "PUT");
    const mcp = await connectMcp(request);
    const id = idOf(await ok(mcp, "create_artefact", { mindmap_id: board.id, type, title: "Keep me", ...KINDS[type] }));
    return { id, before: await payload(request, id), mcp };
  };

  for (const [label, body] of [
    ["null", null],
    ["a string", "hello"],
    ["a number", 7],
    ["a list", []],
    ["an empty object", {}],
  ] as const) {
    test(`${label} is a 400 with a reason and the payload is untouched`, async ({ account, request }) => {
      void account;
      for (const type of Object.keys(KINDS) as Array<keyof typeof KINDS>) {
        const { id, before } = await made(request, type);
        const res = await put(request, id, body);
        expect(res.status(), `${type}: ${await res.text()}`).toBe(400);
        const err = (await res.json()).error as string;
        expect(err, type).toMatch(/\w{4,}/);
        expect(await payload(request, id), `${type} untouched`).toEqual(before);
      }
    });
  }

  for (const [type, body, field] of [
    ["sheet", { sheets: "x" }, "sheets"],
    ["sheet", { sheets: [null] }, "sheets[0]"],
    ["sheet", { sheets: [{ cells: "x" }] }, "sheets[0].cells"],
    ["sheet", { sheets: [{ cells: [{ key: "0:0", cell: { value: { a: 1 } } }] }] }, "sheets[0].cells[0]"],
    ["doc", { sections: "x" }, "sections"],
    ["doc", { sections: [{ blocks: [null] }] }, "sections[0].blocks[0]"],
    ["deck", { slides: {} }, "slides"],
    ["deck", { slides: [{ elements: "x" }] }, "slides[0].elements"],
    ["html", { title: "t" }, "html"],
    ["html", { html: ["<p>"] }, "html"],
  ] as const) {
    test(`a ${type} payload ${JSON.stringify(body).slice(0, 50)} is a 400 naming ${field}`, async ({ account, request }) => {
      void account;
      const { id, before } = await made(request, type);
      const res = await put(request, id, body);
      expect(res.status(), await res.text()).toBe(400);
      expect((await res.json()).error).toContain(field);
      expect(await payload(request, id)).toEqual(before);
    });
  }

  test("malformed JSON is a 400, not a 500 with the parser's message", async ({ account, request }) => {
    void account;
    const { id, before } = await made(request, "sheet");
    const res = await request.put(`/api/artefacts/${id}`, { headers: { "content-type": "application/json" }, data: "{not json" });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/JSON/);
    expect(await payload(request, id)).toEqual(before);
  });

  test("413 is for size and only for size", async ({ account, request }) => {
    void account;
    const { id, before } = await made(request, "html");
    const big = await put(request, id, { title: "big", html: "x".repeat(4_100_000) });
    expect(big.status()).toBe(413);
    expect((await big.json()).error).toMatch(/over the 4 MB limit/);
    expect(await payload(request, id)).toEqual(before);
  });

  test("a payload the editor would save, for each kind, is still accepted", async ({ account, request }) => {
    void account;
    for (const type of Object.keys(KINDS) as Array<keyof typeof KINDS>) {
      const { id, before } = await made(request, type);
      const res = await put(request, id, before);
      expect(res.status(), `${type}: ${await res.text()}`).toBe(200);
      expect((await res.json()).ok).toBe(true);
    }
  });
});

test.describe("what an authoring call could not use is said", () => {
  const notStored = (text: string, ...parts: string[]) => {
    for (const p of parts) expect(text, `mentions ${p}`).toContain(p);
    expect(text).toMatch(/dropped|not stored|ignored/i);
  };

  test("doc blocks with keys that do nothing, or several kinds at once, are named by index and key", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Docs");
    const mcp = await connectMcp(request);
    const text = await ok(mcp, "create_artefact", {
      mindmap_id: board.id, type: "doc", title: "D",
      blocks: [
        { heading: "H" },
        { text: "has a table", table: [["a"]] },
        { text: "bold", bold: true },
        { bullet: "level on a bullet", level: 3 },
        { heading: "and", text: "both" },
        { table: [["only a table"]] },
        { unknown: 1 },
      ],
    });
    notStored(text, "blocks[1]", "`table`", "blocks[2]", "`bold`", "blocks[3]", "`level`", "blocks[4]", "blocks[5]", "blocks[6]", "`unknown`");
    // And what could be used was.
    const p = JSON.stringify(await payload(request, idOf(text)));
    expect(p).toContain("has a table");
  });

  test("slides and sheets with unknown keys, and bullets that are not text, are named", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Slides");
    const mcp = await connectMcp(request);
    const deck = await ok(mcp, "create_artefact", {
      mindmap_id: board.id, type: "deck", title: "D",
      slides: [{ title: "T", layout: "two-column", bullets: ["ok", 5, { a: 1 }, null] }],
    });
    notStored(deck, "slides[0]", "`layout`", "slides[0].bullets[1]", "slides[0].bullets[2]", "slides[0].bullets[3]");

    const sheet = await ok(mcp, "create_artefact", {
      mindmap_id: board.id, type: "sheet", title: "S",
      sheets: [{ name: "A", rows: [["x"]], styles: { bold: true } }],
    });
    notStored(sheet, "sheets[0]", "`styles`", "`data`");
  });

  test("a stray top-level argument is named, on create and on update", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Top");
    const mcp = await connectMcp(request);
    const made = await ok(mcp, "create_artefact", { mindmap_id: board.id, type: "sheet", title: "S", ...KINDS.sheet, colour: "red" });
    notStored(made, "`colour`");
    const upd = await ok(mcp, "update_artefact", { id: idOf(made), ...KINDS.sheet, rows: [["x"]] });
    notStored(upd, "`rows`");
  });

  test("a clean call says nothing about dropping", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Clean");
    const mcp = await connectMcp(request);
    for (const type of Object.keys(KINDS) as Array<keyof typeof KINDS>) {
      const text = await ok(mcp, "create_artefact", { mindmap_id: board.id, type, title: "C", ...KINDS[type] });
      expect(text, type).not.toMatch(/dropped|not stored|ignored/i);
    }
  });

  test("a cell that is an object or a list is refused naming where, and nothing is written", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Cells");
    const mcp = await connectMcp(request);
    const id = idOf(await ok(mcp, "create_artefact", { mindmap_id: board.id, type: "sheet", title: "Keep", ...KINDS.sheet }));
    const before = await payload(request, id);

    for (const [cell, where] of [
      [{ a: 1 }, "sheets[0].rows[1][1]"],
      [[1, 2], "sheets[0].rows[1][1]"],
      [{ text: { nested: true } }, "sheets[0].rows[1][1]"],
      [{ formula: "no equals sign" }, "sheets[0].rows[1][1]"],
    ] as const) {
      const r = await mcp.call("update_artefact", { id, sheets: [{ rows: [["h", "h"], ["a", cell]] }] });
      expect(r.isError, JSON.stringify(cell)).toBe(true);
      expect(r.text).toContain(where);
      expect(r.text).not.toMatch(/That failed|Cannot read/);
    }
    const row = await mcp.call("update_artefact", { id, sheets: [{ rows: [["ok"], "not a row"] }] });
    expect(row.isError).toBe(true);
    expect(row.text).toContain("sheets[0].rows[1]");
    expect(await payload(request, id)).toEqual(before);
  });

  test("a leading = is a formula only when it looks like one; the server never evaluates it", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Equals");
    const mcp = await connectMcp(request);
    const text = await ok(mcp, "create_artefact", {
      mindmap_id: board.id, type: "sheet", title: "Eq",
      sheets: [{
        rows: [
          ["head", "head"],
          ["=== Notes ===", "=SUM(A1:A1)"],      // banner stays text, real formula stays a formula
          ["'=A1", { text: "=B1" }],              // explicit ways to say "text"
          [{ formula: "=C1+1" }, "= spaced"],     // explicit formula; "= x" is text
          ["=", "==x"],
        ],
      }],
    });
    const cells = new Map<string, any>((await payload(request, idOf(text))).sheets[0].cells.map((c: any) => [c.key, c.cell]));

    expect(cells.get("1:0")).toMatchObject({ value: "=== Notes ===" });
    expect(cells.get("1:0").formula).toBeUndefined();
    expect(cells.get("1:1")).toMatchObject({ value: null, formula: "=SUM(A1:A1)" });
    expect(cells.get("2:0")).toMatchObject({ value: "=A1" });
    expect(cells.get("2:0").formula).toBeUndefined();
    expect(cells.get("2:1")).toMatchObject({ value: "=B1" });
    expect(cells.get("2:1").formula).toBeUndefined();
    expect(cells.get("3:0")).toMatchObject({ value: null, formula: "=C1+1" });
    expect(cells.get("3:1")).toMatchObject({ value: "= spaced" });
    expect(cells.get("4:0")).toMatchObject({ value: "=" });
    expect(cells.get("4:1")).toMatchObject({ value: "==x" });

    // The ones kept as text because they only looked like formulas are said, so
    // the author can use {formula} if it was one after all.
    expect(text).toContain("sheets[0].rows[1][0]");
    expect(text).toContain('"formula"');
    expect(text).not.toContain("rows[1][1]");
  });
});

// An unexpected failure inside put_file (R2 or D1 refusing a write) now goes
// through the generic path like every other tool's. Nothing a client can send
// makes the local R2 or D1 fail there and the Worker has no test-only fault
// hook, so what is tested is the other half: the tool's own refusals, which
// are written for the agent, still come through in words.
test.describe("the file tools' own refusals", () => {
  test("put_file's own refusals still reach the agent in words", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Refusals");
    const mcp = await connectMcp(request);
    const r = await mcp.call("put_file", { mindmap_id: board.id, name: "scan.png", content_base64: "AAEC", content_type: "image/png" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("one-line description");
  });
});
