/**
 * The one mindmap a new account starts with.
 *
 * An infinite canvas is a worse empty state than an empty text editor: there is
 * no obvious first gesture, and "No mindmaps yet" plus a button doesn't suggest
 * one. So a new account gets exactly one board.
 *
 * What it deliberately is *not* is a set of generic productivity boards — a
 * seeded TODO most of all. Linear owns status and assignee (DESIGN.md §2), and
 * a board that needs hand-updating to stay true is the exact failure mode §7 is
 * written against. Seeded content nobody asked for also doesn't get deleted; it
 * just sits in the rail making the workspace feel like someone else's.
 *
 * So this board does the one job worth doing at signup: it is the tutorial and
 * the MCP setup instructions at once, and its own structure — a card that opens
 * into a document, two cards joined by a labelled link — is the demonstration.
 * It says to delete it, and because it is only ever written at account
 * creation, deleting it is permanent.
 */

import { markdownToBlocks, blocksToMarkdown, type Block } from "./markdown";

/** Board and node ids are per-user, but the keys that identify them are fixed. */
const BOARD_KEY = "start-here";

const id = () => crypto.randomUUID();
const now = () => Date.now();

interface Card {
  key: string;
  type: "card" | "note";
  title: string;
  md: string;
  x: number;
  y: number;
}

/** Laid out left-to-right, matching the default `direction` of the MCP tools. */
const cards = (origin: string): Card[] => [
  {
    key: "connect",
    type: "card",
    title: "Connect your agent harness",
    x: 60,
    y: 60,
    md: [
      "This board is readable and writable over MCP, so a Claude Code or Cursor",
      "session can leave what it learned behind and pick it up next time.",
      "",
      "```",
      `claude mcp add --transport http mindmaps ${origin}/mcp`,
      "```",
      "",
      "There is no API key to paste. The first tool call comes back 401 with a",
      "challenge, your harness opens a browser, you approve, and it gets a token",
      "scoped to this account — the same sign-in you just used.",
      "",
      "- [ ] Run the command above",
      "- [ ] Ask your harness to `recall` something — it starts with this board",
      "- [ ] Ask it to write a mindmap of whatever you are working on",
      "",
      "Settings, at the bottom of the rail, lists every harness holding a token",
      "and can disconnect any of them.",
    ].join("\n"),
  },
  {
    key: "cards",
    type: "card",
    title: "A card is a line of text until you open it",
    x: 420,
    y: 60,
    md: [
      "You are reading a card's document right now. On the board it was one",
      "line; opening it is what materialised this. That is the whole cost model —",
      "putting something here has to be cheaper than opening a doc, or the board",
      "stops being worth opening.",
      "",
      "A card can also hold a checklist, like the one on the card to the left.",
      "Work breakdown lives in the document, not as a pile of sub-cards.",
      "",
      "Double-click empty canvas to make another one.",
    ].join("\n"),
  },
  {
    key: "links",
    type: "card",
    title: "Links carry a verb",
    x: 420,
    y: 320,
    md: [
      "Drag out of any handle on a card's edge to link it to another. The label",
      "is the point: `blocks` and `supersedes` mean something `related to` does",
      "not, and they are not symmetric — which way the arrow runs is part of the",
      "claim.",
      "",
      "Release the drag on empty canvas instead and you get a picker: an existing",
      "card from any mindmap, or a new one created right there. That is how a",
      "link spans two boards.",
      "",
      "Hover a link to flip which sides it attaches to, or remove it.",
    ].join("\n"),
  },
  {
    key: "delete-me",
    type: "note",
    title:
      "Delete this mindmap once you're set up — nothing on it refreshes itself, " +
      "and a board you have to maintain is a board you stop opening.",
    x: 60,
    y: 320,
    md: "",
  },
];

/** source key, target key, label, and which sides the link attaches to. */
const links: Array<[string, string, string, string, string]> = [
  ["connect", "cards", "then", "right", "left"],
  ["cards", "links", "explains", "bottom", "top"],
];

/**
 * Create the starter board for a brand-new account.
 *
 * Never throws: a failure here must not fail the registration that triggered
 * it. Worst case the user lands on the "No mindmaps yet" empty state, which is
 * exactly where they were before this existed.
 */
export async function createStarterBoard(
  db: D1Database,
  userId: string,
  origin: string,
): Promise<void> {
  try {
    const boardId = id();
    const t = now();
    const ids = new Map<string, string>();
    const rows = cards(origin);
    for (const c of rows) ids.set(c.key, id());

    const statements = [
      db
        .prepare(
          `INSERT INTO boards (id,name,status,parent_id,node_id,created_at,updated_at,user_id,position,idem_key)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(boardId, "Start here", "active", null, null, t, t, userId, 0, BOARD_KEY),

      ...rows.map((c) => {
        const blocks: Block[] = markdownToBlocks(c.md);
        // `body` is the markdown projection search and get_context read from;
        // `doc` is what the editor renders. Both, always — see MCP.md §4-5.
        const doc = JSON.stringify(blocks);
        const body = blocksToMarkdown(blocks);
        return db
          .prepare(
            `INSERT INTO nodes (id,board_id,type,title,body,doc,x,y,w,h,data,created_at,updated_at,idem_key)
             VALUES (?,?,?,?,?,?,?,?,260,150,'{}',?,?,?)`,
          )
          .bind(ids.get(c.key)!, boardId, c.type, c.title, body, doc, c.x, c.y, t, t, c.key);
      }),

      ...links.map(([from, to, label, sourceHandle, targetHandle]) =>
        db
          .prepare(
            `INSERT INTO edges (id,source_id,target_id,label,created_at,source_handle,target_handle)
             VALUES (?,?,?,?,?,?,?)`,
          )
          .bind(id(), ids.get(from)!, ids.get(to)!, label, t, sourceHandle, targetHandle),
      ),
    ];

    await db.batch(statements);
  } catch (err) {
    console.error("starter board failed for", userId, err);
  }
}
