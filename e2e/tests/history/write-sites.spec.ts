import { test, expect } from "@playwright/test";
import { migrationFiles, migrationSql, workerSources } from "../../support/versions";

// A static guard, so a new way of writing a card, an artefact or a file cannot
// skip the version history. Every place in the Worker that writes a node's
// content, or an artefact's bytes, has to be in versions.ts (the one choke
// point) or on the short list below with the reason it is not a content write.
// Adding a write elsewhere fails this test until it goes through the choke point.

interface Allowed {
  file: string;
  /** What the matching source line contains, so a different statement in the same file is not waved through. */
  contains: string;
  why: string;
}

const ALLOWED: Allowed[] = [
  {
    file: "mcp.ts",
    contains: "json_remove",
    why: "relayout clears the hand-placed flag and moves the card; position, not content",
  },
  {
    file: "index.ts",
    contains: "body = ?, index_dirty = ?",
    why: "remarkdown repairs the derived markdown of a document that did not change",
  },
  {
    file: "artefacts.ts",
    contains: "ARTEFACTS.put(stored.data.r2",
    why: "putArtefact itself; the pattern above fails if anything but versions.ts calls it",
  },
  {
    file: "files.ts",
    contains: "ARTEFACTS.put(key, body",
    why: "uploaded bytes go to a new key per upload and never overwrite; the node write that follows goes through the choke point",
  },
  {
    file: "files.ts",
    contains: "INSERT INTO files",
    why: "the file's row; storeFile then rewrites the node through the choke point",
  },
];

const PATTERNS: Array<[string, RegExp]> = [
  ["INSERT INTO nodes", /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+nodes\b/],
  ["UPDATE nodes of title/body/doc/data", /UPDATE\s+nodes\b[^`;]*?\b(?:title|body|doc|data)\s*=/],
  ["UPDATE nodes with a built SET list", /UPDATE\s+nodes\s+SET\s+\$\{/],
  ["a node row replayed into nodes", /reinsert\([^)]*["']nodes["']/],
  ["an artefact object written", /ARTEFACTS\.put\(/],
  ["putArtefact called", /\bputArtefact\(/],
  ["INSERT INTO files", /INSERT\s+INTO\s+files\b/],
];

test("every write to a node's content or an artefact's bytes goes through versions.ts", () => {
  const found: Array<{ file: string; line: number; text: string; what: string }> = [];
  for (const [file, src] of workerSources()) {
    if (file === "versions.ts") continue;
    src.split("\n").forEach((text, i) => {
      // a statement can span lines: look at this line and the next two for the SQL patterns
      const window = [text, src.split("\n")[i + 1] ?? "", src.split("\n")[i + 2] ?? ""].join(" ");
      for (const [what, re] of PATTERNS) {
        const own = re.test(text) || (/UPDATE\s+nodes\b/.test(text) && re.test(window));
        if (own && !/^\s*(\/\/|\*|\/\*)/.test(text)) found.push({ file, line: i + 1, text: text.trim(), what });
      }
    });
  }
  // putArtefact is defined in artefacts.ts; its own definition is not a call
  const calls = found.filter((f) => !/export async function putArtefact/.test(f.text));
  const unexplained = calls.filter((f) => !ALLOWED.some((a) => a.file === f.file && f.text.includes(a.contains) || a.file === f.file && windowHas(f, a)));
  expect(
    unexplained.map((f) => `${f.file}:${f.line} (${f.what}) ${f.text}`),
    "writes that bypass versions.ts",
  ).toEqual([]);
  for (const a of ALLOWED) {
    expect(
      calls.some((f) => f.file === a.file && (f.text.includes(a.contains) || windowHas(f, a))),
      `allow-list entry no longer needed: ${a.file} ${a.contains}`,
    ).toBe(true);
  }
});

function windowHas(f: { file: string; line: number }, a: Allowed): boolean {
  const src = workerSources().find(([n]) => n === f.file)![1].split("\n");
  return src.slice(f.line - 1, f.line + 5).join("\n").includes(a.contains);
}

test("the choke point exists and is the only module that opens these writes", () => {
  const sources = Object.fromEntries(workerSources());
  expect(sources["versions.ts"], "worker/src/versions.ts").toBeTruthy();
  for (const fn of ["writeCard", "writeArtefact"]) expect(sources["versions.ts"]).toContain(`export async function ${fn}`);
});

test("the migration only adds: no ALTER, DROP or DELETE, every CREATE guarded, and the number is the next free one", () => {
  const files = migrationFiles();
  const mine = files.filter((f) => /_versions\.sql$/.test(f));
  expect(mine).toHaveLength(1);
  const number = Number(mine[0]!.slice(0, 4));
  const others = files.filter((f) => f !== mine[0]).map((f) => Number(f.slice(0, 4)));
  expect(others).not.toContain(number);
  expect(number).toBe(Math.max(...others.filter((n) => n < number)) + 1);

  const code = migrationSql(mine[0]!).replace(/--.*$/gm, "");
  expect(code).not.toMatch(/\b(ALTER|DROP|DELETE|UPDATE|INSERT)\b/i);
  for (const stmt of code.split(";").map((s) => s.trim()).filter(Boolean)) {
    expect(stmt, stmt.slice(0, 60)).toMatch(/^CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i);
  }
  // a version row is never deleted: status and timestamps instead
  expect(code).toMatch(/status\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'open'/i);
  expect(code).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
});
