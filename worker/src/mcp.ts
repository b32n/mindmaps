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
  handlesFor, isDirection, layout, placeBlock,
  type Direction, type ExistingNode, type LayoutEdge, type LayoutNode, type PlaceResult,
} from "./layout";
import {
  ARTEFACT_SCHEMAS, INDEXABLE_SQL, isArtefact, payloadFromInput, putArtefact, type ArtefactKind,
} from "./artefacts";
import {
  BOARD_READABLE, IN_WORKSPACE, NODE_READABLE, boardRole, canWrite, ensurePersonalWorkspace,
  nodeRole, recallScope,
} from "./access";
import {
  fileById, filesOf, isFileKind, isTextual, storeFile, type FileRow,
} from "./files";
import { fileUrl, frameUrl } from "./mindbox";
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
    description: "Create a mindmap for a subject with no home yet — the rare case, and refused unless you called recall first. Supply nodes and the labelled edges between them; positions are computed here, so do not invent coordinates. Pass a `key` if you might record this topic again — a second call with the same key updates rather than duplicating.",
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
    name: "create_artefact",
    description:
      "Create a spreadsheet, document or deck on a mindmap. Reach for one when what you are recording has a shape a card cannot hold: a table that computes, a document that will be read end to end, a deck that will be presented. A card holds markdown and is the right answer for a note. Whichever kind you pick, write the labels — column headings, slide titles, headings — because the words are what make it findable later and the numbers are nearly invisible to search.",
    inputSchema: {
      type: "object",
      properties: {
        mindmap_id: { type: "string" },
        type: {
          type: "string",
          enum: ["sheet", "doc", "deck", "html"],
          description:
            "sheet for figures that compute, doc for prose that will be read in order, deck for something presented, html for anything you want to draw or make interactive. Defaults to sheet.",
        },
        title: { type: "string", description: "The artefact's name." },
        sheets: {
          type: "array",
          description: "sheet only. One entry per tab; most have one.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              rows: {
                type: "array",
                description:
                  "Rows of cells. A cell is a string, number, boolean or null. A string starting with = is a formula, e.g. \"=SUM(B2:B5)\". Empty cells are not stored.",
                items: { type: "array", items: {} },
              },
            },
          },
        },
        blocks: {
          type: "array",
          description:
            "doc only. One block per entry with exactly one of: heading (plus optional level 1-6), text, bullet, number, rule. A bare string is a paragraph.",
          items: {},
        },
        slides: {
          type: "array",
          description:
            "deck only. Each slide takes a title, bullets, and optional speaker notes. Notes are indexed, so the argument you write there stays findable.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              notes: { type: "string" },
            },
          },
        },
        html: {
          type: "string",
          description:
            "html only. A complete HTML document. It renders sandboxed on a separate origin with no network access at all, so inline every script and style and embed images as data URIs — a remote <script src> or a fetch() will be blocked. Put the point of the page in visible text, since that is what search reads. A signed URL comes back: render it to show the page.",
        },
        key: {
          type: "string",
          description:
            "A stable name for this artefact. Pass one whenever you might produce the same thing again: a second call with the same key replaces its contents instead of leaving a near-duplicate on the board.",
        },
      },
      required: ["mindmap_id", "title"],
    },
  },
  {
    name: "update_artefact",
    description:
      "Replace an artefact's contents. Takes the same shape as create_artefact and overwrites everything, so send the whole thing rather than a fragment. Read it first with get_card if you are amending rather than replacing. The kind is whatever the artefact already is; you cannot turn a deck into a spreadsheet this way.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The artefact's card id." },
        title: { type: "string" },
        sheets: { type: "array", items: {} },
        blocks: { type: "array", items: {} },
        slides: { type: "array", items: {} },
        html: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_artefact_schema",
    description:
      "The full payload shape for one artefact kind, for when the simple form is not enough: styles, number formats, frozen panes, tables, images, themes, element geometry. Not needed for ordinary tables, documents or decks. Call this only when you want control create_artefact does not expose.",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string", enum: ["sheet", "doc", "deck", "html"] } },
      required: ["type"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "put_file",
    description:
      "Store a file on a mindmap so it outlives this session. Use it for anything you want yourself or another agent to be able to open later: a dataset, an export, a log, a generated report, a diagram. Text content goes in `content`; anything else goes in `content_base64`. Always write `description` — one line saying what this is and why it was kept. For a file whose text we cannot read, that line is the only thing that will ever find it again.",
    inputSchema: {
      type: "object",
      properties: {
        mindmap_id: {
          type: "string",
          description: "The mindmap to put it on. Ignored when folder_id is given.",
        },
        folder: {
          type: "string",
          description:
            "Put it in a folder of this name on the mindmap, creating the folder the first time. Use the same name across calls when several files belong together — they then share one place on the board and one set of permissions, instead of scattering a card each.",
        },
        folder_id: {
          type: "string",
          description: "An existing folder's card id, when you already have one.",
        },
        name: { type: "string", description: "The filename, with its extension." },
        content: { type: "string", description: "The file's text. Use this for anything textual." },
        content_base64: {
          type: "string",
          description: "Base64 for binary files. Keep these small; large uploads belong in the app.",
        },
        content_type: {
          type: "string",
          description: "MIME type. Guessed from the extension when omitted.",
        },
        description: {
          type: "string",
          description:
            "One line: what this is. Required for anything not textual, because nothing else about it is searchable.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_files",
    description:
      "The files stored on a mindmap, or in one folder. Start here when you are looking for something a previous session left behind — the descriptions say what each one is without downloading any of it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "A mindmap id, or a file or folder card id." },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_file",
    description:
      "Read a stored file's text. Works for text, source, csv, json and the like. A binary file cannot be returned this way and you get a download link instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The file id from list_files, or a file card id." },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
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
        connect_to: {
          type: "string",
          description:
            "The card id this one follows from. Pass it whenever there is one: it draws the link and places the card beside it rather than off on its own.",
        },
        label: { type: "string", description: "How they relate, e.g. blocks, informs." },
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
  "create_artefact",
  "update_artefact",
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
  /** artefact payloads; see artefacts.ts */
  ARTEFACTS: R2Bucket;
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

const INSTRUCTIONS = `Mindmaps are spatial maps of cards, each holding a markdown document: memory that outlives this session.

**Call recall first.** One call searches everything and follows the links out from what it finds, so it answers "what do I already know about this" before you start.

**Then write where it belongs.** Every match names the mindmap it came from; extend that one. A mindmap is a subject someone returns to over weeks, a card is one thing learned — when it could go either way, add a card to a map that exists. Describe every mindmap you create: that sentence is what later decides whether a new card belongs there.

**Pass a stable \`key\`** on anything you might record again, so a second run updates it instead of leaving a near-duplicate.

**Write before you reply, not after.** If this session produced something the next would have to redo — an investigation, a decision and why, a dead end, a correction to something recall got wrong, a preference the user stated — record it unasked. Not what the repo or git history already says; not what is only true this turn; nothing you cannot describe in one line.

**Artefacts live here too** — sheets, documents, decks, pages, files. Build them with create_artefact rather than elsewhere, and render the signed URL an html artefact hands back.

Links carry the reasoning — blocks, informs, supersedes — and may join cards on *different* mindmaps. That cross-topic link is what makes this a brain rather than a filing cabinet.

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

  // Anything thrown from here is a bug or an outage, not something the agent
  // can act on. The raw message can carry SQL, so it stays in the log; the
  // model gets a reference and the one fact it needs: nothing was written.
  try {
    return await runTool(id, env, grant, name, args);
  } catch (err: any) {
    const ref = crypto.randomUUID().slice(0, 8);
    console.error("mcp tool failed", name, ref, err);
    return rpcOk(id, toolText(`That failed (ref ${ref}); nothing was written.`, true));
  }
}

async function runTool(id: Id, env: McpEnv, grant: TokenGrant, name: string, args: any): Promise<Response> {
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
    case "create_artefact":
      return rpcOk(id, await createArtefact(env, u, args));
    case "update_artefact":
      return rpcOk(id, await updateArtefact(env, u, args));
    case "get_artefact_schema": {
      // One kind at a time. Returning all three would put three schemas into
      // the context of an agent that asked about one.
      const want = String(args?.type ?? "sheet");
      const schema = ARTEFACT_SCHEMAS[want];
      return rpcOk(
        id,
        schema
          ? toolText(schema)
          : toolText(
              `No schema for "${want}". Artefact types are: ${Object.keys(ARTEFACT_SCHEMAS).join(", ")}.`,
              true,
            ),
      );
    }
    case "put_file":
      return rpcOk(id, await putFileTool(env, u, args));
    case "list_files":
      return rpcOk(id, await listFilesTool(env, u, args));
    case "read_file":
      return rpcOk(id, await readFileTool(env, u, args));
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

/**
 * A mindmap this agent's user may write to.
 *
 * Every MCP tool that takes a `mindmap_id` writes to it — adding cards,
 * artefacts, links — so write is the right bar, not read. A viewer on a shared
 * mindmap gets the same "no such mindmap" an outsider does, which is the
 * honest answer to "put this there": they cannot.
 */
async function writableBoard(env: McpEnv, userId: string, boardId: string) {
  const board = await env.DB.prepare(
    `SELECT * FROM boards WHERE id = ? AND parent_id IS NULL`,
  )
    .bind(boardId)
    .first<any>();
  if (!board) return null;
  return canWrite(await boardRole(env.DB, userId, boardId)) ? board : null;
}

/**
 * Why a write was refused, in words the agent can act on.
 *
 * "No mindmap with id X" is the right answer when there is nothing to see, and
 * a lie when the user is looking at it with view-only access — the agent would
 * retry, or tell them the mindmap does not exist while it is open on screen.
 * Telling it the truth lets it say so instead.
 */
async function writeDenial(
  env: McpEnv,
  userId: string,
  kind: "mindmap" | "card" | "artefact",
  id: string,
): Promise<string> {
  const role =
    kind === "mindmap" ? await boardRole(env.DB, userId, id) : await nodeRole(env.DB, userId, id);
  return role
    ? `You have view-only access to that ${kind}, so it cannot be changed.`
    : `No ${kind} with id ${id}.`;
}

/** A node this agent's user may read. Used by the tools that only look. */
async function readableNode(env: McpEnv, userId: string, nodeId: string) {
  const node = await env.DB.prepare(
    `SELECT n.*, b.id AS board_id_check, b.name AS board_name
       FROM nodes n JOIN boards b ON b.id = n.board_id
      WHERE n.id = ?`,
  )
    .bind(nodeId)
    .first<any>();
  if (!node) return null;
  return (await nodeRole(env.DB, userId, nodeId)) ? node : null;
}

/** A mindmap this agent's user may read. Used by the tools that only look. */
async function readableBoard(env: McpEnv, userId: string, boardId: string) {
  const board = await env.DB.prepare(
    `SELECT * FROM boards WHERE id = ? AND parent_id IS NULL`,
  )
    .bind(boardId)
    .first<any>();
  if (!board) return null;
  return (await boardRole(env.DB, userId, boardId)) ? board : null;
}

async function writableNode(env: McpEnv, userId: string, nodeId: string) {
  const node = await env.DB.prepare(
    `SELECT n.*, b.id AS board_id_check, b.name AS board_name
       FROM nodes n JOIN boards b ON b.id = n.board_id
      WHERE n.id = ?`,
  )
    .bind(nodeId)
    .first<any>();
  if (!node) return null;
  return canWrite(await nodeRole(env.DB, userId, nodeId)) ? node : null;
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
      WHERE ${BOARD_READABLE("b")} AND b.parent_id IS NULL
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
  const board = await writableBoard(env, userId, boardId);
  if (!board) return toolText(await writeDenial(env, userId, "mindmap", boardId), true);

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
  const board = await readableBoard(env, userId, String(args?.id ?? ""));
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
  const node = await readableNode(env, userId, String(args?.id ?? ""));
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
      `id: \`${node.id}\` · type: ${node.type}` +
        (node.idem_key ? ` · key: \`${node.idem_key}\`` : "") +
        (total ? ` · checklist ${done}/${total}` : "") +
        wrote,
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
  type: string;
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
  /** The workspace to stay inside, or null for everywhere the user can read. */
  workspaceId: string | null = null,
): Promise<Hit[]> {
  const match = ftsQuery(query, mode);
  if (!match) return [];
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.type, n.title, n.body, n.board_id, n.updated_at,
            b.name AS board_name,
            -bm25(nodes_fts, 6.0, 1.0) AS score
       FROM nodes_fts f
       JOIN nodes  n ON n.rowid = f.rowid
       JOIN boards b ON b.id = n.board_id
      WHERE nodes_fts MATCH ?1
        AND ${BOARD_READABLE("b", 2)}
        AND ${IN_WORKSPACE("b", "n", 5, 2)}
        AND (?3 IS NULL OR n.board_id = ?3)
        AND n.type IN (${INDEXABLE_SQL})
      ORDER BY score DESC
      LIMIT ?4`,
  )
    .bind(match, userId, boardId, limit, workspaceId)
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
      `- **${h.title || "(untitled)"}** (${h.type}) in *${h.board_name}*` +
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

/**
 * Everything the placer needs to know about a board, in one round trip.
 *
 * Six write tools used to each run their own `SELECT id, y, h` and hand the
 * result to a layout that put new cards below all of it. They now share this,
 * because anchor-aware placement needs strictly more: `x`/`w` to know what
 * space is actually free, `data` to know what a human has arranged, and the
 * edges to know which cards form a component.
 */
interface Surface {
  existing: ExistingNode[];
  existingEdges: LayoutEdge[];
  /** card ids on this board, for resolving an edge endpoint that is not a new key */
  present: Set<string>;
}

/** A card a human dragged, or a node that was never part of the graph. */
const isFixed = (row: any): boolean => {
  if (row?.type !== "card" && row?.type !== "note") return true;
  try {
    return JSON.parse(String(row?.data || "{}"))?.placed === "hand";
  } catch {
    // Unparseable `data` is not a reason to move someone's card.
    return true;
  }
};

async function boardSurface(env: McpEnv, boardId: string): Promise<Surface> {
  const [nodes, edges] = await Promise.all([
    env.DB.prepare(`SELECT id, type, x, y, w, h, data FROM nodes WHERE board_id = ?`)
      .bind(boardId)
      .all<any>(),
    // Only links with both ends here describe a component on this canvas; one
    // reaching off-board has no second position to arrange against.
    env.DB.prepare(
      `SELECT e.source_id, e.target_id
         FROM edges e
         JOIN nodes sn ON sn.id = e.source_id
         JOIN nodes tn ON tn.id = e.target_id
        WHERE sn.board_id = ? AND tn.board_id = ?`,
    )
      .bind(boardId, boardId)
      .all<any>(),
  ]);

  const rows = nodes.results ?? [];
  return {
    existing: rows.map((n) => ({
      id: String(n.id),
      x: Number(n.x ?? 0),
      y: Number(n.y ?? 0),
      w: Number(n.w ?? 260),
      h: Number(n.h ?? 150),
      fixed: isFixed(n),
    })),
    existingEdges: (edges.results ?? []).map((e) => ({
      from: String(e.source_id),
      to: String(e.target_id),
    })),
    present: new Set(rows.map((n) => String(n.id))),
  };
}

/**
 * The placer every write tool uses, curried over one board's surface.
 *
 * `reflow` is off for the single-card callers: a lone card with no edges has no
 * component to rebuild, so asking is pointless, and it keeps the blast radius
 * of a `put_file` to the file it is adding.
 */
const placerFor = (surface: Surface, direction: Direction, reflow: boolean) =>
  (nodes: LayoutNode[], edges: LayoutEdge[]): PlaceResult =>
    placeBlock(nodes, edges, {
      direction,
      existing: surface.existing,
      existingEdges: surface.existingEdges,
      reflowComponent: reflow,
    });

/** Turn the agent's nodes+edges into rows, with positions computed here. */
function prepare(
  nodes: IncomingNode[],
  edges: any[],
  place: (n: LayoutNode[], e: LayoutEdge[]) => PlaceResult,
) {
  // A key is how edges refer to a node. Agents forget; fall back to the index
  // so a missing key degrades to "no edges for this node" rather than an error.
  const withKeys = nodes.map((n, i) => ({ ...n, key: String(n.key ?? `n${i}`) }));
  // Endpoints that are existing card ids are passed through untouched: the
  // placer wants them, because they are what the new work attaches to.
  const laid = place(
    withKeys.map((n) => ({ key: n.key })),
    (edges ?? [])
      .filter((e) => e && e.from && e.to)
      .map((e) => ({ from: String(e.from), to: String(e.to) })),
  );
  const posOf = new Map(laid.placed.map((p) => [p.key, p]));

  const rows = withKeys.map((n) => {
    const { doc, body } = normaliseContent(n.content);
    // The placer returns a position for every key it was given, so a miss here
    // would be a bug rather than a case to paper over with the origin.
    const pos = posOf.get(n.key) ?? { x: ORIGIN_FALLBACK, y: ORIGIN_FALLBACK };
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

  return {
    rows,
    keyToId: new Map(rows.map((r) => [r.key, r.id])),
    /** existing cards the placer wants to move, when it rebuilt a component */
    moved: laid.moved,
  };
}

/** Only reachable if the placer broke its contract; distinctive enough to spot on a board. */
const ORIGIN_FALLBACK = 80;

/** `UPDATE` statements for the cards a rebuilt component shifted. */
const moveStmts = (env: McpEnv, moved: Array<{ key: string; x: number; y: number }>) =>
  moved.map((m) =>
    env.DB.prepare(`UPDATE nodes SET x = ?, y = ?, updated_at = ? WHERE id = ?`)
      .bind(m.x, m.y, now(), m.key),
  );

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

/**
 * How recently a recall has to have happened for `create_mindmap` to be allowed.
 *
 * Long enough to cover a session that recalled, went away and did a lot of
 * work before deciding it had something new; short enough that it is a real
 * precondition rather than a formality satisfied once a week.
 */
const RECALL_WINDOW_MS = 60 * 60 * 1000;

/**
 * The homes a new card could go to instead, newest first.
 *
 * Used in two places and for one purpose: to turn "do not create a mindmap for
 * every fact" from advice in a preamble that is read once into a sentence that
 * arrives at the moment the choice is being made. A list of names and the
 * descriptions that say what belongs on them is what makes the choice
 * answerable rather than a guess.
 */
async function candidateHomes(env: McpEnv, userId: string, limit = 6): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT b.name, b.description
       FROM boards b
      WHERE ${BOARD_READABLE("b")} AND b.status != 'trashed' AND b.parent_id IS NULL
      ORDER BY b.updated_at DESC
      LIMIT ?2`,
  )
    .bind(userId, limit)
    .all<any>();

  const rows = results ?? [];
  if (!rows.length) return "";
  return rows
    .map((b) => `- **${b.name}**${b.description ? ` — ${b.description}` : ""}`)
    .join("\n");
}

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

  /*
   * From here a genuinely new mindmap is about to exist, and it is only the
   * right answer when nothing already here could hold this. The only way to
   * know that is to have looked.
   *
   * Checked after the key lookup above, not before it: a keyed re-run is the
   * safe, converging path and must stay callable without ceremony. A *first*
   * create is gated whether it carries a key or not.
   *
   * Enforced rather than asked for, because asking has not worked — the
   * preamble has said this since the server shipped and maps still arrive one
   * fact at a time. The refusal costs tokens only when the agent was about to
   * get it wrong, and it carries the real alternatives, which is the part that
   * makes the next call right.
   */
  const looked = await env.DB.prepare(
    `SELECT 1 FROM recall_queries WHERE user_id = ? AND at > ? LIMIT 1`,
  )
    .bind(userId, now() - RECALL_WINDOW_MS)
    .first();

  if (!looked) {
    const homes = await candidateHomes(env, userId);
    return toolText(
      "Call `recall` before creating a mindmap — a second map on a subject you already have is the one mistake here that editing cannot undo." +
        (homes
          ? `\n\nMindmaps that already exist:\n${homes}\n\nIf one of these is the home, use add_card or add_to_mindmap instead.`
          : ""),
      true,
    );
  }

  const boardId = uuid();
  // A new board is empty, so there is nothing to pack around and no
  // component to rebuild; the graph lands exactly where `layout` puts it.
  const { rows, keyToId } = prepare(nodes, args?.edges ?? [], (n, e) =>
    placeBlock(n, e, { direction }),
  );

  const top = await env.DB.prepare(
    `SELECT COALESCE(MIN(position), 0) AS top FROM boards WHERE user_id = ? AND parent_id IS NULL`,
  )
    .bind(userId)
    .first<{ top: number }>();

  // An agent creates in the user's personal workspace. It has no notion of
  // which workspace a request "means", and guessing would put work in front of
  // colleagues who were never asked.
  const workspaceId = await ensurePersonalWorkspace(env.DB, userId);

  const stmts = [
    env.DB.prepare(
      `INSERT INTO boards (id,name,status,parent_id,node_id,created_at,updated_at,user_id,position,idem_key,description,workspace_id)
       VALUES (?,?,'active',NULL,NULL,?,?,?,?,?,?,?)`,
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
      workspaceId,
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

  const surface = await boardSurface(env, boardId);

  // New cards land beside whatever they connect to, in space that is actually
  // free. A component someone has arranged by hand is never disturbed.
  const { rows, keyToId, moved } = prepare(
    nodes,
    args?.edges ?? [],
    placerFor(surface, direction, true),
  );

  const existing = await existingByKey(env, boardId, rows.map((r) => r.key));
  const clash = proseClash(rows, existing);
  if (clash) return toolText(clash, true);
  const { stmts, ids, added, updated } = upsertNodeStmts(
    env, boardId, rows, true, existing, clientId,
  );

  // The key now resolves to whichever id already holds it, so edges written in
  // this call attach to the card that survived rather than a fresh duplicate.
  const resolved = new Map<string, string>();
  rows.forEach((r, i) => resolved.set(r.key, ids[i]));

  const present = surface.present;
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

  // Cards the placer shifted while rebuilding a component it had made itself.
  stmts.push(...moveStmts(env, moved));

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
  const board = await writableBoard(env, userId, String(args?.id ?? ""));
  if (!board) return toolText(await writeDenial(env, userId, "mindmap", String(args?.id ?? "")), true);
  const nodes: IncomingNode[] = Array.isArray(args?.nodes) ? args.nodes : [];
  if (!nodes.length) return toolText("At least one node is required.", true);

  const surface = await boardSurface(env, board.id);
  const present = surface.present;

  const direction = directionOf(args);
  const { rows, moved } = prepare(
    nodes,
    args?.edges ?? [],
    placerFor(surface, direction, true),
  );

  // Keys are opt-in per call: pass them and a repeat run updates, omit them and
  // this behaves exactly as it always did.
  const keyed = nodes.some((n) => n.key && String(n.key).trim());
  const prior = keyed ? await existingByKey(env, board.id, rows.map((r) => r.key)) : new Map();
  const clash = proseClash(rows, prior);
  if (clash) return toolText(clash, true);
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

  // Cards the placer shifted while rebuilding a component it had made itself.
  stmts.push(...moveStmts(env, moved));

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

/**
 * What each kind is called and what it expects, in one place.
 *
 * Three artefact types that differ only in the field carrying their content is
 * exactly the shape that rots into three near-identical branches. This table is
 * the alternative: adding a fourth kind is a row here, not a new code path.
 */
const KINDS: Record<
  ArtefactKind,
  {
    noun: string;
    field: "sheets" | "blocks" | "slides" | "html";
    /** A page is one string; the other three are lists. */
    shape: "list" | "text";
    fallback: string;
    count: (d: any) => string;
  }
> = {
  sheet: {
    noun: "spreadsheet",
    field: "sheets",
    shape: "list",
    fallback: "Untitled sheet",
    count: (d) => `${d.sheets} sheet${d.sheets === 1 ? "" : "s"}, ${d.cells} cells`,
  },
  doc: {
    noun: "document",
    field: "blocks",
    shape: "list",
    fallback: "Untitled document",
    count: (d) => `${d.words} word${d.words === 1 ? "" : "s"}`,
  },
  deck: {
    noun: "deck",
    field: "slides",
    shape: "list",
    fallback: "Untitled deck",
    count: (d) => `${d.slides} slide${d.slides === 1 ? "" : "s"}`,
  },
  html: {
    noun: "page",
    field: "html",
    shape: "text",
    fallback: "Untitled page",
    count: (d) =>
      `${Math.max(1, Math.round(d.bytes / 1000))} kB${d.scripted ? ", runs script" : ""}`,
  },
};

/** The content an agent passed for this kind, or null if it passed none. */
function contentFor(spec: (typeof KINDS)[ArtefactKind], args: any): unknown[] | string | null {
  const raw = args?.[spec.field];
  if (spec.shape === "text")
    return typeof raw === "string" && raw.trim() ? raw : null;
  return Array.isArray(raw) && raw.length ? raw : null;
}

/** Shape the content into the argument `payloadFromInput` expects. */
const inputFor = (spec: (typeof KINDS)[ArtefactKind], content: unknown[] | string) =>
  ({ [spec.field]: content }) as Parameters<typeof payloadFromInput>[2];

const kindOf = (raw: unknown): ArtefactKind =>
  typeof raw === "string" && isArtefact(raw) ? raw : "sheet";

/** The size refusal is for the agent to read; anything else is for the log. */
function artefactRefusal(err: any): string {
  if (typeof err?.message === "string" && err.message.startsWith("Artefact is ")) return err.message;
  throw err;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Say which field is wrong, before the builders trip over it.
 *
 * `payloadFromInput` assumes the shape the schema describes; a null sheet or a
 * string where a list belongs used to surface as a TypeError about `rows` or
 * `filter`, which names nothing the agent wrote.
 */
function badInput(kind: ArtefactKind, content: unknown[] | string): string | null {
  if (kind === "sheet") {
    const sheets = content as unknown[];
    for (let i = 0; i < sheets.length; i++) {
      const s = sheets[i];
      if (!isObject(s)) return `sheets[${i}] must be an object like {name, rows}.`;
      if (s.rows !== undefined && !Array.isArray(s.rows))
        return `sheets[${i}].rows must be a list of rows, each a list of cells.`;
    }
  }
  if (kind === "deck") {
    const slides = content as unknown[];
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i];
      if (!isObject(s)) return `slides[${i}] must be an object like {title, bullets, notes}.`;
      if (s.bullets !== undefined && !Array.isArray(s.bullets))
        return `slides[${i}].bullets must be a list of strings.`;
    }
  }
  return null;
}

/**
 * Create a spreadsheet, document or deck on a mindmap.
 *
 * Sits beside `add_card` rather than replacing it: a card holds prose and an
 * artefact holds something with a shape — a grid that computes, a document that
 * paginates, a deck that presents — and the agent picks by what it is
 * recording. The payload goes to R2, the row keeps a pointer and the snapshot
 * (ARTEFACTS.md §3).
 */
/**
 * The line that lets an agent actually *show* an HTML artefact it just wrote.
 *
 * Storing a page and rendering it used to be two different things an agent had
 * to know about; the second one it had no way to do at all, because the frame
 * URL is minted by the app at render time and never travelled back through
 * this server. Handing it over here makes "keep it" and "show it" one call.
 *
 * It is a real credential, so it is worth being plain about its shape: one
 * hour, one node, read-only, on an origin with no session cookie and
 * `connect-src 'none'`. `put_file` already hands out the same kind of thing.
 *
 * Absent `MINDBOX_SECRET` there is no URL to mint — local development, where
 * there is only one origin — so the line is omitted rather than broken.
 */
async function frameLine(env: McpEnv, kind: ArtefactKind, nodeId: string): Promise<string> {
  if (kind !== "html") return "";
  const url = await frameUrl(env as any, nodeId);
  return url ? `\n\nRender this in your canvas (expires in an hour): ${url}` : "";
}

async function createArtefact(env: McpEnv, userId: string, args: any) {
  const board = await writableBoard(env, userId, String(args?.mindmap_id ?? ""));
  if (!board) return toolText(await writeDenial(env, userId, "mindmap", String(args?.mindmap_id ?? "")), true);

  const kind = kindOf(args?.type);
  const spec = KINDS[kind];
  const title = String(args?.title ?? "").trim() || spec.fallback;
  const content = contentFor(spec, args);
  if (content === null)
    return toolText(
      `Pass \`${spec.field}\` to write a ${spec.noun}. get_artefact_schema shows the shape.`,
      true,
    );

  const key = String(args?.key ?? "").trim();
  const prior = key ? await existingByKey(env, board.id, [key]) : new Map();
  const seen = prior.get(key);
  if (seen && seen.type !== kind) return toolText(keyClash(key, seen, spec.noun), true);

  const nodeId = seen?.id ?? crypto.randomUUID();
  const bad = badInput(kind, content);
  if (bad) return toolText(bad, true);
  let stored;
  try {
    stored = await putArtefact(env, nodeId, kind, payloadFromInput(kind, title, inputFor(spec, content)));
  } catch (err: any) {
    return toolText(artefactRefusal(err), true);
  }

  if (seen) {
    // Keyed and already here: replace the contents, leave where the user put it.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE nodes SET title = ?, body = ?, data = ?, updated_at = ? WHERE id = ?`,
      ).bind(title, stored.body, JSON.stringify(stored.data), now(), nodeId),
      env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), board.id),
    ]);
    await reindex(env, userId, nodeId);
    return toolText(
      `Updated **${title}** on ${board.name} — an artefact with key \`${key}\` was already there, so nothing was duplicated.\n\ncard id: \`${nodeId}\`` +
        (await frameLine(env, kind, nodeId)),
    );
  }

  const surface = await boardSurface(env, board.id);
  const { rows } = prepare(
    [{ key: key || "a0", type: "card", title }],
    [],
    placerFor(surface, "right", false),
  );
  const at = rows[0];

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO nodes (id,board_id,type,title,body,doc,x,y,w,h,data,created_at,updated_at,idem_key)
       VALUES (?,?,?,?,?,NULL,?,?,260,150,?,?,?,?)`,
    ).bind(
      nodeId, board.id, kind, title, stored.body, at.x, at.y,
      JSON.stringify(stored.data), now(), now(), key || null,
    ),
    env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), board.id),
  ]);
  await reindex(env, userId, nodeId);

  return toolText(
    `Added **${title}** to ${board.name}: ${spec.count(stored.data)}.\n\ncard id: \`${nodeId}\`` +
      (await frameLine(env, kind, nodeId)),
  );
}

async function updateArtefact(env: McpEnv, userId: string, args: any) {
  const node = await writableNode(env, userId, String(args?.id ?? ""));
  if (!node) return toolText(await writeDenial(env, userId, "artefact", String(args?.id ?? "")), true);
  if (!isArtefact(node.type))
    return toolText(
      `That is a ${node.type}, not an artefact.` + (isProse(node.type) ? " Use update_card." : ""),
      true,
    );

  // The kind is the node's, never the caller's: an update must not turn a deck
  // into a spreadsheet and silently drop everything that was in it.
  const kind = node.type as ArtefactKind;
  const spec = KINDS[kind];
  const content = contentFor(spec, args);
  if (content === null) {
    // A rename on its own leaves the payload exactly as it is.
    const renamed = String(args?.title ?? "").trim();
    if (!renamed)
      return toolText(
        `Pass \`${spec.field}\` to write the contents (this replaces them rather than merging), or just \`title\` to rename.`,
        true,
      );
    await env.DB.batch([
      env.DB.prepare(`UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?`).bind(renamed.slice(0, 500), now(), node.id),
      env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), node.board_id),
    ]);
    await reindex(env, userId, node.id);
    return toolText(`Renamed to **${renamed.slice(0, 500)}**. The ${spec.noun}'s contents are unchanged.`);
  }

  const title = String(args?.title ?? node.title ?? "").trim() || spec.fallback;
  const bad = badInput(kind, content);
  if (bad) return toolText(bad, true);
  let stored;
  try {
    stored = await putArtefact(env, node.id, kind, payloadFromInput(kind, title, inputFor(spec, content)));
  } catch (err: any) {
    return toolText(artefactRefusal(err), true);
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE nodes SET title = ?, body = ?, data = ?, updated_at = ? WHERE id = ?`,
    ).bind(title, stored.body, JSON.stringify(stored.data), now(), node.id),
    env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), node.board_id),
  ]);
  await reindex(env, userId, node.id);

  return toolText(
    `Rewrote **${title}**: ${spec.count(stored.data)}.` + (await frameLine(env, kind, node.id)),
  );
}

async function addCard(env: McpEnv, userId: string, args: any, clientId?: string) {
  const board = await writableBoard(env, userId, String(args?.mindmap_id ?? ""));
  if (!board) return toolText(await writeDenial(env, userId, "mindmap", String(args?.mindmap_id ?? "")), true);

  const surface = await boardSurface(env, board.id);

  const cardKey = String(args?.key ?? "").trim();
  /*
   * `connect_to` is what makes a single card placeable.
   *
   * Without it every `add_card` is an orphan, and an orphan has nothing to sit
   * next to — which is how the most common write an agent makes ended up being
   * the one that landed furthest from the thinking it came from.
   */
  const connectTo = String(args?.connect_to ?? "").trim();
  const anchored = connectTo && surface.present.has(connectTo);
  const { rows } = prepare(
    [{ key: cardKey || "n0", type: "card", title: args?.title, content: args?.content }],
    anchored ? [{ from: connectTo, to: cardKey || "n0" }] : [],
    placerFor(surface, "right", false),
  );

  // A keyed card that is already here is restated, not duplicated. Position and
  // `data` are left alone: the user may have moved it, and the original author
  // is a fact about the past.
  const prior = cardKey ? await existingByKey(env, board.id, [cardKey]) : new Map();
  const seen = prior.get(cardKey);
  if (seen && !isProse(seen.type)) return toolText(keyClash(cardKey, seen, "card"), true);

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
    ...(anchored
      ? [insertEdgeStmt(env, connectTo, rows[0].id, String(args?.label ?? ""), "right")]
      : []),
    env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), board.id),
  ]);
  await reindex(env, userId, rows[0].id);

  return toolText(
    `Added **${rows[0].title || "(untitled)"}** to ${board.name}` +
      (anchored ? `, linked from \`${connectTo}\`` : "") +
      // Naming an unknown card is a typo worth surfacing: the card is saved
      // either way, but it is sitting on its own and the agent should know.
      (connectTo && !anchored ? `. \`${connectTo}\` is not on this mindmap, so no link was drawn` : "") +
      `.\n\ncard id: \`${rows[0].id}\``,
  );
}

/** Why update_card and append_to_card will not touch this node, and what to use instead. */
function notACard(node: { type: string; title?: string }): string {
  if (isArtefact(node.type))
    return `That is a ${node.type}, not a card. Use update_artefact: update_card would replace its text and leave the ${node.type} itself as it was.`;
  return `That is a ${node.type}, not a card, so update_card and append_to_card leave it alone.`;
}

async function updateCard(env: McpEnv, userId: string, args: any) {
  const node = await writableNode(env, userId, String(args?.id ?? ""));
  if (!node) return toolText(await writeDenial(env, userId, "card", String(args?.id ?? "")), true);
  if (!isProse(node.type)) return toolText(notACard(node), true);

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
  const node = await writableNode(env, userId, String(args?.id ?? ""));
  if (!node) return toolText(await writeDenial(env, userId, "card", String(args?.id ?? "")), true);
  if (!isProse(node.type)) return toolText(notACard(node), true);

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
  const edge = await env.DB.prepare(
    `SELECT e.*,
            sn.board_id AS source_board, tn.board_id AS target_board,
            sb.name AS source_board_name, tb.name AS target_board_name
       FROM edges e
       JOIN nodes  sn ON sn.id = e.source_id
       JOIN boards sb ON sb.id = sn.board_id
       JOIN nodes  tn ON tn.id = e.target_id
       JOIN boards tb ON tb.id = tn.board_id
      WHERE e.id = ?1 AND ${BOARD_READABLE("sb", 2)} AND ${BOARD_READABLE("tb", 2)}`,
  )
    .bind(edgeId, userId)
    .first<any>();
  if (!edge) return null;
  // Both tools that use this change or delete the link, so reading it is not
  // enough: a viewer who has seen an id must not be able to rewrite the link.
  // Same bar as the REST route (`canWriteEdge`): write on both ends.
  const [a, b] = await Promise.all([
    nodeRole(env.DB, userId, edge.source_id),
    nodeRole(env.DB, userId, edge.target_id),
  ]);
  return canWrite(a) && canWrite(b) ? edge : null;
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
      WHERE (e.source_id = ?1 OR e.target_id = ?1) AND ${BOARD_READABLE("ob", 2)}
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
  const board = await writableBoard(env, userId, String(args?.id ?? ""));
  if (!board) return toolText(await writeDenial(env, userId, "mindmap", String(args?.id ?? "")), true);
  if (!isDirection(args?.direction))
    return toolText("direction must be `right` or `down`.", true);
  const direction: Direction = args.direction;

  const [nodesRes, edgesRes] = await Promise.all([
    env.DB.prepare(`SELECT id,type,x,y,w,h FROM nodes WHERE board_id = ?`).bind(board.id).all<any>(),
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

  /*
   * This is the one tool that overrules a hand-placed card, and it clears the
   * flag as it goes.
   *
   * Everywhere else, a card someone dragged is immovable. Here the whole
   * contract is "rearrange this map", and honouring the flag would make the
   * tool a no-op on exactly the boards that most need it — the ones that have
   * been poked at. Leaving the flag set afterwards would also be a lie: those
   * cards are machine-placed now.
   *
   * Only `card` and `note` are in `movable`, so ink and images keep both their
   * coordinates and their flag. They are annotations over the top of a map,
   * not part of the graph.
   */
  const was = new Map(movable.map((n) => [String(n.id), { x: Number(n.x ?? 0), y: Number(n.y ?? 0) }]));
  const shifted = placed.filter((p) => {
    const before = was.get(p.key);
    return !before || before.x !== Math.round(p.x) || before.y !== Math.round(p.y);
  });

  const h = handlesFor(direction);
  const stmts = [
    ...shifted.map((p) =>
      env.DB.prepare(
        `UPDATE nodes
            SET x = ?, y = ?,
                data = json_remove(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.placed'),
                updated_at = ?
          WHERE id = ?`,
      ).bind(Math.round(p.x), Math.round(p.y), now(), p.key),
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
      `${shifted.length} card${shifted.length === 1 ? "" : "s"} moved` +
      `${placed.length - shifted.length ? ` (${placed.length - shifted.length} already in place)` : ""}, ` +
      `${edges.length} link${edges.length === 1 ? "" : "s"} re-attached.`,
  );
}

async function linkCards(env: McpEnv, userId: string, args: any) {
  const from = await writableNode(env, userId, String(args?.from ?? ""));
  const to = await writableNode(env, userId, String(args?.to ?? ""));
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
    const from = await writableNode(env, userId, String(args.from));
    const to = await writableNode(env, userId, String(args.to));
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
  const node = await readableNode(env, userId, String(args?.id ?? ""));
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
  type: string;
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
  boardId: string | null,
  depth: number,
  /**
   * The workspace the question is being asked from.
   *
   * The app knows this — it is whichever workspace the user is looking at — and
   * passing it keeps recall to one vector query however large the team. An
   * agent has no such context, so when this is absent the scope widens to every
   * workspace the user belongs to, which is a small fan-out and the only
   * sensible default for something with no notion of "where I am".
   */
  workspaceId?: string | null,
): Promise<RecallResult> {
  const scope = await recallScope(env.DB, userId, workspaceId ?? null);

  // Cast wide, then rank: `any` mode so a long question still finds things,
  // with `all` a separate list because matching every term is its own evidence.
  const [strict, loose, semanticResult] = await Promise.all([
    keywordHits(env, userId, query, boardId, RECALL_HITS * 3, "all", workspaceId ?? null),
    keywordHits(env, userId, query, boardId, RECALL_HITS * 4, "any", workspaceId ?? null),
    semanticHits(env, userId, query, boardId, RECALL_HITS * 3, scope),
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
        type: h.type,
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
    /*
     * The decision this result leads to is "where does this go", so answer it
     * here rather than leaving it to a preamble read once at the start of the
     * session. Naming the maps and what each is for is what makes the choice
     * answerable; "check list_mindmaps" is another call and a guess.
     */
    const homes = await candidateHomes(env, userId);
    return toolText(
      `Nothing recorded about "${query}".` +
        (degraded
          ? `\n\n_Note: the semantic index is unavailable (${degraded}), so anything older than a few minutes was searched by wording alone — a card may exist that this could not reach._`
          : "") +
        "\n\nThis is the moment to write it down." +
        (homes
          ? `\n\nClosest homes:\n${homes}\n\nAdd a card to whichever of these it belongs on. create_mindmap only if this is genuinely a subject of its own.`
          : " Nothing exists yet, so create_mindmap is the right call."),
    );
  }

  const out: string[] = [`# What you know about "${query}"`, ""];

  for (const h of hits) {
    out.push(
      `## ${h.title || "(untitled)"} (${h.type})${h.superseded ? " ⊘ superseded" : ""}`,
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
  // Every match names its mindmap above, so the home is already decided —
  // say so once rather than letting a thin result drift into a new map.
  out.push(
    "",
    `_Anything you record from this session belongs on ${
      across === 1 ? `*${hits[0].board_name}*` : "one of the mindmaps named above"
    } — add_card or add_to_mindmap, not a new map._`,
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
  /**
   * Which namespaces to search, and which granted nodes to score directly.
   *
   * Resolved by the caller because it depends on where the request came from:
   * the app knows which workspace the user is looking at, an agent does not.
   */
  scope?: { namespaces: string[]; grantedNodeIds: string[] },
): Promise<{ hits: Hit[]; passages: Map<string, string>; degraded?: string }> {
  const none = { hits: [] as Hit[], passages: new Map<string, string>() };
  if (!semanticReady(env)) return { ...none, degraded: "semantic index not configured" };

  // Ask for more chunks than cards wanted: several passages of one card can
  // occupy the top, and they collapse to a single result.
  const { hits: matches, degraded } = await similarChunks(
    env,
    {
      userId,
      namespaces: scope?.namespaces ?? [userId],
      grantedNodeIds: scope?.grantedNodeIds ?? [],
    },
    query,
    limit * 3,
  );
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
    `SELECT n.id, n.type, n.title, n.body, n.board_id, n.updated_at, b.name AS board_name
       FROM nodes n JOIN boards b ON b.id = n.board_id
      WHERE n.id IN (${cardIds.map((_, i) => `?${i + 1}`).join(",")})
        AND ${BOARD_READABLE("b", cardIds.length + 1)}
        AND (?${cardIds.length + 2} IS NULL OR n.board_id = ?${cardIds.length + 2})
        AND n.type IN (${INDEXABLE_SQL})`,
  )
    .bind(...cardIds, userId, boardId)
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
/**
 * Re-embed one card.
 *
 * The namespace is read from the card's own board rather than taken from the
 * caller. Vectors are partitioned by workspace, and a card shared into your
 * view still belongs to its owner's workspace — indexing it under yours would
 * file someone else's content in your partition, where revoking your access
 * would not remove it.
 */
async function reindex(env: McpEnv, _caller: string, nodeId: string): Promise<void> {
  if (!semanticReady(env)) return;
  const row = await env.DB.prepare(
    `SELECT n.id, n.title, n.body, n.board_id, b.workspace_id
       FROM nodes n JOIN boards b ON b.id = n.board_id
      WHERE n.id = ?`,
  )
    .bind(nodeId)
    .first<{ id: string; title: string; body: string; board_id: string; workspace_id: string }>();
  if (!row) {
    await removeCards(env, [nodeId]);
    return;
  }
  await indexCard(env, {
    id: row.id,
    title: row.title,
    body: row.body,
    namespace: row.workspace_id,
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
    `SELECT n.id, b.workspace_id
       FROM nodes n JOIN boards b ON b.id = n.board_id
      WHERE n.index_dirty IS NOT NULL
        AND n.type IN (${INDEXABLE_SQL})
      ORDER BY n.index_dirty
      LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; workspace_id: string }>();

  const rows = results ?? [];
  // Sequential, like reindexAll and for the same reason: Workers AI is
  // rate-limited, and a sweep is exactly the burst shape that trips it.
  for (const row of rows) await reindex(env, row.workspace_id, row.id);
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
      WHERE ${BOARD_READABLE("b")}
        AND n.type IN (${INDEXABLE_SQL})
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
  type: string;
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
    `SELECT idem_key, id, type, x, y, data FROM nodes
      WHERE board_id = ? AND idem_key IN (${marks})`,
  )
    .bind(boardId, ...wanted)
    .all<Existing & { idem_key: string }>();
  return new Map((results ?? []).map((r) => [r.idem_key, r]));
}

/** Cards and notes are the prose nodes; everything else has a payload or bytes of its own. */
const isProse = (type: string) => type === "card" || type === "note";

/**
 * What to say when a key already belongs to a node of another kind.
 *
 * A keyed write restates what is there, which is only right when what is there
 * is the same kind of thing. Over a different kind it would replace a sheet's
 * title with a card's, or leave a card whose payload is a spreadsheet. The agent
 * is told what holds the key so it can pick another key or the right tool.
 */
function keyClash(key: string, seen: Existing, wanted: string): string {
  const tool = isArtefact(seen.type)
    ? "update_artefact"
    : isProse(seen.type)
      ? "update_card"
      : null;
  return (
    `The key \`${key}\` already belongs to a ${seen.type} (id \`${seen.id}\`) on this mindmap, ` +
    `so it cannot be reused for a ${wanted}. Nothing was changed. ` +
    `Pick a different key` +
    (tool ? `, or change that ${seen.type} with ${tool}.` : ".")
  );
}

/** The first keyed row that would land on a node that is not prose, as a message. */
function proseClash(rows: PreparedRow[], existing: Map<string, Existing>): string | null {
  for (const r of rows) {
    const seen = existing.get(r.key);
    if (seen && !isProse(seen.type)) return keyClash(r.key, seen, "card");
  }
  return null;
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

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Why agents get a file surface at all.
 *
 * An agent's memory already crosses sessions, because it lives in D1 and
 * Vectorize. Its files do not: they sit on whatever machine that session ran
 * on, and the next agent — a different machine, often a different harness —
 * cannot see them. Everything that took work to produce and was written to disk
 * is lost at the end of the turn.
 *
 * So the tool is deliberately shaped around leaving something behind rather
 * than around storage: it insists on a description, and the description is what
 * `recall` will match on months later.
 */

/**
 * The most an agent may upload through a tool call.
 *
 * Far below MAX_FILE_BYTES, and not for storage reasons: this arrives as
 * base64 inside a JSON-RPC envelope, so the bytes are in the model's context
 * on the way out. A megabyte of base64 is a quarter of a million tokens. The
 * browser's upload path streams and has no such ceiling, which is what the
 * refusal points at.
 */
const MCP_MAX_UPLOAD_BYTES = 1_000_000;

/** Enough of a guess to make a text file readable and a binary downloadable. */
const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", yaml: "application/yaml", yml: "application/yaml",
  xml: "application/xml", html: "text/html", css: "text/css", js: "text/javascript",
  ts: "text/plain", py: "text/x-python", sql: "application/sql", sh: "application/x-sh",
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const guessType = (name: string): string => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
};

const readableSize = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} kB`;

async function putFileTool(env: McpEnv, userId: string, args: any) {
  const name = String(args?.name ?? "").trim();
  if (!name) return toolText("Pass `name` — the filename, with its extension.", true);

  const hasText = typeof args?.content === "string";
  const hasBinary = typeof args?.content_base64 === "string";
  if (!hasText && !hasBinary)
    return toolText("Pass `content` for text, or `content_base64` for anything else.", true);
  if (hasText && hasBinary)
    return toolText("Pass one of `content` or `content_base64`, not both.", true);

  let bytes: ArrayBuffer;
  if (hasText) {
    bytes = new TextEncoder().encode(String(args.content)).buffer as ArrayBuffer;
  } else {
    try {
      const raw = atob(String(args.content_base64));
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      bytes = out.buffer;
    } catch {
      return toolText("`content_base64` is not valid base64.", true);
    }
  }

  if (bytes.byteLength > MCP_MAX_UPLOAD_BYTES)
    return toolText(
      `That is ${readableSize(bytes.byteLength)}, over the ${MCP_MAX_UPLOAD_BYTES / 1_000_000} MB a tool call can carry — it travels as base64 through your context. Upload it in the app instead, where it streams.`,
      true,
    );

  const contentType = String(args?.content_type ?? "").trim() || guessType(name);
  const description = String(args?.description ?? "").trim();

  // Into an existing folder, or onto a mindmap as a card of its own.
  const folderId = String(args?.folder_id ?? "").trim();
  if (folderId) {
    const node = await writableNode(env, userId, folderId);
    if (!node) return toolText(`No folder with id ${folderId}.`, true);
    if (!isFileKind(node.type))
      return toolText(`That is a ${node.type}, not a folder.`, true);
    if (node.type === "file")
      return toolText(
        "That card holds a single file. Make a folder if several belong together.",
        true,
      );

    try {
      const row = await storeFile(env as any, {
        nodeId: folderId, kind: "folder", title: node.title ?? "",
        name, contentType, description, size: bytes.byteLength,
        uploadedBy: userId, source: bytes,
      });
      await reindex(env, userId, folderId);
      return toolText(
        `Added **${row.name}** (${readableSize(row.size)}) to ${node.title || "the folder"}.\n\nfile id: \`${row.id}\``,
      );
    } catch (err: any) {
      return toolText(String(err?.message ?? err), true);
    }
  }

  const board = await writableBoard(env, userId, String(args?.mindmap_id ?? ""));
  if (!board)
    return toolText(
      await writeDenial(env, userId, "mindmap", String(args?.mindmap_id ?? "")),
      true,
    );

  /*
   * A folder named rather than identified.
   *
   * An agent producing several related files has a name for the set long
   * before it has a card id, and making it call a separate tool first — then
   * remember the id across turns — is how a folder per file happens instead.
   * Matching on title means the second call lands in the folder the first one
   * made, which is the same idiom as `key` on create_artefact.
   */
  const folderName = String(args?.folder ?? "").trim();
  if (folderName) {
    const found = await env.DB.prepare(
      `SELECT id, title FROM nodes WHERE board_id = ? AND type = 'folder' AND title = ? LIMIT 1`,
    )
      .bind(board.id, folderName)
      .first<{ id: string; title: string }>();

    let folderNodeId = found?.id;
    if (!folderNodeId) {
      folderNodeId = crypto.randomUUID();
      const surface = await boardSurface(env, board.id);
      const placed = prepare(
        [{ key: "a0", type: "card", title: folderName }],
        [],
        placerFor(surface, "right", false),
      ).rows[0];

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO nodes (id,board_id,type,title,body,doc,x,y,w,h,data,created_at,updated_at)
           VALUES (?,?,'folder',?,'',NULL,?,?,260,150,'{}',?,?)`,
        ).bind(folderNodeId, board.id, folderName, placed.x, placed.y, now(), now()),
        env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), board.id),
      ]);
    }

    try {
      const row = await storeFile(env as any, {
        nodeId: folderNodeId, kind: "folder", title: folderName,
        name, contentType, description, size: bytes.byteLength,
        uploadedBy: userId, source: bytes,
      });
      await reindex(env, userId, folderNodeId);
      return toolText(
        `Added **${row.name}** (${readableSize(row.size)}) to ${folderName}` +
          `${found ? "" : " — a new folder"} on ${board.name}.\n\ncard id: \`${folderNodeId}\`\nfile id: \`${row.id}\``,
      );
    } catch (err: any) {
      // A folder this call just made, left empty by a refused upload, is
      // litter. One that was already there stays: it is not ours to remove.
      if (!found) await env.DB.prepare(`DELETE FROM nodes WHERE id = ?`).bind(folderNodeId).run();
      return toolText(String(err?.message ?? err), true);
    }
  }

  const nodeId = crypto.randomUUID();
  const surface = await boardSurface(env, board.id);
  const { rows } = prepare(
    [{ key: "a0", type: "card", title: name }],
    [],
    placerFor(surface, "right", false),
  );
  const at = rows[0];

  // The node first, because `files.node_id` references it, then the file —
  // which also writes the summary and the snapshot back onto the row.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO nodes (id,board_id,type,title,body,doc,x,y,w,h,data,created_at,updated_at)
       VALUES (?,?,'file',?,'',NULL,?,?,260,150,'{}',?,?)`,
    ).bind(nodeId, board.id, name, at.x, at.y, now(), now()),
    env.DB.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).bind(now(), board.id),
  ]);

  try {
    const row = await storeFile(env as any, {
      nodeId, kind: "file", title: name,
      name, contentType, description, size: bytes.byteLength,
      uploadedBy: userId, source: bytes,
    });
    await reindex(env, userId, nodeId);
    return toolText(
      `Stored **${row.name}** (${readableSize(row.size)}) on ${board.name}.\n\ncard id: \`${nodeId}\``,
    );
  } catch (err: any) {
    // The row would otherwise sit on the board as an empty file card with no
    // way to tell it apart from one whose upload is still coming.
    await env.DB.prepare(`DELETE FROM nodes WHERE id = ?`).bind(nodeId).run();
    return toolText(String(err?.message ?? err), true);
  }
}

async function listFilesTool(env: McpEnv, userId: string, args: any) {
  const wanted = String(args?.id ?? "").trim();

  // One argument, either kind of id: an agent holding a mindmap id from recall
  // should not have to discover which of its cards happen to be folders first.
  const node = await readableNode(env, userId, wanted);
  if (node && isFileKind(node.type)) {
    const rows = await filesOf(env as any, wanted);
    if (!rows.length) return toolText(`**${node.title || "Untitled"}** is empty.`);
    return toolText(
      `**${node.title || "Untitled"}**\n\n` +
        rows
          .map(
            (f: FileRow) =>
              `- **${f.name}** · ${readableSize(f.size)} · \`${f.id}\`` +
              (f.description ? `\n  ${f.description}` : ""),
          )
          .join("\n"),
    );
  }

  const board = await readableBoard(env, userId, wanted);
  if (!board) return toolText(`Nothing readable with id ${wanted}.`, true);

  const { results } = await env.DB.prepare(
    `SELECT n.id, n.title, n.type, COUNT(f.id) AS files, COALESCE(SUM(f.size),0) AS bytes
       FROM nodes n LEFT JOIN files f ON f.node_id = n.id
      WHERE n.board_id = ? AND n.type IN ('file','folder')
      GROUP BY n.id ORDER BY n.updated_at DESC`,
  )
    .bind(board.id)
    .all<any>();

  const rows = results ?? [];
  if (!rows.length) return toolText(`No files on ${board.name} yet.`);

  return toolText(
    `Files on **${board.name}**\n\n` +
      rows
        .map(
          (r: any) =>
            `- ${r.type === "folder" ? "📁" : "📄"} **${r.title || "Untitled"}** · ` +
            `${r.files} file${r.files === 1 ? "" : "s"} · ${readableSize(r.bytes)} · \`${r.id}\``,
        )
        .join("\n"),
  );
}

async function readFileTool(env: McpEnv, userId: string, args: any) {
  const wanted = String(args?.id ?? "").trim();

  // Accept either a file id or the card id of a single-file node, because an
  // agent that has just been handed a card id from recall has no reason to
  // know there is a second kind of identifier underneath it.
  let row = await fileById(env as any, wanted);
  if (row) {
    const node = await readableNode(env, userId, row.node_id);
    if (!node) return toolText(`No file with id ${wanted}.`, true);
  } else {
    const node = await readableNode(env, userId, wanted);
    if (!node || !isFileKind(node.type)) return toolText(`No file with id ${wanted}.`, true);
    const rows = await filesOf(env as any, wanted);
    if (rows.length !== 1)
      return toolText(
        rows.length
          ? `That folder holds ${rows.length} files. Call list_files and read one by its file id.`
          : "That card holds no files yet.",
        true,
      );
    row = rows[0];
  }

  if (!isTextual(row.name, row.content_type)) {
    const url = await fileUrl(env as any, row.id);
    return toolText(
      `**${row.name}** is ${row.content_type}, which has no text to return.` +
        (row.description ? `\n\n${row.description}` : "") +
        (url ? `\n\nDownload (expires in an hour): ${url}` : ""),
    );
  }

  const obj = await env.ARTEFACTS.get(row.r2_key);
  if (!obj) return toolText(`**${row.name}** is no longer stored.`, true);

  const text = await obj.text();
  return toolText(`**${row.name}**\n\n\`\`\`\n${text}\n\`\`\``);
}
