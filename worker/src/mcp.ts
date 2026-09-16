/**
 * The MCP server: mindmaps as durable memory for agent sessions.
 *
 * Transport is Streamable HTTP — one endpoint, `POST /mcp`, one JSON-RPC
 * message per request. Every tool here is a couple of D1 queries, so we always
 * answer with a single `application/json` object rather than opening an SSE
 * stream. The spec lets the server choose per request, and there is no progress
 * to report on a query that takes 3ms.
 *
 * Two protocol eras are supported, because the spec moved and shipped clients
 * haven't all followed:
 *
 *   2026-07-28            no handshake. `server/discover` returns identity and
 *                         capabilities; every request carries its own `_meta`.
 *   2025-03-26 … 2025-11-25
 *                         `initialize` handshake first, then `tools/list`.
 *
 * Supporting both is nearly free — they are just different method names over
 * the same dispatcher — and it means this installs in whatever the user
 * already has rather than whatever we wish they had.
 */

import { blocksToMarkdown, normaliseContent, parseDoc, progressOf } from "./markdown";
import {
  handlesFor, isDirection, layout, layoutBelow,
  type Direction, type LayoutEdge, type LayoutNode,
} from "./layout";
import { isSupersedeLabel, neighbourhood, neighbourhoods, supersededSet, type Neighbour } from "./graph";
import {
  indexCard, removeCards, rerankScores, semanticReady, similarChunks, type SemanticEnv,
} from "./semantic";
import type { TokenGrant } from "./oauth";

const SERVER_NAME = "mindmaps";
const SERVER_VERSION = "0.1.0";

/** Newest first — this is what an UnsupportedProtocolVersionError advertises. */
const SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** Clients older than 2025-06-18 never sent the header; assume the oldest. */
const ASSUMED_VERSION = "2025-03-26";

/** A mindmap payload is going into someone's context window — cap it. */
const MAX_CARDS_IN_CONTEXT = 60;
const MAX_DOC_CHARS = 4_000;
const MAX_SEARCH_HITS = 25;
/** Traversal defaults. Two hops is where a neighbourhood stops being one. */
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 4;
const MAX_NEIGHBOURS = 40;
/** How much prose to show for a neighbour — enough to recognise, not to read. */
const EXCERPT = 220;

const uuid = () => crypto.randomUUID();
const now = () => Date.now();

/** Labels are stored as a JSON array; a bad row must not fail a listing. */
const labelsOf = (v: unknown): string[] => {
  if (typeof v !== "string" || !v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

const enum Code {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  Internal = -32603,
  /** MCP-allocated: headers disagree with the body (spec §Server Validation) */
  HeaderMismatch = -32020,
}

type Id = string | number | null;

const rpcOk = (id: Id, result: unknown, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status,
    headers: mcpHeaders(),
  });

const rpcErr = (id: Id, code: number, message: string, status = 200, data?: unknown) =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }),
    { status, headers: mcpHeaders() },
  );

const mcpHeaders = () => ({
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "www-authenticate",
});

/**
 * A tool that failed is not a protocol error: the result carries `isError` so
 * the model sees the message and can correct itself, rather than the harness
 * treating it as a transport failure and hiding it.
 */
const toolText = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  isError,
});

// ---------------------------------------------------------------------------
// Tool schemas
//
// Every byte here is context tax on every session (MCP.md §6), so descriptions
// say what the tool is for and nothing else. No examples, no prose conventions.
// ---------------------------------------------------------------------------

const CONTENT_DESC =
  "Card prose as markdown: headings, bullet/numbered lists, checklists (- [ ] / - [x]), quotes, code fences, tables, links, images, bold/italic. Pass {blocks:[...]} instead only for something markdown cannot express.";

const NODE_SCHEMA = {
  type: "object",
  properties: {
    key: {
      type: "string",
      description:
        "Your own stable name for this node, used to wire up edges and to recognise it on a later run. Reuse the same key for the same thing and it is updated rather than duplicated; a throwaway key just wires edges within this call.",
    },
    type: { type: "string", enum: ["card", "note"], description: "card has a title and a document; note is a sticky" },
    title: { type: "string" },
    content: { type: "string", description: CONTENT_DESC },
  },
  required: ["key", "title"],
} as const;

const EDGE_SCHEMA = {
  type: "object",
  properties: {
    from: { type: "string", description: "source node key" },
    to: { type: "string", description: "target node key" },
    label: { type: "string", description: "how they relate, e.g. blocks, informs, supersedes" },
  },
  required: ["from", "to"],
} as const;

const DIRECTION_SCHEMA = {
  type: "string",
  enum: ["right", "down"],
  description:
    "Which way the graph flows: `right` for a left-to-right chain (default), `down` for top-to-bottom. Sets both the layout and which sides links attach to.",
} as const;

const OPEN_AT_SCHEMA = {
  type: "string",
  enum: ["top", "bottom"],
  description:
    "Where the card opens when a person clicks it. Use `bottom` for a running log or task list you keep appending to, so the newest entries are what they see.",
} as const;

const TOOLS = [
  {
    name: "recall",
    description: "Start here. Search everything you have recorded, follow the links out from what matches, and get back a ranked, bounded briefing. Use it at the start of a session, before creating anything, to find what you already know about a topic.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "what you are trying to remember" },
        mindmap_id: { type: "string", description: "restrict to one mindmap; omit to search everything" },
        depth: {
          type: "integer",
          description: "How far to follow links from each match. 0 for matches only, 1 (default) to include what they connect to.",
        },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_mindmaps",
    description: "List the user's mindmaps with card counts. Start here to find what already exists before creating anything.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_mindmap",
    description: "Read a whole mindmap as structured markdown: every card with its document, checklist progress, and the labelled links between cards. Card ids are included so you can write back to specific cards.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "mindmap id from list_mindmaps" },
        include_documents: {
          type: "boolean",
          description: "Include full card documents. Default true; set false for just the shape of the map.",
        },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_card",
    description: "Read one card's full document.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_context",
    description: "Walk outward from a card through its links and return the neighbourhood: what it connects to, what those connect to, and the relationship on every hop. Crosses mindmaps, so this is how you find that two topics share a cause.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "card id to start from" },
        depth: {
          type: "integer",
          description: "How many hops out. 1 is immediate neighbours, 2 the default, 4 the maximum.",
        },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search",
    description: "Search titles and card documents across all mindmaps. Returns ids and matching snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mindmap_id: { type: "string", description: "restrict to one mindmap" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_mindmap",
    description: "Create a mindmap from a graph you describe. Supply nodes and the labelled edges between them; positions are computed here, so do not invent coordinates. Pass a `key` if you might record this topic again — a second call with the same key updates rather than duplicating.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: {
          type: "string",
          description:
            "What this mindmap is for, in a sentence. Worth writing now: it is what tells you later whether a new card belongs here.",
        },
        key: {
          type: "string",
          description:
            "A stable name for this mindmap, e.g. `pci-2026-notes`. Pass one whenever you might record the same thing again: calling this a second time with the same key updates that mindmap instead of creating a near-duplicate.",
        },
        nodes: { type: "array", items: NODE_SCHEMA },
        edges: { type: "array", items: EDGE_SCHEMA },
        direction: DIRECTION_SCHEMA,
      },
      required: ["name", "nodes"],
    },
  },
  {
    name: "add_to_mindmap",
    description: "Add nodes and edges to an existing mindmap. New nodes are laid out below what is already there, so nothing the user arranged by hand moves.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        nodes: { type: "array", items: NODE_SCHEMA },
        edges: {
          type: "array",
          items: EDGE_SCHEMA,
          description: "`from`/`to` may be a new node's key or an existing card id",
        },
        direction: DIRECTION_SCHEMA,
      },
      required: ["id", "nodes"],
    },
  },
  {
    name: "update_mindmap",
    description:
      "Set a mindmap's description, labels or name. The description is what later tells you — or another harness — what belongs on this map, so write it when you create a topic and correct it when the topic drifts. One sentence about what lives here beats a list of what is on it today.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: {
          type: "string",
          description:
            "What this mindmap is for, in a sentence. Aimed at deciding whether a new card belongs here.",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Short tags. Replaces the existing set; omit to leave them alone.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "relayout_mindmap",
    description: "Re-arrange a whole mindmap in a given direction, moving every card and re-attaching every link to the matching sides. Use this to turn a left-to-right map into a top-to-bottom one, or vice versa.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        direction: DIRECTION_SCHEMA,
      },
      required: ["id", "direction"],
    },
  },
  {
    name: "link_cards",
    description: "Link two existing cards, on the same mindmap or on different ones. Cross-mindmap links are how separate topics connect — use them when something you are recording relates to a card elsewhere.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "source card id" },
        to: { type: "string", description: "target card id" },
        label: { type: "string", description: "how they relate, e.g. blocks, informs" },
        direction: DIRECTION_SCHEMA,
      },
      required: ["from", "to"],
    },
  },
  {
    name: "update_link",
    description: "Change a link's label or which sides it attaches to. Link ids come from get_mindmap.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "link id from get_mindmap" },
        label: { type: "string" },
        direction: DIRECTION_SCHEMA,
      },
      required: ["id"],
    },
  },
  {
    name: "unlink_cards",
    description: "Remove a link. Pass its id, or the two card ids it joins.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "link id from get_mindmap" },
        from: { type: "string", description: "source card id, if you don't have the link id" },
        to: { type: "string", description: "target card id" },
      },
    },
  },
  {
    name: "add_card",
    description:
      "Add a single card to a mindmap you already have. Use the mindmap a recall match came from, or one from list_mindmaps. Reach for create_mindmap only when the subject genuinely has no home yet.",
    inputSchema: {
      type: "object",
      properties: {
        mindmap_id: { type: "string" },
        title: { type: "string" },
        content: { type: "string", description: CONTENT_DESC },
        key: {
          type: "string",
          description: "Stable name for this card. Re-adding with the same key updates it instead of creating a second copy.",
        },
        open_at: OPEN_AT_SCHEMA,
      },
      required: ["mindmap_id", "title"],
    },
  },
  {
    name: "update_card",
    description: "Replace a card's title and/or document. Use append_to_card to add without discarding what is there.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string", description: CONTENT_DESC },
        open_at: OPEN_AT_SCHEMA,
      },
      required: ["id"],
    },
  },
  {
    name: "append_to_card",
    description: "Append to the end of a card's document, keeping the existing content. The usual way to record new findings against something that already exists.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        content: { type: "string", description: CONTENT_DESC },
      },
      required: ["id", "content"],
    },
  },
] as const;

const WRITE_TOOLS = new Set([
  "create_mindmap",
  "update_mindmap",
  "add_to_mindmap",
  "relayout_mindmap",
  "add_card",
  "update_card",
  "append_to_card",
  "link_cards",
  "update_link",
  "unlink_cards",
]);

export const toolNames = TOOLS.map((t) => t.name);
export const requiredScopeFor = (tool: string) =>
  WRITE_TOOLS.has(tool) ? "mindmaps:write" : "mindmaps:read";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface McpEnv extends SemanticEnv {
  DB: D1Database;
}

/**
 * Handle one JSON-RPC message.
 *
 * `grant` is already validated by the caller — this function assumes an
 * authenticated user and never sees a token.
 */
export async function handleMcp(
  req: Request,
  env: McpEnv,
  grant: TokenGrant,
): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return rpcErr(null, Code.ParseError, "invalid JSON", 400);
  }

  // Batching was removed from the spec; a single message per POST.
  if (Array.isArray(body))
    return rpcErr(null, Code.InvalidRequest, "batched requests are not supported", 400);
  if (!body || typeof body.method !== "string")
    return rpcErr(body?.id ?? null, Code.InvalidRequest, "not a JSON-RPC message", 400);

  const id: Id = body.id ?? null;
  const method: string = body.method;
  const params = body.params ?? {};

  // --- protocol version ----------------------------------------------------
  const headerVersion = req.headers.get("mcp-protocol-version");
  const bodyVersion = params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  const version = headerVersion ?? bodyVersion ?? ASSUMED_VERSION;

  // Spec: header and body must agree. This one we enforce strictly — the whole
  // point is that an intermediary routing on the header and a server executing
  // on the body can't be made to disagree.
  if (headerVersion && bodyVersion && headerVersion !== bodyVersion)
    return rpcErr(
      id,
      Code.HeaderMismatch,
      `MCP-Protocol-Version header '${headerVersion}' does not match body '${bodyVersion}'`,
      400,
    );

  if (!SUPPORTED.includes(version as any))
    return rpcErr(id, Code.InvalidRequest, `unsupported protocol version: ${version}`, 400, {
      supported: [...SUPPORTED],
    });

  // `Mcp-Method` / `Mcp-Name` mirror body fields. We validate a mismatch but
  // tolerate absence: rejecting requests that merely omit the header would
  // lock out every client that predates it, for no security gain — a missing
  // header can't disagree with anything.
  const hMethod = req.headers.get("mcp-method");
  if (hMethod && hMethod !== method)
    return rpcErr(id, Code.HeaderMismatch, `Mcp-Method '${hMethod}' does not match body '${method}'`, 400);

  const hName = decodeHeaderValue(req.headers.get("mcp-name"));
  const bodyName = params?.name ?? params?.uri;
  if (hName && bodyName && hName !== bodyName)
    return rpcErr(id, Code.HeaderMismatch, `Mcp-Name '${hName}' does not match body '${bodyName}'`, 400);

  // --- notifications -------------------------------------------------------
  // No id means a notification: acknowledge with 202 and no body.
  if (body.id === undefined || body.id === null) {
    if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
    // A request with no id that isn't a notification is malformed, but the
    // handshake-era `notifications/initialized` is the only one clients send.
    return new Response(null, { status: 202 });
  }

  try {
    switch (method) {
      // --- current era ----------------------------------------------------
      case "server/discover":
        return rpcOk(id, {
          protocolVersions: [...SUPPORTED],
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
        });

      // --- handshake era --------------------------------------------------
      case "initialize": {
        // Echo back a version the client asked for if we have it, else our
        // newest. The client is expected to abort if it can't speak ours.
        const asked = params?.protocolVersion;
        const agreed = SUPPORTED.includes(asked) ? asked : SUPPORTED[0];
        return rpcOk(id, {
          protocolVersion: agreed,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: { listChanged: false } },
          instructions: INSTRUCTIONS,
        });
      }

      case "ping":
        return rpcOk(id, {});

      case "tools/list":
        return rpcOk(id, { tools: TOOLS });

      case "tools/call":
        return await callTool(id, env, grant, params);

      // Declared unsupported rather than silently absent, so a client that
      // probes gets a clear answer.
      case "resources/list":
        return rpcOk(id, { resources: [] });
      case "prompts/list":
        return rpcOk(id, { prompts: [] });

      default:
        // Spec: unknown method is 404 *with* a JSON-RPC error body, which is
        // what distinguishes us from a legacy server that has no MCP endpoint.
        return rpcErr(id, Code.MethodNotFound, `unknown method: ${method}`, 404);
    }
  } catch (err: any) {
    console.error("mcp", method, err);
    return rpcErr(id, Code.Internal, String(err?.message ?? err));
  }
}

const INSTRUCTIONS = `Mindmaps are spatial maps of cards; each card holds a markdown document. Use them as memory that outlives this session.

**Pass a stable \`key\` on anything you might write again.** Re-running a summary without keys leaves a second near-identical mindmap behind, and the memory gets worse each time; with keys the same run converges on what is already there.

**Call recall first.** It searches everything and follows the links out from what it finds, so it answers "what do I already know about this" in one call.

**Then put what you write where it belongs.** Every recall match names the mindmap it came from, so extend that one with add_to_mindmap or add_card. If nothing matched, check list_mindmaps for an existing home before you create anything — each map's description says what belongs on it, which is what makes that choice answerable rather than a guess. Give every mindmap you create a description, and fix one that has gone stale with update_mindmap. Reserve create_mindmap for a genuinely new subject, not for every new fact: a mindmap is a topic someone returns to over weeks, a card is one thing learned. When it could go either way, add a card to a mindmap that already exists. A brain full of one-card mindmaps is as useless as a brain with one enormous one.

Links carry the reasoning — blocks, informs, supersedes — and they may join cards on *different* mindmaps. Use link_cards when something you are recording relates to a card elsewhere; that cross-topic connection is what makes this a brain rather than a filing cabinet.

Write prose as markdown; positions are computed for you.`;

/**
 * Push every heading in a card's document `by` levels deeper, so it nests under
 * the card heading that introduces it rather than competing with it. Clamped at
 * six, which is as deep as markdown goes.
 */
const demoteHeadings = (md: string, by: number) =>
  md.replace(/^(#{1,6})(\s)/gm, (_, hashes: string, space: string) =>
    "#".repeat(Math.min(hashes.length + by, 6)) + space,
  );

/** Undo the `=?base64?…?=` sentinel the spec defines for unsafe header values. */
function decodeHeaderValue(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^=\?base64\?(.*)\?=$/.exec(raw);
  if (!m) return raw;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function callTool(id: Id, env: McpEnv, grant: TokenGrant, params: any): Promise<Response> {
  const name: string = params?.name;
  const args = params?.arguments ?? {};
  if (!name) return rpcErr(id, Code.InvalidParams, "params.name is required");
  if (!toolNames.includes(name as any))
    return rpcErr(id, Code.InvalidParams, `unknown tool: ${name}`);

  // Scope is enforced at the HTTP layer for the whole request, but check again
  // per tool: a read-scoped token must not reach a write tool even if the
  // outer check ever loosens.
  const needed = requiredScopeFor(name);
  if (!grant.scopes.includes(needed))
    return rpcOk(id, toolText(`This connection lacks the ${needed} scope.`, true));

  const u = grant.userId;
  switch (name) {
    case "recall":
      return rpcOk(id, await recall(env, u, args));
    case "list_mindmaps":
      return rpcOk(id, await listMindmaps(env, u));
    case "get_mindmap":
      return rpcOk(id, await getMindmap(env, u, args));
    case "get_card":
      return rpcOk(id, await getCard(env, u, args));
    case "search":
      return rpcOk(id, await search(env, u, args));
    case "get_context":
      return rpcOk(id, await getContext(env, u, args));
    case "update_mindmap":
      return rpcOk(id, await updateMindmap(env, u, args));
    case "create_mindmap":
      return rpcOk(id, await createMindmap(env, u, args, grant.clientId));
    case "add_to_mindmap":
      return rpcOk(id, await addToMindmap(env, u, args, grant.clientId));
    case "add_card":
      return rpcOk(id, await addCard(env, u, args, grant.clientId));
    case "update_card":
      return rpcOk(id, await updateCard(env, u, args));
    case "append_to_card":
      return rpcOk(id, await appendToCard(env, u, args));
    case "relayout_mindmap":
      return rpcOk(id, await relayoutMindmap(env, u, args));
    case "link_cards":
      return rpcOk(id, await linkCards(env, u, args));
    case "update_link":
      return rpcOk(id, await updateLink(env, u, args));
    case "unlink_cards":
      return rpcOk(id, await unlinkCards(env, u, args));
    default:
      return rpcErr(id, Code.InvalidParams, `unhandled tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Ownership
//
// Every query filters on user_id. A missing row and someone else's row are the
// same answer — "no such mindmap" — so ids stay unenumerable, matching how the
// REST API already behaves.
// ---------------------------------------------------------------------------

async function ownedBoard(env: McpEnv, userId: string, boardId: string) {
  return await env.DB.prepare(
    `SELECT * FROM boards WHERE id = ? AND user_id = ? AND parent_id IS NULL`,
  )
    .bind(boardId, userId)
    .first<any>();
}

async function ownedNode(env: McpEnv, userId: string, nodeId: string) {
  return await env.DB.prepare(
    `SELECT n.*, b.id AS board_id_check, b.name AS board_name
       FROM nodes n JOIN boards b ON b.id = n.board_id
      WHERE n.id = ? AND b.user_id = ?`,
  )
    .bind(nodeId, userId)
    .first<any>();
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

async function listMindmaps(env: McpEnv, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.name, b.status, b.updated_at, b.description, b.labels, b.pinned,
            (SELECT COUNT(*) FROM nodes n WHERE n.board_id = b.id AND n.type = 'card') AS cards,
            (SELECT COUNT(*) FROM nodes n WHERE n.board_id = b.id AND n.type = 'note') AS notes
       FROM boards b
      WHERE b.user_id = ? AND b.parent_id IS NULL
      ORDER BY b.pinned DESC, b.updated_at DESC`,
  )
    .bind(userId)
    .all<any>();

  const rows = results ?? [];
  if (!rows.length)
    return toolText("No mindmaps yet. create_mindmap makes the first one.");

  // The description is the whole reason this listing is worth reading before
  // writing: a name and two counts cannot tell you where a card belongs, and
  // "put it somewhere sensible" is only actionable if something says what each
  // map is for.
  const lines = rows.map((b) => {
    const labels = labelsOf(b.labels);
    return (
      `- **${b.name}**${b.pinned ? " ★" : ""} — ${b.cards} card${b.cards === 1 ? "" : "s"}` +
      (b.notes ? `, ${b.notes} note${b.notes === 1 ? "" : "s"}` : "") +
      `, updated ${new Date(b.updated_at).toISOString().slice(0, 10)}` +
      (labels.length ? `\n  labels: ${labels.join(", ")}` : "") +
      (b.description ? `\n  ${b.description}` : "") +
      `\n  id: \`${b.id}\``
    );
  });
  const undescribed = rows.filter((b: any) => !b.description).length;
  return toolText(
    `${rows.length} mindmap${rows.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}` +
      (undescribed
        ? `\n\n_${undescribed} of these have no description. update_mindmap can add one, which is what makes the next choice of where to put something easy._`
        : ""),
  );
}

async function updateMindmap(env: McpEnv, userId: string, args: any) {
  const boardId = String(args?.id ?? "");
  const board = await ownedBoard(env, userId, boardId);
  if (!board) return toolText(`No mindmap with id ${boardId}.`, true);

  const sets: string[] = [];
  const vals: unknown[] = [];
  const said: string[] = [];

  if (typeof args?.name === "string" && args.name.trim()) {
    sets.push("name = ?");
    vals.push(args.name.trim());
    said.push(`renamed to "${args.name.trim()}"`);
  }
  if (typeof args?.description === "string") {
    const d = args.description.trim();
    sets.push("description = ?");
    vals.push(d || null);
    said.push(d ? "description set" : "description cleared");
  }
  if (args?.labels !== undefined) {
    const list = Array.isArray(args.labels) ? args.labels : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
      const v = String(raw ?? "").trim().slice(0, 32);
      if (!v) continue;
      const k = v.toLowerCase();
      // Case-insensitive dedupe: "Auth" and "auth" look identical in the rail
      // and would filter as two different things.
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
      if (out.length >= 12) break;
    }
    sets.push("labels = ?");
    vals.push(out.length ? JSON.stringify(out) : null);
    said.push(out.length ? `labels: ${out.join(", ")}` : "labels cleared");
  }

  if (!sets.length) return toolText("Nothing to change. Pass name, description or labels.", true);

  sets.push("updated_at = ?");
  vals.push(now(), boardId);
  await env.DB.prepare(`UPDATE boards SET ${sets.join(",")} WHERE id = ?`)
    .bind(...vals)
    .run();

  return toolText(`Updated **${board.name}** — ${said.join("; ")}.`);
}

/**
 * The payload that matters most: this is what lands in an agent's context
 * window, so it is markdown with ids attached and a hard cap on size.
 */
async function getMindmap(env: McpEnv, userId: string, args: any) {
  const board = await ownedBoard(env, userId, String(args?.id ?? ""));
  if (!board) return toolText(`No mindmap with id ${args?.id}.`, true);

  const withDocs = args?.include_documents !== false;
  const [nodesRes, edgesRes] = await Promise.all([
    env.DB.prepare(
      `SELECT id,type,title,doc,body,x,y,idem_key FROM nodes WHERE board_id = ? ORDER BY x, y`,
    )
      .bind(board.id)
      .all<any>(),
    // Either endpoint here, so links reaching onto another mindmap are visible
    // rather than silently dropped.
    env.DB.prepare(
      `SELECT e.id, e.source_id, e.target_id, e.label, e.source_handle,
              sn.board_id AS source_board, tn.board_id AS target_board,
              sn.title AS source_title, tn.title AS target_title,
              sb.name AS source_board_name, tb.name AS target_board_name
         FROM edges e
         JOIN nodes  sn ON sn.id = e.source_id
         JOIN nodes  tn ON tn.id = e.target_id
         JOIN boards sb ON sb.id = sn.board_id
         JOIN boards tb ON tb.id = tn.board_id
        WHERE sn.board_id = ? OR tn.board_id = ?`,
    )
      .bind(board.id, board.id)
      .all<any>(),
  ]);

  const all = nodesRes.results ?? [];
  // Ink strokes and images carry no text; they'd be noise in a context window.
  const nodes = all.filter((n) => n.type === "card" || n.type === "note");
  const shown = nodes.slice(0, MAX_CARDS_IN_CONTEXT);
  const titleOf = new Map(all.map((n) => [n.id, n.title || "(untitled)"]));

  const out: string[] = [`# ${board.name}`, ""];

  for (const n of shown) {
    if (n.type === "note") {
      out.push(`### Note`, `> ${(n.title || n.body || "").replace(/\n/g, "\n> ")}`, `id: \`${n.id}\``, "");
      continue;
    }
    const blocks = parseDoc(n.doc);
    const { done, total } = progressOf(blocks);
    out.push(`## ${n.title || "(untitled)"}`);
    out.push(
      `id: \`${n.id}\`` +
        // the key is how a later session updates this card without holding its id
        (n.idem_key ? ` · key: \`${n.idem_key}\`` : "") +
        (total ? ` · checklist ${done}/${total}` : ""),
    );
    if (withDocs) {
      const raw = blocks.length ? blocksToMarkdown(blocks) : String(n.body ?? "");
      // Cards are `##` here, so a document's own `##` would be indistinguishable
      // from the start of the next card. Demote the document's headings so the
      // card boundaries stay readable.
      const md = demoteHeadings(raw, 2);
      if (md.trim()) {
        out.push("");
        out.push(md.length > MAX_DOC_CHARS ? `${md.slice(0, MAX_DOC_CHARS)}\n\n…truncated; get_card for the rest.` : md);
      }
    }
    out.push("");
  }

  if (nodes.length > shown.length)
    out.push(`_${nodes.length - shown.length} further cards omitted; use search to find specific ones._`, "");

  const edges = edgesRes.results ?? [];
  const inside = edges.filter((e) => e.source_board === board.id && e.target_board === board.id);
  const leaving = edges.filter((e) => e.source_board !== board.id || e.target_board !== board.id);

  if (inside.length) {
    // Link ids and the current flow direction are both here so update_link and
    // unlink_cards have something to aim at.
    const vertical = inside.filter((e) => e.source_handle === "bottom").length > inside.length / 2;
    out.push("## Links", "", `_Flowing ${vertical ? "top-to-bottom" : "left-to-right"}._`, "");
    for (const e of inside)
      out.push(
        `- ${e.source_title || "(untitled)"} → ${e.target_title || "(untitled)"}` +
          (e.label ? ` — *${e.label}*` : "") +
          `\n  id: \`${e.id}\``,
      );
    out.push("");
  }

  // Listed apart, because these are the interesting ones: they say this mindmap
  // is not self-contained, and name what to read next.
  if (leaving.length) {
    out.push("## Links to other mindmaps", "");
    for (const e of leaving) {
      const outward = e.source_board === board.id;
      const near = outward ? e.source_title : e.target_title;
      const far = outward ? e.target_title : e.source_title;
      const farBoard = outward ? e.target_board_name : e.source_board_name;
      const farId = outward ? e.target_id : e.source_id;
      out.push(
        `- ${near || "(untitled)"} ${outward ? "→" : "←"} **${far || "(untitled)"}** in *${farBoard}*` +
          (e.label ? ` — *${e.label}*` : "") +
          `\n  card: \`${farId}\` · link: \`${e.id}\``,
      );
    }
    out.push("");
  }

  return toolText(out.join("\n").trim());
}

async function getCard(env: McpEnv, userId: string, args: any) {
  const node = await ownedNode(env, userId, String(args?.id ?? ""));
  if (!node) return toolText(`No card with id ${args?.id}.`, true);

  const blocks = parseDoc(node.doc);
  const md = blocks.length ? blocksToMarkdown(blocks) : String(node.body ?? "");
  const { done, total } = progressOf(blocks);
  const conns = await connectionsOf(env, userId, node.id);
  const links = connectionLines(conns, node.board_id);

  // Superseded by something? Say so at the top — reading a replaced belief as
  // if it were current is the failure mode a long-lived brain has to avoid.
  const replacedBy = conns.filter((c) => c.dir === "in" && isSupersedeLabel(c.label));

  let wrote = "";
  try {
    const meta = JSON.parse(node.data || "{}");
    if (meta.by) {
      const client = await env.DB.prepare(
        `SELECT client_name FROM oauth_clients WHERE client_id = ?`,
      )
        .bind(String(meta.by))
        .first<{ client_name: string }>();
      if (client?.client_name) wrote = ` · written by ${client.client_name}`;
    }
  } catch {
    /* a malformed blob is not worth failing a read over */
  }

  return toolText(
    [
      `# ${node.title || "(untitled)"}`,
      `In mindmap: ${node.board_name}`,
      `id: \`${node.id}\`` + (total ? ` · checklist ${done}/${total}` : "") + wrote,
      ...(replacedBy.length
        ? [
            "",
            `> ⊘ **Superseded** by ${replacedBy
              .map((r) => `**${r.other_title || "(untitled)"}** (\`${r.other_id}\`)`)
              .join(", ")}. Read that first.`,
          ]
        : []),
      "",
      md.trim() || "_This card has no document yet._",
      // The relationships are the reasoning. Reading one card used to lose them
      // entirely, which made the graph invisible unless you loaded a whole board.
      ...(links.length ? ["", "## Connected to", "", ...links] : []),
    ].join("\n"),
  );
}

/**
 * Build a safe FTS5 MATCH expression from whatever the caller typed.
 *
 * Raw user text cannot go into MATCH: `-`, `*`, `:`, `"` and the bare words
 * AND/OR/NOT are all operators, so a query like `rotation - who owns it?` is a
 * syntax error rather than a search. Quoting each token as a phrase disarms all
 * of that, and costs nothing — phrase-of-one is just the term.
 */
function ftsQuery(raw: string, mode: "all" | "any" = "all"): string {
  let tokens = (String(raw ?? "").match(/[\p{L}\p{N}_]+/gu) ?? [])
    .map((t) => t.toLowerCase())
    .slice(0, 24);

  // In `any` mode a stopword matches almost everything, so a question like
  // "who is accountable for the manual process" would come back ranked by
  // whichever card happened to contain "the" most often. That is noise wearing
  // relevance's clothes — worse than no result, because it looks like an
  // answer. FTS5 keeps stopwords (there is no stoplist in the porter
  // tokenizer), so they are dropped here instead.
  if (mode === "any") {
    const meaningful = tokens.filter((t) => t.length > 2 && !STOPWORDS.has(t));
    if (meaningful.length) tokens = meaningful;
  }

  if (!tokens.length) return "";
  return tokens.map((t) => `"${t}"`).join(mode === "all" ? " AND " : " OR ");
}

/**
 * Words too common to carry a signal. Short rather than exhaustive: the aim is
 * to stop the worst offenders dominating an OR query, not to build a linguistics
 * resource.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "have", "has", "had", "not",
  "but", "with", "that", "this", "these", "those", "from", "into", "onto",
  "who", "whom", "whose", "what", "when", "where", "which", "why", "how",
  "any", "all", "can", "will", "would", "should", "could", "does", "did",
  "you", "your", "our", "its", "their", "them", "there", "here", "about",
  "over", "under", "some", "more", "most", "much", "very", "just", "than",
  "then", "also", "been", "being", "such", "each", "other", "only", "own",
]);

/** A snippet around the match, or the opening of the card if none is offered. */
const excerptOf = (body: string, fallbackLen = EXCERPT) =>
  String(body ?? "").replace(/\s+/g, " ").trim().slice(0, fallbackLen);

export interface Hit {
  id: string;
  title: string;
  body: string;
  board_id: string;
  board_name: string;
  updated_at: number;
  score: number;
}

/**
 * Keyword search, ranked by relevance.
 *
 * bm25 gives a *negative* score where more negative is a better match, which is
 * why the ordering looks backwards; it is normalised to a positive scale here
 * so nothing downstream has to remember that.
 */
async function keywordHits(
  env: McpEnv,
  userId: string,
  query: string,
  boardId: string | null,
  limit: number,
  mode: "all" | "any" = "all",
): Promise<Hit[]> {
  const match = ftsQuery(query, mode);
  if (!match) return [];
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.title, n.body, n.board_id, n.updated_at,
            b.name AS board_name,
            -bm25(nodes_fts, 6.0, 1.0) AS score
       FROM nodes_fts f
       JOIN nodes  n ON n.rowid = f.rowid
       JOIN boards b ON b.id = n.board_id
      WHERE nodes_fts MATCH ?
        AND b.user_id = ?
        AND (? IS NULL OR n.board_id = ?)
        AND n.type IN ('card','note')
      ORDER BY score DESC
      LIMIT ?`,
  )
    .bind(match, userId, boardId, boardId, limit)
    .all<Hit>();
  return results ?? [];
}

async function search(env: McpEnv, userId: string, args: any) {
  const query = String(args?.query ?? "").trim();
  if (!query) return toolText("A query is required.", true);
  const scope = args?.mindmap_id ? String(args.mindmap_id) : null;

  // All terms first; if that finds nothing, widen to any of them rather than
  // reporting "no matches" for a query that was merely over-specific.
  let hits = await keywordHits(env, userId, query, scope, MAX_SEARCH_HITS, "all");
  let widened = false;
  if (!hits.length) {
    hits = await keywordHits(env, userId, query, scope, MAX_SEARCH_HITS, "any");
    widened = hits.length > 0;
  }
  if (!hits.length) return toolText(`Nothing matches "${query}".`);

  // Connections are part of a hit, not a separate lookup: a card is easier to
  // judge when you can see what it hangs off.
  const near = await neighbourhoods(env.DB, userId, hits.map((h) => h.id), 3);
  const stale = await supersededSet(env.DB, hits.map((h) => h.id));

  const lines = hits.map((h) => {
    const links = (near.get(h.id) ?? [])
      .map((n) => `${n.title || "(untitled)"}${n.via_label ? ` (${n.via_label})` : ""}`)
      .join(", ");
    return (
      `- **${h.title || "(untitled)"}** in *${h.board_name}*` +
      (stale.has(h.id) ? " ⊘ superseded" : "") +
      `\n  id: \`${h.id}\` · mindmap: \`${h.board_id}\`` +
      (excerptOf(h.body) ? `\n  ${excerptOf(h.body)}…` : "") +
      (links ? `\n  connects to: ${links}` : "")
    );
  });

  return toolText(
    `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}"` +
      (widened ? " (widened: no card contained every term)" : "") +
      `:\n\n${lines.join("\n")}`,
  );
}

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

interface IncomingNode {
  key?: string;
  type?: string;
  title?: string;
  content?: unknown;
}

/** Turn the agent's nodes+edges into rows, with positions computed here. */
function prepare(nodes: IncomingNode[], edges: any[], place: (n: LayoutNode[], e: LayoutEdge[]) => ReturnType<typeof layout>) {
  // A key is how edges refer to a node. Agents forget; fall back to the index
  // so a missing key degrades to "no edges for this node" rather than an error.
  const withKeys = nodes.map((n, i) => ({ ...n, key: String(n.key ?? `n${i}`) }));
  const laid = place(
    withKeys.map((n) => ({ key: n.key })),
    (edges ?? [])
      .filter((e) => e && e.from && e.to)
      .map((e) => ({ from: String(e.from), to: String(e.to) })),
  );
  const posOf = new Map(laid.map((p) => [p.key, p]));

  const rows = withKeys.map((n) => {
    const { doc, body } = normaliseContent(n.content);
    const pos = posOf.get(n.key) ?? { x: 80, y: 80 };
    const type = n.type === "note" ? "note" : "card";
    return {
      id: uuid(),
      key: n.key,
      type,
      title: String(n.title ?? "").slice(0, 500),
      // a note has no document; its text lives in the title, matching the UI
      doc: type === "card" ? doc : null,
      body: type === "card" ? body : String(n.title ?? ""),
      x: Math.round(pos.x),
      y: Math.round(pos.y),
    };
  });

  return { rows, keyToId: new Map(rows.map((r) => [r.key, r.id])) };
}

const insertNodeStmt = (
  env: McpEnv,
  boardId: string,
  r: any,
  data: string = "{}",
  idemKey: string | null = null,
) =>
  env.DB.prepare(
    `INSERT INTO nodes (id,board_id,type,title,body,doc,x,y,w,h,data,created_at,updated_at,idem_key)
     VALUES (?,?,?,?,?,?,?,?,260,150,?,?,?,?)`,
  ).bind(r.id, boardId, r.type, r.title, r.body, r.doc, r.x, r.y, data, now(), now(), idemKey);

/** What `prepare` produces: a row ready to insert, plus the agent's key for it. */
type PreparedRow = ReturnType<typeof prepare>["rows"][number];

/** Mark every mindmap a change touched — a link can now span two of them. */
async function touchBoards(env: McpEnv, boardIds: Array<string | null | undefined>) {
  const unique = [...new Set(boardIds.filter((b): b is string => !!b))];
  if (!unique.length) return;
  await env.DB.batch(
    unique.map((id) =>
      env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), id),
    ),
  );
}

/**
 * Per-card settings and provenance, in the node's `data` blob.
 *
 * `by` records which connected harness wrote the card. A human reading
 * agent-written prose weeks later wants to know where it came from, and it is
 * the cheapest possible version of Graphiti's episode lineage: not what
 * conversation produced it, but at least what did.
 */
const dataFor = (args: any, clientId?: string): string => {
  const data: Record<string, unknown> = {};
  if (args?.open_at === "bottom" || args?.open_at === "top") data.open_at = args.open_at;
  if (clientId) data.by = clientId;
  data.at = now();
  return JSON.stringify(data);
};

const insertEdgeStmt = (
  env: McpEnv,
  source: string,
  target: string,
  label: string,
  direction: Direction,
) => {
  const h = handlesFor(direction);
  return env.DB.prepare(
    `INSERT INTO edges (id,source_id,target_id,label,created_at,source_handle,target_handle)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(uuid(), source, target, label, now(), h.source, h.target);
};

/** `direction` from tool arguments, defaulting to the left-to-right chain. */
const directionOf = (args: any): Direction =>
  isDirection(args?.direction) ? args.direction : "right";

async function createMindmap(env: McpEnv, userId: string, args: any, clientId?: string) {
  const name = String(args?.name ?? "").trim();
  if (!name) return toolText("A name is required.", true);
  const nodes: IncomingNode[] = Array.isArray(args?.nodes) ? args.nodes : [];
  if (!nodes.length) return toolText("At least one node is required.", true);

  const mapKey = String(args?.key ?? "").trim();
  const direction = directionOf(args);

  // A key turns this into "make sure this mindmap says the following", which is
  // what makes an agent safe to run twice.
  const prior = mapKey
    ? await env.DB.prepare(
        `SELECT id, name FROM boards WHERE user_id = ? AND idem_key = ? AND parent_id IS NULL`,
      )
        .bind(userId, mapKey)
        .first<{ id: string; name: string }>()
    : null;

  if (prior) return await mergeIntoMindmap(env, userId, prior.id, name, args, clientId);

  const boardId = uuid();
  const { rows, keyToId } = prepare(nodes, args?.edges ?? [], (n, e) => layout(n, e, direction));

  const top = await env.DB.prepare(
    `SELECT COALESCE(MIN(position), 0) AS top FROM boards WHERE user_id = ? AND parent_id IS NULL`,
  )
    .bind(userId)
    .first<{ top: number }>();

  const stmts = [
    env.DB.prepare(
      `INSERT INTO boards (id,name,status,parent_id,node_id,created_at,updated_at,user_id,position,idem_key,description)
       VALUES (?,?,'active',NULL,NULL,?,?,?,?,?,?)`,
    ).bind(
      boardId,
      name,
      now(),
      now(),
      userId,
      (top?.top ?? 0) - 1,
      mapKey || null,
      typeof args?.description === "string" && args.description.trim()
        ? args.description.trim()
        : null,
    ),
    ...rows.map((r) =>
      insertNodeStmt(env, boardId, r, dataFor(null, clientId), mapKey ? r.key : null),
    ),
  ];

  let linked = 0;
  for (const e of args?.edges ?? []) {
    const from = keyToId.get(String(e?.from));
    const to = keyToId.get(String(e?.to));
    if (!from || !to || from === to) continue;
    stmts.push(insertEdgeStmt(env, from, to, String(e?.label ?? ""), direction));
    linked += 1;
  }

  await env.DB.batch(stmts);
  await reindexAll(env, userId, rows.map((r) => r.id));

  const dropped = (args?.edges ?? []).length - linked;
  return toolText(
    `Created **${name}** with ${rows.length} node${rows.length === 1 ? "" : "s"} and ${linked} link${linked === 1 ? "" : "s"}.\n` +
      (dropped > 0 ? `${dropped} edge${dropped === 1 ? "" : "s"} referenced unknown keys and were skipped.\n` : "") +
      (mapKey
        ? `Keyed \`${mapKey}\` — calling create_mindmap again with this key will update it rather than making a second.\n`
        : "") +
      `\nmindmap id: \`${boardId}\`\n\n` +
      rows.map((r) => `- ${r.title || "(untitled)"} — \`${r.id}\``).join("\n"),
  );
}

/**
 * A repeat run of a keyed `create_mindmap`: make the existing mindmap say this.
 *
 * Cards are matched on their key and updated in place; anything new is added.
 * Nothing is **deleted** — a second summary that happens to omit a card is not
 * evidence the user wants it gone, and silently dropping recorded thinking is
 * the one unrecoverable mistake a brain can make. Removal stays an explicit act.
 */
async function mergeIntoMindmap(
  env: McpEnv,
  userId: string,
  boardId: string,
  name: string,
  args: any,
  clientId?: string,
) {
  const nodes: IncomingNode[] = Array.isArray(args?.nodes) ? args.nodes : [];
  const direction = directionOf(args);

  const { results: onBoard } = await env.DB.prepare(
    `SELECT id, y, h FROM nodes WHERE board_id = ?`,
  )
    .bind(boardId)
    .all<any>();

  // New cards land below what is already there, so a re-run never rearranges a
  // board the user has since tidied.
  const { rows, keyToId } = prepare(nodes, args?.edges ?? [], (n, e) =>
    layoutBelow(n, e, onBoard ?? [], direction),
  );

  const existing = await existingByKey(env, boardId, rows.map((r) => r.key));
  const { stmts, ids, added, updated } = upsertNodeStmts(
    env, boardId, rows, true, existing, clientId,
  );

  // The key now resolves to whichever id already holds it, so edges written in
  // this call attach to the card that survived rather than a fresh duplicate.
  const resolved = new Map<string, string>();
  rows.forEach((r, i) => resolved.set(r.key, ids[i]));

  const present = new Set((onBoard ?? []).map((n) => n.id));
  const pairs: Array<[string, string]> = [];
  for (const e of args?.edges ?? []) {
    const from = resolved.get(String(e?.from)) ?? (present.has(String(e?.from)) ? String(e.from) : null);
    const to = resolved.get(String(e?.to)) ?? (present.has(String(e?.to)) ? String(e.to) : null);
    if (from && to && from !== to) pairs.push([from, to]);
  }
  const already = await existingEdges(env, pairs);

  let relinked = 0;
  let newLinks = 0;
  for (const [i, [from, to]] of pairs.entries()) {
    const label = String((args?.edges ?? [])[i]?.label ?? "");
    const seen = already.get(`${from}>${to}`) ?? already.get(`${to}>${from}`);
    if (seen) {
      stmts.push(env.DB.prepare(`UPDATE edges SET label = ? WHERE id = ?`).bind(label, seen));
      relinked += 1;
    } else {
      stmts.push(insertEdgeStmt(env, from, to, label, direction));
      newLinks += 1;
    }
  }

  stmts.push(
    env.DB.prepare(`UPDATE boards SET name = ?, updated_at = ? WHERE id = ?`)
      .bind(name, now(), boardId),
  );

  await env.DB.batch(stmts);
  await reindexAll(env, userId, ids);

  return toolText(
    `Updated **${name}** — it already existed under this key, so nothing was duplicated.\n\n` +
      `- ${updated} card${updated === 1 ? "" : "s"} updated in place\n` +
      `- ${added} added\n` +
      `- ${newLinks} new link${newLinks === 1 ? "" : "s"}, ${relinked} already present\n` +
      `\nCards on this mindmap that you did not mention were left alone.\n` +
      `\nmindmap id: \`${boardId}\`\n\n` +
      rows.map((r, i) => `- ${r.title || "(untitled)"} — \`${ids[i]}\``).join("\n"),
  );
}

async function addToMindmap(env: McpEnv, userId: string, args: any, clientId?: string) {
  const board = await ownedBoard(env, userId, String(args?.id ?? ""));
  if (!board) return toolText(`No mindmap with id ${args?.id}.`, true);
  const nodes: IncomingNode[] = Array.isArray(args?.nodes) ? args.nodes : [];
  if (!nodes.length) return toolText("At least one node is required.", true);

  const { results: existing } = await env.DB.prepare(
    `SELECT id, y, h FROM nodes WHERE board_id = ?`,
  )
    .bind(board.id)
    .all<any>();
  const present = new Set((existing ?? []).map((n) => n.id));

  const direction = directionOf(args);
  const { rows } = prepare(nodes, args?.edges ?? [], (n, e) =>
    layoutBelow(n, e, existing ?? [], direction),
  );

  // Keys are opt-in per call: pass them and a repeat run updates, omit them and
  // this behaves exactly as it always did.
  const keyed = nodes.some((n) => n.key && String(n.key).trim());
  const prior = keyed ? await existingByKey(env, board.id, rows.map((r) => r.key)) : new Map();
  const { stmts, ids, added, updated } = upsertNodeStmts(
    env, board.id, rows, keyed, prior, clientId,
  );
  const keyToId = new Map<string, string>();
  rows.forEach((r, i) => keyToId.set(r.key, ids[i]));

  // An edge endpoint may be a new node's key or an existing card's id, which
  // is what makes "attach these findings to that card" possible.
  let linked = 0;
  const unresolved: string[] = [];
  for (const e of args?.edges ?? []) {
    const resolve = (v: string) => keyToId.get(v) ?? (present.has(v) ? v : null);
    const from = resolve(String(e?.from));
    const to = resolve(String(e?.to));
    if (!from || !to || from === to) {
      unresolved.push(`${e?.from} → ${e?.to}`);
      continue;
    }
    stmts.push(insertEdgeStmt(env, from, to, String(e?.label ?? ""), direction));
    linked += 1;
  }

  stmts.push(env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), board.id));
  await env.DB.batch(stmts);
  await reindexAll(env, userId, ids);

  return toolText(
    (updated
      ? `Updated ${updated} card${updated === 1 ? "" : "s"} and added ${added} to **${board.name}**`
      : `Added ${added} node${added === 1 ? "" : "s"} to **${board.name}**`) +
      `, with ${linked} link${linked === 1 ? "" : "s"}.\n` +
      (unresolved.length ? `Skipped unresolvable edges: ${unresolved.join(", ")}.\n` : "") +
      `\n` +
      rows.map((r, i) => `- ${r.title || "(untitled)"} — \`${ids[i]}\``).join("\n"),
  );
}

async function addCard(env: McpEnv, userId: string, args: any, clientId?: string) {
  const board = await ownedBoard(env, userId, String(args?.mindmap_id ?? ""));
  if (!board) return toolText(`No mindmap with id ${args?.mindmap_id}.`, true);

  const { results: existing } = await env.DB.prepare(
    `SELECT id, y, h FROM nodes WHERE board_id = ?`,
  )
    .bind(board.id)
    .all<any>();

  const cardKey = String(args?.key ?? "").trim();
  const { rows } = prepare(
    [{ key: cardKey || "n0", type: "card", title: args?.title, content: args?.content }],
    [],
    (n, e) => layoutBelow(n, e, existing ?? []),
  );

  // A keyed card that is already here is restated, not duplicated. Position and
  // `data` are left alone: the user may have moved it, and the original author
  // is a fact about the past.
  const prior = cardKey ? await existingByKey(env, board.id, [cardKey]) : new Map();
  const seen = prior.get(cardKey);

  if (seen) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE nodes SET title = ?, body = ?, doc = ?, updated_at = ? WHERE id = ?`)
        .bind(rows[0].title, rows[0].body, rows[0].doc, now(), seen.id),
      env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), board.id),
    ]);
    await reindex(env, userId, seen.id);
    return toolText(
      `Updated **${rows[0].title || "(untitled)"}** on ${board.name} — a card with key \`${cardKey}\` was already there, so nothing was duplicated.\n\ncard id: \`${seen.id}\``,
    );
  }

  await env.DB.batch([
    insertNodeStmt(env, board.id, rows[0], dataFor(args, clientId), cardKey || null),
    env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), board.id),
  ]);
  await reindex(env, userId, rows[0].id);

  return toolText(`Added **${rows[0].title || "(untitled)"}** to ${board.name}.\n\ncard id: \`${rows[0].id}\``);
}

async function updateCard(env: McpEnv, userId: string, args: any) {
  const node = await ownedNode(env, userId, String(args?.id ?? ""));
  if (!node) return toolText(`No card with id ${args?.id}.`, true);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (args?.title !== undefined) {
    sets.push("title = ?");
    vals.push(String(args.title).slice(0, 500));
  }
  if (args?.content !== undefined) {
    const { doc, body } = normaliseContent(args.content);
    sets.push("doc = ?", "body = ?");
    vals.push(doc, body);
  }
  if (args?.open_at !== undefined) {
    if (args.open_at !== "top" && args.open_at !== "bottom")
      return toolText("open_at must be `top` or `bottom`.", true);
    // Merge rather than replace: `data` also carries things this tool knows
    // nothing about, and clobbering them would be a silent data loss.
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(node.data || "{}");
    } catch {
      /* a malformed blob is not worth failing the write over */
    }
    sets.push("data = ?");
    vals.push(JSON.stringify({ ...data, open_at: args.open_at }));
  }
  if (!sets.length)
    return toolText("Nothing to update — pass a title, content, or open_at.", true);

  sets.push("updated_at = ?");
  vals.push(now(), node.id);
  await env.DB.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  await env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), node.board_id).run();
  await reindex(env, userId, node.id);

  return toolText(`Updated **${args?.title ?? (node.title || "(untitled)")}**.`);
}

async function appendToCard(env: McpEnv, userId: string, args: any) {
  const node = await ownedNode(env, userId, String(args?.id ?? ""));
  if (!node) return toolText(`No card with id ${args?.id}.`, true);

  const existing = parseDoc(node.doc);
  const { doc: addedDoc } = normaliseContent(args?.content);
  const added = JSON.parse(addedDoc);

  // Concatenate blocks rather than markdown strings: appending markdown text
  // would re-parse the whole document every time and slowly reformat prose the
  // user wrote by hand.
  const merged = [...existing, ...added];
  const body = blocksToMarkdown(merged);

  await env.DB.prepare(`UPDATE nodes SET doc = ?, body = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(merged), body, now(), node.id)
    .run();
  await env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), node.board_id).run();
  await reindex(env, userId, node.id);

  const { done, total } = progressOf(merged);
  return toolText(
    `Appended to **${node.title || "(untitled)"}** — now ${merged.length} block${merged.length === 1 ? "" : "s"}` +
      (total ? `, checklist ${done}/${total}` : "") +
      ".",
  );
}

// ---------------------------------------------------------------------------
// Links
//
// These exist because an edge used to be permanent the moment it was drawn.
// An agent that laid a map out left-to-right left the user with no way to make
// it top-to-bottom, from the board or from a later session.
// ---------------------------------------------------------------------------

/** An edge, but only if the caller owns the board it sits on. */
/**
 * A link, if the caller owns both cards it joins. Edges no longer belong to a
 * board — checking both ends is what lets a link span two mindmaps while still
 * being unambiguously yours.
 */
async function ownedEdge(env: McpEnv, userId: string, edgeId: string) {
  return await env.DB.prepare(
    `SELECT e.*,
            sn.board_id AS source_board, tn.board_id AS target_board,
            sb.name AS source_board_name, tb.name AS target_board_name
       FROM edges e
       JOIN nodes  sn ON sn.id = e.source_id
       JOIN boards sb ON sb.id = sn.board_id
       JOIN nodes  tn ON tn.id = e.target_id
       JOIN boards tb ON tb.id = tn.board_id
      WHERE e.id = ? AND sb.user_id = ? AND tb.user_id = ?`,
  )
    .bind(edgeId, userId, userId)
    .first<any>();
}

/**
 * Everything a card is connected to, in both directions, with the mindmap each
 * neighbour lives on. This is what turns a card read into something an agent
 * can reason from: the labels are the reasoning, and until now they were only
 * visible by loading an entire board.
 */
async function connectionsOf(env: McpEnv, userId: string, nodeId: string) {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.label,
            CASE WHEN e.source_id = ?1 THEN 'out' ELSE 'in' END AS dir,
            other.id       AS other_id,
            other.title    AS other_title,
            ob.id          AS other_board,
            ob.name        AS other_board_name
       FROM edges e
       JOIN nodes  other ON other.id = CASE WHEN e.source_id = ?1 THEN e.target_id ELSE e.source_id END
       JOIN boards ob    ON ob.id = other.board_id
      WHERE (e.source_id = ?1 OR e.target_id = ?1) AND ob.user_id = ?2
      ORDER BY dir DESC, other.title`,
  )
    .bind(nodeId, userId)
    .all<any>();
  return results ?? [];
}

/** Render connections as markdown, marking the ones that leave this mindmap. */
function connectionLines(rows: any[], homeBoard: string | null): string[] {
  if (!rows.length) return [];
  return rows.map((r) => {
    const arrow = r.dir === "out" ? "→" : "←";
    const label = r.label ? ` — *${r.label}*` : "";
    const away = homeBoard && r.other_board !== homeBoard ? ` _(in ${r.other_board_name})_` : "";
    return `- ${arrow} **${r.other_title || "(untitled)"}**${label}${away}\n  id: \`${r.other_id}\` · link: \`${r.id}\``;
  });
}

/**
 * Re-arrange a whole mindmap along a different axis.
 *
 * Moves every card *and* re-attaches every link, because doing only one leaves
 * the map visually incoherent — arrows crossing back over the cards they came
 * from. This is the tool for "the agent built it sideways and I want it
 * top-to-bottom".
 */
async function relayoutMindmap(env: McpEnv, userId: string, args: any) {
  const board = await ownedBoard(env, userId, String(args?.id ?? ""));
  if (!board) return toolText(`No mindmap with id ${args?.id}.`, true);
  if (!isDirection(args?.direction))
    return toolText("direction must be `right` or `down`.", true);
  const direction: Direction = args.direction;

  const [nodesRes, edgesRes] = await Promise.all([
    env.DB.prepare(`SELECT id,type,w,h FROM nodes WHERE board_id = ?`).bind(board.id).all<any>(),
    // Only links with both ends here shape this board's layout; one reaching
    // off-canvas has no second position to arrange against.
    env.DB.prepare(
      `SELECT e.id, e.source_id, e.target_id
         FROM edges e
         JOIN nodes sn ON sn.id = e.source_id
         JOIN nodes tn ON tn.id = e.target_id
        WHERE sn.board_id = ? AND tn.board_id = ?`,
    )
      .bind(board.id, board.id)
      .all<any>(),
  ]);

  // Ink and images have no place in a graph layout — they are annotations over
  // the top of it, so leave them exactly where the user put them.
  const movable = (nodesRes.results ?? []).filter((n) => n.type === "card" || n.type === "note");
  if (!movable.length) return toolText("Nothing to arrange on this mindmap.", true);

  const edges = edgesRes.results ?? [];
  const placed = layout(
    movable.map((n) => ({ key: n.id, w: n.w ?? undefined, h: n.h ?? undefined })),
    edges.map((e) => ({ from: e.source_id, to: e.target_id })),
    direction,
  );

  const h = handlesFor(direction);
  const stmts = [
    ...placed.map((p) =>
      env.DB.prepare(`UPDATE nodes SET x = ?, y = ?, updated_at = ? WHERE id = ?`)
        .bind(Math.round(p.x), Math.round(p.y), now(), p.key),
    ),
    ...edges.map((e) =>
      env.DB.prepare(`UPDATE edges SET source_handle = ?, target_handle = ? WHERE id = ?`)
        .bind(h.source, h.target, e.id),
    ),
    env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), board.id),
  ];
  await env.DB.batch(stmts);

  return toolText(
    `Rearranged **${board.name}** to flow ${direction === "down" ? "top-to-bottom" : "left-to-right"}: ` +
      `${placed.length} card${placed.length === 1 ? "" : "s"} moved, ` +
      `${edges.length} link${edges.length === 1 ? "" : "s"} re-attached.`,
  );
}

async function linkCards(env: McpEnv, userId: string, args: any) {
  const from = await ownedNode(env, userId, String(args?.from ?? ""));
  const to = await ownedNode(env, userId, String(args?.to ?? ""));
  if (!from) return toolText(`No card with id ${args?.from}.`, true);
  if (!to) return toolText(`No card with id ${args?.to}.`, true);
  if (from.id === to.id) return toolText("A card cannot link to itself.", true);

  const existing = await env.DB.prepare(
    `SELECT id FROM edges WHERE source_id = ? AND target_id = ?`,
  )
    .bind(from.id, to.id)
    .first<any>();
  if (existing) return toolText(`Those cards are already linked (\`${existing.id}\`).`, true);

  const direction = directionOf(args);
  await env.DB.batch([insertEdgeStmt(env, from.id, to.id, String(args?.label ?? ""), direction)]);
  await touchBoards(env, [from.board_id, to.board_id]);

  const across = from.board_id !== to.board_id;
  return toolText(
    `Linked **${from.title || "(untitled)"}** → **${to.title || "(untitled)"}**` +
      (args?.label ? ` — *${args.label}*` : "") +
      (across ? ` across mindmaps (${from.board_name} → ${to.board_name})` : "") +
      ".",
  );
}

async function updateLink(env: McpEnv, userId: string, args: any) {
  const edge = await ownedEdge(env, userId, String(args?.id ?? ""));
  if (!edge) return toolText(`No link with id ${args?.id}.`, true);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (args?.label !== undefined) {
    sets.push("label = ?");
    vals.push(String(args.label));
  }
  if (args?.direction !== undefined) {
    if (!isDirection(args.direction)) return toolText("direction must be `right` or `down`.", true);
    const h = handlesFor(args.direction);
    sets.push("source_handle = ?", "target_handle = ?");
    vals.push(h.source, h.target);
  }
  if (!sets.length) return toolText("Nothing to change — pass a label, a direction, or both.", true);

  vals.push(edge.id);
  await env.DB.prepare(`UPDATE edges SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  await touchBoards(env, [edge.source_board, edge.target_board]);

  return toolText("Link updated.");
}

async function unlinkCards(env: McpEnv, userId: string, args: any) {
  // Accept either the link's own id or the pair it joins — an agent that just
  // read get_mindmap has the id, one working from card ids does not.
  let edge = args?.id ? await ownedEdge(env, userId, String(args.id)) : null;

  if (!edge && args?.from && args?.to) {
    const from = await ownedNode(env, userId, String(args.from));
    const to = await ownedNode(env, userId, String(args.to));
    if (from && to) {
      // either orientation: "unlink these two" shouldn't depend on argument order
      const row = await env.DB.prepare(
        `SELECT id FROM edges
          WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
      )
        .bind(from.id, to.id, to.id, from.id)
        .first<any>();
      if (row) edge = await ownedEdge(env, userId, row.id);
    }
  }

  if (!edge) return toolText("No such link. Pass its id, or the two card ids it joins.", true);

  await env.DB.prepare(`DELETE FROM edges WHERE id = ?`).bind(edge.id).run();
  await touchBoards(env, [edge.source_board, edge.target_board]);
  return toolText("Link removed.");
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/** One line per neighbour: what it is, how it connects, where it lives. */
function neighbourLine(n: Neighbour, homeBoard: string | null): string {
  const excerpt = String(n.body ?? "").replace(/\s+/g, " ").trim().slice(0, EXCERPT);
  const away = homeBoard && n.board_id !== homeBoard ? ` _(in ${n.board_name})_` : "";
  const stale = n.superseded ? " ⊘ superseded" : "";
  return (
    `- **${n.title || "(untitled)"}**${away}${stale}\n` +
    `  ${n.depth === 1 ? "via" : `${n.depth} hops, via`} *${n.via_label || "a link"}*` +
    ` · id: \`${n.id}\`` +
    (excerpt ? `\n  ${excerpt}${String(n.body ?? "").length > EXCERPT ? "…" : ""}` : "")
  );
}

async function getContext(env: McpEnv, userId: string, args: any) {
  const node = await ownedNode(env, userId, String(args?.id ?? ""));
  if (!node) return toolText(`No card with id ${args?.id}.`, true);

  const depth = Math.min(
    MAX_DEPTH,
    Math.max(1, Number.isFinite(args?.depth) ? Number(args.depth) : DEFAULT_DEPTH),
  );
  const found = await neighbourhood(env.DB, userId, node.id, depth, MAX_NEIGHBOURS);

  if (!found.length)
    return toolText(
      `**${node.title || "(untitled)"}** in *${node.board_name}* has no links yet.\n\n` +
        "Nothing to walk out to. link_cards connects it to something — including a card on another mindmap.",
    );

  const out: string[] = [
    `# Around: ${node.title || "(untitled)"}`,
    `Starting card: \`${node.id}\` in *${node.board_name}*`,
    "",
  ];

  // Grouped by distance, because "one hop" and "three hops" mean quite
  // different things about how much to trust the connection.
  for (let d = 1; d <= depth; d++) {
    const atDepth = found.filter((n) => n.depth === d);
    if (!atDepth.length) continue;
    out.push(d === 1 ? "## Directly connected" : `## ${d} hops away`, "");
    for (const n of atDepth) out.push(neighbourLine(n, node.board_id));
    out.push("");
  }

  const elsewhere = found.filter((n) => n.board_id !== node.board_id).length;
  if (elsewhere)
    out.push(`_${elsewhere} of these live on other mindmaps._`);

  return toolText(out.join("\n").trim());
}

// ---------------------------------------------------------------------------
// recall — the front door
// ---------------------------------------------------------------------------

/** How many matches to brief on, and how many links to show per match. */
const RECALL_HITS = 8;
const RECALL_LINKS = 4;
const RECALL_EXCERPT = 320;

/**
 * Reciprocal Rank Fusion constant.
 *
 * 60 is the value from the original paper and the near-universal default. It
 * sets how quickly a retriever's vote decays with rank: the difference between
 * positions 1 and 2 is worth much more than between 20 and 21, but never so
 * much that one retriever's top hit can outvote agreement among the others.
 */
const RRF_K = 60;

/**
 * Candidates handed to the cross-encoder.
 *
 * The reranker is the expensive stage — it reads the query against every
 * passage rather than comparing precomputed vectors — so it runs last, over a
 * shortlist. Wide enough that a card fusion ranked 20th can still win, small
 * enough to be one fast call.
 */
const RERANK_CANDIDATES = 24;

/**
 * Fuse ranked lists by position rather than score.
 *
 * The scores these retrievers produce are not comparable: bm25 is unbounded and
 * depends on corpus statistics, cosine sits in 0..1. The previous fusion added
 * them with hand-tuned multipliers (semantic x8, strict wording +4, and so on)
 * chosen to make the units roughly match — constants that were never measured,
 * could not be measured without an eval set, and would drift the moment either
 * retriever changed. Swapping the embedding model alone would have invalidated
 * them.
 *
 * RRF sidesteps the problem: only the ordering within each list is used, so
 * units cancel. A card ranked well by several retrievers beats one ranked
 * brilliantly by a single retriever, which is the behaviour worth having when
 * each of them is individually unreliable.
 */
function rrf(lists: Array<{ ids: string[]; weight: number }>): Map<string, number> {
  const scores = new Map<string, number>();
  for (const { ids, weight } of lists) {
    ids.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + rank + 1));
    });
  }
  return scores;
}

/**
 * Answer "what do I already know about this" in one call.
 *
 * Deliberately one tool rather than four primitives. Every tool schema is
 * context tax on every session (MCP.md §6), and assembling search → expand →
 * rank in the model is work it will do inconsistently. This does it once, the
 * same way each time, and returns something bounded.
 *
 * Ranking blends three signals, in this order of weight:
 *   relevance   how well the text matches, from bm25
 *   connection  a card the graph reaches from another match is more likely to
 *               be the thing you meant — adjacency is evidence
 *   recency     a gentle tiebreak, not a sort key; the brain is not a feed
 *
 * Superseded cards are not hidden — the reasoning that led to them is often
 * the point — but they sink, and they are marked.
 */
/** One ranked match, with everything either presentation needs. */
export interface RecallHit {
  id: string;
  title: string;
  board_id: string;
  board_name: string;
  /** The passage that matched, or the head of the document if none did. */
  passage: string;
  truncated: boolean;
  /** "wording", "meaning", "connected to another match" */
  why: string[];
  superseded: boolean;
  links: Array<{ id: string; title: string; label: string; board_id: string; board_name: string }>;
}

export interface RecallResult {
  hits: RecallHit[];
  /** How many candidates the retrievers found, before truncation. */
  found: number;
  degraded?: string;
}

/**
 * The whole retrieval pipeline, as data.
 *
 * Deliberately separate from any formatting. The MCP tool renders this as
 * markdown for an agent and the web palette renders it as a list for a person,
 * and both have to be the same answer or the claim that they share one surface
 * stops being true. Two rankings would drift within a week.
 */
export async function rankRecall(
  env: McpEnv,
  userId: string,
  query: string,
  scope: string | null,
  depth: number,
): Promise<RecallResult> {
  // Cast wide, then rank: `any` mode so a long question still finds things,
  // with `all` a separate list because matching every term is its own evidence.
  const [strict, loose, semanticResult] = await Promise.all([
    keywordHits(env, userId, query, scope, RECALL_HITS * 3, "all"),
    keywordHits(env, userId, query, scope, RECALL_HITS * 4, "any"),
    semanticHits(env, userId, query, scope, RECALL_HITS * 3),
  ]);
  const { hits: semantic, passages, degraded } = semanticResult;

  const card = new Map<string, Hit>();
  const why = new Map<string, Set<string>>();
  const note = (h: Hit, reason: string) => {
    if (!card.has(h.id)) card.set(h.id, h);
    (why.get(h.id) ?? why.set(h.id, new Set()).get(h.id)!).add(reason);
  };
  for (const h of loose) note(h, "wording");
  for (const h of strict) note(h, "wording");
  for (const h of semantic) note(h, "meaning");

  if (!card.size) return { hits: [], found: 0, degraded };

  const ids = [...card.keys()];
  const near = depth > 0 ? await neighbourhoods(env.DB, userId, ids, RECALL_LINKS) : new Map();
  const stale = await supersededSet(env.DB, ids);

  // Adjacency as evidence: being connected to another match is a vote. It joins
  // the fusion as its own ranked list rather than a bonus added afterwards, so
  // it is weighed on the same terms as everything else instead of via a
  // constant that has to be balanced against the others by hand.
  const connections = new Map<string, number>();
  for (const [id, neighbours] of near) {
    for (const n of neighbours as Neighbour[]) {
      if (card.has(n.id) && n.id !== id) {
        connections.set(n.id, (connections.get(n.id) ?? 0) + 1);
        why.get(n.id)!.add("connected to another match");
      }
    }
  }

  const now_ = now();
  const fused = rrf([
    // Matching every term is stronger evidence than matching any, so the strict
    // list votes harder — but as a weight on a rank, not a bonus on a score.
    { ids: strict.map((h) => h.id), weight: 1.0 },
    { ids: loose.map((h) => h.id), weight: 0.5 },
    { ids: semantic.map((h) => h.id), weight: 1.0 },
    {
      ids: [...connections.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
      weight: 0.5,
    },
    // Recency as a list too: a gentle tiebreak, not a sort key — the brain is
    // not a feed. Only cards touched in the last ~three months vote at all.
    {
      ids: ids
        .filter((id) => now_ - (card.get(id)!.updated_at || 0) < 90 * 86_400_000)
        .sort((a, b) => (card.get(b)!.updated_at || 0) - (card.get(a)!.updated_at || 0)),
      weight: 0.25,
    },
  ]);

  // Superseded cards are not hidden — the reasoning that led to them is often
  // the point — but they sink. A multiplier rather than a subtraction, because
  // RRF scores live in a small range where any fixed penalty is either a no-op
  // or annihilating depending on how many retrievers agreed.
  for (const id of stale) fused.set(id, (fused.get(id) ?? 0) * 0.3);

  const shortlist = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RERANK_CANDIDATES)
    .map(([id]) => card.get(id)!);

  const ranked = await rerank(env, query, shortlist, passages, stale);

  return {
    found: card.size,
    degraded,
    hits: ranked.map((h) => {
      const passage = passages.get(h.id) ?? String(h.body ?? "");
      return {
        id: h.id,
        title: h.title,
        board_id: h.board_id,
        board_name: h.board_name,
        passage: excerptOf(passage, RECALL_EXCERPT),
        truncated: passage.length > RECALL_EXCERPT,
        why: [...(why.get(h.id) ?? [])],
        superseded: stale.has(h.id),
        links: ((near.get(h.id) ?? []) as Neighbour[]).map((n) => ({
          id: n.id,
          title: n.title,
          label: n.via_label ?? "",
          board_id: n.board_id,
          board_name: n.board_name,
        })),
      };
    }),
  };
}

async function recall(env: McpEnv, userId: string, args: any) {
  const query = String(args?.query ?? "").trim();
  if (!query) return toolText("A query is required — what are you trying to remember?", true);

  const scope = args?.mindmap_id ? String(args.mindmap_id) : null;
  const depth = Math.max(0, Math.min(2, Number.isFinite(args?.depth) ? Number(args.depth) : 1));

  const { hits, found, degraded } = await rankRecall(env, userId, query, scope, depth);

  if (!hits.length) {
    await logRecall(env, userId, query, scope, 0, 0);
    return toolText(
      `Nothing recorded about "${query}".` +
        (degraded
          ? `\n\n_Note: the semantic index is unavailable (${degraded}), so anything older than a few minutes was searched by wording alone — a card may exist that this could not reach._`
          : "") +
        "\n\nThis is the moment to write it down: create_mindmap for a new topic, or add_card to something list_mindmaps already shows.",
    );
  }

  const out: string[] = [`# What you know about "${query}"`, ""];

  for (const h of hits) {
    out.push(
      `## ${h.title || "(untitled)"}${h.superseded ? " ⊘ superseded" : ""}`,
      `in *${h.board_name}* · id: \`${h.id}\` · matched on ${h.why.join(" + ")}`,
    );
    if (h.passage) out.push("", h.passage + (h.truncated ? "…" : ""));
    if (h.links.length) {
      out.push("", "Connects to:");
      for (const n of h.links)
        out.push(
          `- ${n.title || "(untitled)"}${n.label ? ` — *${n.label}*` : ""}` +
            (n.board_id !== h.board_id ? ` _(in ${n.board_name})_` : "") +
            ` · \`${n.id}\``,
        );
    }
    out.push("");
  }

  const across = new Set(hits.map((h) => h.board_id)).size;
  out.push(
    `_${hits.length} of ${found} matches shown, across ${across} mindmap${across === 1 ? "" : "s"}.` +
      ` get_card for a full document, get_context to walk further out._`,
  );
  // Precise about *what* was lost. "Wording only" was true before the fresh
  // pass existed; now a failed index still leaves recently written cards
  // searchable by meaning, and claiming otherwise would have an agent distrust
  // a result the line above it just labelled "matched on meaning".
  if (degraded)
    out.push(
      "",
      `_Searched the last few minutes by meaning and everything by wording — the semantic index is unavailable (${degraded}), so older cards were matched on wording alone._`,
    );

  await logRecall(env, userId, query, scope, found, hits.length);
  return toolText(out.join("\n").trim());
}

/**
 * Final ordering: read the query against each shortlisted passage.
 *
 * Everything upstream compares the query to a card without ever looking at the
 * two together — bm25 counts terms, cosine compares vectors computed in mutual
 * ignorance. A cross-encoder reads both at once, which is why it is worth a
 * second inference call on a shortlist even though it would be unaffordable
 * over a corpus.
 *
 * Reranking the *winning passage* rather than the head of the document is what
 * makes this work on long cards: the model sees the part that actually matched.
 *
 * If the model is unavailable or returns nothing usable, the fusion order
 * stands. That order was the entire answer until now and remains a good one —
 * a reranker improves a ranking, it is not a precondition for having one.
 */
async function rerank(
  env: McpEnv,
  query: string,
  shortlist: Hit[],
  passages: Map<string, string>,
  stale: Set<string>,
): Promise<Hit[]> {
  if (shortlist.length < 2) return shortlist.slice(0, RECALL_HITS);

  const passageFor = (h: Hit) =>
    `${h.title || "(untitled)"}\n\n${passages.get(h.id) ?? excerptOf(h.body, 1200)}`.trim();

  const scores = await rerankScores(env, query, shortlist.map(passageFor));
  if (!scores) return shortlist.slice(0, RECALL_HITS);

  // Supersession has to be reapplied: the cross-encoder judges relevance to the
  // question and knows nothing about a card having been replaced. Without this
  // a superseded card that answers the question perfectly climbs straight back
  // to the top, undoing the demotion fusion just applied.
  //
  // Partitioned rather than scored, because no arithmetic is safe across every
  // reranker's output range. bge-reranker-base returns small positives, so a
  // `-1` multiplier would work today and silently invert — promoting exactly
  // the cards it was meant to bury — against any model that emits raw logits.
  // Sorting each group and concatenating cannot express that bug.
  const order = (group: Array<{ h: Hit; s: number }>) =>
    group.sort((a, b) => b.s - a.s).map((r) => r.h);
  const scored = shortlist.map((h, i) => ({ h, s: scores[i] }));
  return [
    ...order(scored.filter((r) => !stale.has(r.h.id))),
    ...order(scored.filter((r) => stale.has(r.h.id))),
  ].slice(0, RECALL_HITS);
}

/**
 * Record the question, never the answer.
 *
 * Fire-and-forget and swallowed: a failure to log must never fail a recall.
 * See 0016 for why this exists before the eval work it feeds.
 */
async function logRecall(
  env: McpEnv,
  userId: string,
  query: string,
  scope: string | null,
  found: number,
  shown: number,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO recall_queries (id,user_id,query,mindmap_id,found,shown,at)
       VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(crypto.randomUUID(), userId, query.slice(0, 500), scope, found, shown, now())
      .run();
  } catch (err) {
    console.error("recall log failed", err);
  }
}

/**
 * Cards whose *meaning* matches the query, read back from D1.
 *
 * Scores are no longer rescaled to sit alongside bm25 — fusion is by rank now
 * (see `rrf`), so the units of either retriever stop mattering. What this does
 * carry forward is the winning *passage* per card, which becomes the excerpt
 * `recall` prints instead of the opening of the document.
 */
async function semanticHits(
  env: McpEnv,
  userId: string,
  query: string,
  boardId: string | null,
  limit: number,
): Promise<{ hits: Hit[]; passages: Map<string, string>; degraded?: string }> {
  const none = { hits: [] as Hit[], passages: new Map<string, string>() };
  if (!semanticReady(env)) return { ...none, degraded: "semantic index not configured" };

  // Ask for more chunks than cards wanted: several passages of one card can
  // occupy the top, and they collapse to a single result.
  const { hits: matches, degraded } = await similarChunks(env, userId, query, limit * 3);
  if (!matches.length) return { ...none, degraded };

  // Best passage per card, and its score. Max rather than sum: a card is as
  // relevant as its most relevant passage, and summing would just reward long
  // cards for having more chances to match.
  const best = new Map<string, { chunkId: string; score: number }>();
  for (const m of matches) {
    const seen = best.get(m.cardId);
    if (!seen || m.score > seen.score) best.set(m.cardId, { chunkId: m.chunkId, score: m.score });
  }

  const cardIds = [...best.keys()];
  const marks = cardIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.title, n.body, n.board_id, n.updated_at, b.name AS board_name
       FROM nodes n JOIN boards b ON b.id = n.board_id
      WHERE n.id IN (${marks})
        AND b.user_id = ?
        AND (? IS NULL OR n.board_id = ?)
        AND n.type IN ('card','note')`,
  )
    .bind(...cardIds, userId, boardId, boardId)
    .all<Omit<Hit, "score">>();

  const rows = results ?? [];

  // Fetch the winning passages in one go, for the excerpts.
  const winners = rows.map((r) => best.get(r.id)!.chunkId);
  const passages = new Map<string, string>();
  if (winners.length) {
    const wMarks = winners.map(() => "?").join(",");
    const { results: chunks } = await env.DB.prepare(
      `SELECT id, node_id, text FROM node_chunks WHERE id IN (${wMarks})`,
    )
      .bind(...winners)
      .all<{ id: string; node_id: string; text: string }>();
    for (const c of chunks ?? []) passages.set(c.node_id, c.text);
  }

  return {
    hits: rows
      .map((r) => ({ ...r, score: best.get(r.id)?.score ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit),
    passages,
    degraded,
  };
}

/** Keep the semantic index in step with a card that just changed. */
async function reindex(env: McpEnv, userId: string, nodeId: string): Promise<void> {
  if (!semanticReady(env)) return;
  const row = await env.DB.prepare(
    `SELECT n.id, n.title, n.body, n.board_id FROM nodes n WHERE n.id = ?`,
  )
    .bind(nodeId)
    .first<{ id: string; title: string; body: string; board_id: string }>();
  if (!row) {
    await removeCards(env, [nodeId]);
    return;
  }
  await indexCard(env, {
    id: row.id,
    title: row.title,
    body: row.body,
    userId,
    boardId: row.board_id,
  });
  // Whatever marked this card is now satisfied, whichever path got here.
  // Cleared after the work, never before: a failed or interrupted run leaves
  // the card marked and the next sweep retries it, where clearing first would
  // drop the edit out of the index with nothing left to say so.
  await env.DB.prepare(`UPDATE nodes SET index_dirty = NULL WHERE id = ?`).bind(nodeId).run();
}

/** Index several cards, tolerating individual failures. */
async function reindexAll(env: McpEnv, userId: string, ids: string[]): Promise<void> {
  if (!semanticReady(env) || !ids.length) return;
  // Sequential on purpose: Workers AI is rate-limited, and a burst on a
  // 20-card create_mindmap is the exact shape that trips it.
  for (const id of ids) await reindex(env, userId, id);
}

/**
 * Re-embed cards marked dirty by a browser edit, oldest first.
 *
 * Runs on a schedule rather than in the request that dirtied the row, because
 * the editor commits on a 400ms debounce and inline indexing would embed every
 * pause mid-sentence. Waiting coalesces a burst of edits into one call against
 * the final text — see 0018.
 *
 * Owner is resolved per card rather than taken as an argument: the sweep runs
 * with no user in scope, and the Vectorize namespace has to be the account that
 * owns the board, not whoever happened to trigger the tick.
 */
export async function sweepDirty(env: McpEnv, limit = 30): Promise<number> {
  if (!semanticReady(env)) return 0;

  const { results } = await env.DB.prepare(
    `SELECT n.id, b.user_id
       FROM nodes n JOIN boards b ON b.id = n.board_id
      WHERE n.index_dirty IS NOT NULL
        AND n.type IN ('card','note')
      ORDER BY n.index_dirty
      LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; user_id: string }>();

  const rows = results ?? [];
  // Sequential, like reindexAll and for the same reason: Workers AI is
  // rate-limited, and a sweep is exactly the burst shape that trips it.
  for (const row of rows) await reindex(env, row.user_id, row.id);
  return rows.length;
}

/**
 * Re-embed a page of one user's cards.
 *
 * Exists because two changes need every card re-embedded: chunking (0017) and
 * the move to bge-m3, whose 1,024 dimensions are not even loadable into the
 * old index. Cards written before either are unfindable by meaning until this
 * has run over them.
 *
 * Paged rather than exhaustive: each card is one Workers AI call, and a few
 * hundred of those in a single request is how you meet the subrequest ceiling
 * and a CPU timeout at once. The caller pumps the returned cursor until
 * `done`, so progress survives a failure partway through — re-running a page
 * that already succeeded is harmless, since indexing is idempotent by chunk id.
 */
export async function reindexPage(
  env: McpEnv,
  userId: string,
  after: string | null,
  limit: number,
): Promise<{ processed: string[]; next: string | null; done: boolean }> {
  const { results } = await env.DB.prepare(
    `SELECT n.id
       FROM nodes n JOIN boards b ON b.id = n.board_id
      WHERE b.user_id = ?
        AND n.type IN ('card','note')
        AND (? IS NULL OR n.id > ?)
      ORDER BY n.id
      LIMIT ?`,
  )
    .bind(userId, after, after, limit)
    .all<{ id: string }>();

  const ids = (results ?? []).map((r) => r.id);
  await reindexAll(env, userId, ids);
  return {
    processed: ids,
    next: ids.length ? ids[ids.length - 1] : null,
    done: ids.length < limit,
  };
}

// ---------------------------------------------------------------------------
// Idempotent writes
//
// The failure being fixed: running "summarise this session" twice produced two
// overlapping mindmaps, so every re-run made the memory worse rather than
// better. With a stable key, a second run converges on the first.
// ---------------------------------------------------------------------------

interface Existing {
  id: string;
  x: number;
  y: number;
  data: string;
}

/** Cards on a board that already carry one of the keys we are about to write. */
async function existingByKey(
  env: McpEnv,
  boardId: string,
  keys: string[],
): Promise<Map<string, Existing>> {
  const wanted = keys.filter(Boolean);
  if (!wanted.length) return new Map();
  const marks = wanted.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT idem_key, id, x, y, data FROM nodes
      WHERE board_id = ? AND idem_key IN (${marks})`,
  )
    .bind(boardId, ...wanted)
    .all<Existing & { idem_key: string }>();
  return new Map((results ?? []).map((r) => [r.idem_key, r]));
}

/**
 * Statements to write a set of prepared rows, updating anything already keyed.
 *
 * Two things are deliberately *not* overwritten on a re-run:
 *
 *   position   the user may have arranged this board by hand, and an agent
 *              restating what it knows must not rearrange their desk
 *   data       carries open_at and the original author; a re-run restates the
 *              content, not who first wrote it
 */
function upsertNodeStmts(
  env: McpEnv,
  boardId: string,
  rows: PreparedRow[],
  keyed: boolean,
  existing: Map<string, Existing>,
  clientId?: string,
): { stmts: D1PreparedStatement[]; ids: string[]; added: number; updated: number } {
  const stmts: D1PreparedStatement[] = [];
  const ids: string[] = [];
  let added = 0;
  let updated = 0;

  for (const r of rows) {
    const prior = keyed ? existing.get(r.key) : undefined;
    if (prior) {
      stmts.push(
        env.DB.prepare(
          `UPDATE nodes SET title = ?, body = ?, doc = ?, updated_at = ? WHERE id = ?`,
        ).bind(r.title, r.body, r.doc, now(), prior.id),
      );
      ids.push(prior.id);
      updated += 1;
    } else {
      stmts.push(insertNodeStmt(env, boardId, r, dataFor(null, clientId), keyed ? r.key : null));
      ids.push(r.id);
      added += 1;
    }
  }
  return { stmts, ids, added, updated };
}

/** Links already present between these cards, so a re-run relabels rather than doubles up. */
async function existingEdges(
  env: McpEnv,
  pairs: Array<[string, string]>,
): Promise<Map<string, string>> {
  if (!pairs.length) return new Map();
  const ids = [...new Set(pairs.flat())];
  const marks = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, source_id, target_id FROM edges
      WHERE source_id IN (${marks}) AND target_id IN (${marks})`,
  )
    .bind(...ids, ...ids)
    .all<{ id: string; source_id: string; target_id: string }>();
  return new Map((results ?? []).map((e) => [`${e.source_id}>${e.target_id}`, e.id]));
}
