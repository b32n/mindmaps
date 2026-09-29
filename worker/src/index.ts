import { Anthropic, textFromEvents, type Repo } from "./anthropic";
import {
  SESSION_COOKIE, clearCookie, createSession, destroySession, hashPassword,
  passwordProblems, readCookie, sessionCookie, userForToken, verifyPassword,
  type SessionUser,
} from "./auth";
import { handleMcp, rankRecall, reindexPage, requiredScopeFor, sweepDirty } from "./mcp";
import {
  authorize, authorizationServerMetadata, checkBearer, denyPage, insufficientScope, issuerOf,
  protectedResourceMetadata, registerClient, revoke, token as tokenEndpoint, unauthorized,
} from "./oauth";
import { removeCards } from "./semantic";
import { reapTrash, untrashNode, type TrashEnv } from "./r2trash";
import {
  BOARD_READABLE, NODE_READABLE, boardRole, canAdmin, canWrite, ensurePersonalWorkspace,
  nodeRole, workspaceRole, workspacesFor, type Role,
} from "./access";
import { fileUrl, frameUrl, serveFile, serveMindbox, type MindboxEnv } from "./mindbox";
import {
  FileError, fileById, filesOf, isFileKind, refreshFileNode, removeFile, storeFile, toMeta,
  wantsSnippet,
} from "./files";
import {
  canGrant, claimInvites, invite, membersOf, removeMember, revokeInvite, type Target,
} from "./members";
import {
  createShare, noteView, resolveShare, revokeShare, sharesFor, type ShareEnv,
} from "./shares";
import {
  archiveBoard, archiveNode, emptyTrash, listTrash, purgeTrash, restoreFileRows, restoreTrash,
  sweepTrash,
} from "./trash";
import {
  ARTEFACT_SQL, INDEXABLE_SQL, artefactKey, getArtefact, isArtefact, payloadFromInput,
  putArtefact,
  type ArtefactKind,
} from "./artefacts";
import { blocksToMarkdown, parseDoc } from "./markdown";
import { createStarterBoard } from "./starter";

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  /** artefact payloads, keyed `artefacts/<nodeId>` */
  ARTEFACTS: R2Bucket;
  /** either of these authenticates to Anthropic; see README */
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_AGENT_ID?: string;
  ANTHROPIC_ENVIRONMENT_ID?: string;
  GITHUB_TOKEN?: string; // fine-grained PAT, Contents: Read only
  ALLOWED_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** where the browser lands after Google sends us back */
  APP_ORIGIN?: string;
  /** stable public origin; see issuerOf in oauth.ts */
  PUBLIC_ORIGIN?: string;
  /**
   * The mindbox: where HTML artefacts run, and the key their URLs are signed
   * with.
   *
   * Both absent means the type is unavailable rather than insecure: the frame
   * endpoint 503s and the mindbox refuses to serve. That is the correct failure —
   * serving author-written script from the app's own origin would hand it the
   * session cookie. See mindbox.ts.
   */
  MINDBOX_ORIGIN?: string;
  MINDBOX_SECRET?: string;
  /** semantic recall; absent locally, where recall falls back to keywords */
  AI?: Ai;
  VECTORS?: VectorizeIndex;
}

const id = () => crypto.randomUUID();
const now = () => Date.now();

/**
 * The markdown projection of a document, derived here rather than trusted.
 *
 * `body` is what FTS indexes and what the embeddings are built from, so it has
 * to be the whole document as markdown. The browser editor used to send its own
 * `body` — a plain-text join with `·` separators, clipped to 500 characters —
 * which meant a card edited in the app was searchable and recallable only on
 * its opening paragraph. Four cards in production were sitting at exactly 500
 * characters when this was found.
 *
 * Deriving it server-side from `doc` means there is one implementation and no
 * client can get it wrong. A `body` sent by a caller alongside a `doc` is
 * ignored.
 */
const bodyFromDoc = (doc: unknown): string =>
  typeof doc === "string" ? blocksToMarkdown(parseDoc(doc)) : "";

/**
 * Whether a newly written node needs embedding, as an `index_dirty` value.
 *
 * Only cards and notes are retrievable, and a node with neither title nor prose
 * has nothing to embed — marking it would queue a sweep that finds nothing to
 * do. Returns null (clean) in both cases.
 */
const markIndex = (type: string, title: string, body: string): number | null =>
  (type === "card" || type === "note") && (title?.trim() || body?.trim()) ? now() : null;

/**
 * Nodes plus the one fact that isn't on the row: whether the card has a
 * research thread. Checklist progress is derived from the doc on the client.
 */
const NODES_WITH_STATE = `
  SELECT n.*,
    (SELECT s.status FROM sessions s
      WHERE s.node_id = n.id
      ORDER BY s.created_at DESC LIMIT 1)            AS thread
  FROM nodes n
  WHERE n.board_id = ?
`;

const cors = (env: Env) => ({
  "access-control-allow-origin": env.ALLOWED_ORIGIN ?? "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  // Authorization and the MCP transport headers are needed by any MCP client
  // running in a browser; the app itself only needs content-type.
  "access-control-allow-headers":
    "content-type, authorization, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id",
  // the session cookie must survive a cross-origin call in dev
  "access-control-allow-credentials": "true",
});

const json = (env: Env, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(env) },
  });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    const url = new URL(req.url);
    const seg = url.pathname.split("/").filter(Boolean); // ["api", ...]

    try {
      // HTML artefacts, served from the mindbox. Dispatched first and
      // deliberately without a session: this path authenticates with a signed,
      // expiring URL because the origin it answers on must never hold a cookie.
      // See mindbox.ts for why.
      const framed = await serveMindbox(req, env as unknown as MindboxEnv, url);
      if (framed) return framed;

      // Uploaded files leave by the same door and for the same reason: some of
      // them are documents that can run script, and script must never run on
      // the origin holding the session cookie.
      const download = await serveFile(req, env as unknown as MindboxEnv, url);
      if (download) return download;

      // The MCP surface sits at the root, outside /api, and authenticates with
      // an OAuth bearer token rather than the browser session cookie. It has to
      // be dispatched before the cookie gate below, which would 401 it.
      const mcp = await mcpSurface(req, env, url, seg);
      if (mcp) return mcp;

      /*
       * Shared artefacts, read without a session.
       *
       * Dispatched above the cookie gate on purpose: a share link has to work
       * for someone who has no account, so it must not be reachable only by
       * being signed in. Authorisation is the token itself, and the resolver
       * returns one artefact and nothing around it.
       */
      if (seg[0] === "api" && seg[1] === "shared" && seg[2] && req.method === "GET") {
        const token = seg[2];
        const found = await resolveShare(env as unknown as ShareEnv, token, {
          withPayload: true,
        });
        if (!found) return json(env, { error: "This link is not available." }, 404);
        ctx.waitUntil(noteView(env as unknown as ShareEnv, token));
        return json(env, {
          kind: found.kind,
          title: found.title,
          payload: found.payload,
          // The mindbox renders pages; the viewer only needs somewhere to point.
          frame:
            found.kind === "html"
              ? `${env.MINDBOX_ORIGIN ?? ""}/s/${found.nodeId}?t=${encodeURIComponent(token)}`
              : null,
        });
      }

      const user = await userForToken(env.DB, readCookie(req, SESSION_COOKIE));

      // auth endpoints are the only ones reachable signed-out
      if (seg[1] === "auth") return await authRoute(req, env, seg, user);

      if (!user) return json(env, { error: "not signed in" }, 401);
      return await route(req, env, seg, user);
    } catch (err: any) {
      console.error(err);
      return json(env, { error: String(err?.message ?? err) }, 500);
    }
  },

  /**
   * Re-embed cards edited in the browser.
   *
   * The write marks the row; this does the inference a moment later, so a burst
   * of debounced PATCHes from one typing session becomes a single embedding of
   * the final text rather than one per pause. See 0018.
   *
   * Bounded per tick: a sweep is a burst of Workers AI calls and the point is
   * to keep it small and frequent. Anything left over is picked up next minute,
   * oldest first, so nothing starves.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sweepDirty(env as Parameters<typeof sweepDirty>[0]).then(
        (n) => {
          if (n) console.log(`reindexed ${n} edited card${n === 1 ? "" : "s"}`);
        },
        (err) => console.error("dirty sweep failed", err),
      ),
    );
    // Deleted R2 objects, once past the retention window and still referenced by
    // nothing. Independent of the reindex above: neither should be able to stop
    // the other from running.
    ctx.waitUntil(
      reapTrash(env as unknown as TrashEnv).then(
        (n) => {
          if (n) console.log(`reaped ${n} expired object${n === 1 ? "" : "s"}`);
        },
        (err) => console.error("trash reap failed", err),
      ),
    );
    // The archived rows themselves. Kept separate from the object reap above so
    // a failure in either cannot strand the other: the row sweep is a plain
    // delete, the object reap talks to R2 and can fail transiently.
    ctx.waitUntil(
      sweepTrash(env as unknown as TrashEnv).then(
        (n) => {
          if (n) console.log(`purged ${n} expired trash entr${n === 1 ? "y" : "ies"}`);
        },
        (err) => console.error("trash sweep failed", err),
      ),
    );
  },
};

/**
 * The MCP server and the OAuth endpoints that protect it.
 *
 * Returns null when the path isn't ours, so the normal app routing continues.
 * Everything here lives at the root rather than under /api because the OAuth
 * discovery paths are fixed by RFC 9728 / RFC 8414 and the MCP endpoint URL is
 * what a user pastes into `claude mcp add`.
 */
async function mcpSurface(
  req: Request,
  env: Env,
  url: URL,
  seg: string[],
): Promise<Response | null> {
  const m = req.method;

  // --- discovery -----------------------------------------------------------
  // RFC 9728 defines both a path-suffixed form (for a resource with a path) and
  // the bare one. Clients differ on which they try, so serve both.
  if (seg[0] === ".well-known") {
    const doc = seg[1];
    if (doc === "oauth-protected-resource") return protectedResourceMetadata(req, env);
    if (doc === "oauth-authorization-server" || doc === "openid-configuration")
      return authorizationServerMetadata(req, env);
    return null;
  }

  // --- authorization server ------------------------------------------------
  // All under /oauth. `/register` was tempting and wrong: it is also the app's
  // sign-up route, and serving both from one origin made the Worker shadow the
  // page.
  if (seg[0] === "oauth") {
    if (seg[1] === "register" && m === "POST") return await registerClient(req, env.DB);
    if (seg[1] === "authorize" && (m === "GET" || m === "POST")) return await authorize(req, env);
    if (seg[1] === "token" && m === "POST") return await tokenEndpoint(req, env);
    if (seg[1] === "revoke" && m === "POST") return await revoke(req, env);
    if (seg[1] === "deny") return denyPage();
    return null;
  }

  // --- the MCP endpoint ----------------------------------------------------
  if (seg[0] !== "mcp" || seg.length !== 1) return null;

  // Origin check guards against DNS rebinding: a page in someone's browser
  // must not be able to drive a local MCP server. Requests from a real harness
  // carry no Origin at all, which is why absence is allowed.
  const origin = req.headers.get("origin");
  if (origin && origin !== issuerOf(req, env) && origin !== env.ALLOWED_ORIGIN && origin !== env.APP_ORIGIN)
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "bad origin" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });

  // This revision has no GET stream and no sessions to delete.
  if (m === "GET" || m === "DELETE")
    return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS" } });
  if (m !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS" } });

  // Peek at the method to decide which scope this request needs, so the 401
  // challenge asks for the minimum rather than everything.
  const raw = await req.text();
  let peeked: any = null;
  try {
    peeked = JSON.parse(raw);
  } catch {
    /* handleMcp reports the parse error properly */
  }
  const wanted =
    peeked?.method === "tools/call" && peeked?.params?.name
      ? requiredScopeFor(String(peeked.params.name))
      : "mindmaps:read";

  const check = await checkBearer(req, env.DB, env);
  if (!check.ok) {
    const why = {
      missing: undefined,
      invalid: "token not recognised",
      expired: "token expired",
      audience: "token was not issued for this server",
    }[check.reason];
    return unauthorized(req, env, `mindmaps:read mindmaps:write`, why);
  }
  if (!check.grant.scopes.includes(wanted)) return insufficientScope(req, env, wanted);

  // hand the already-read body onward
  return await handleMcp(new Request(req, { body: raw }), env, check.grant);
}

async function route(req: Request, env: Env, seg: string[], user: SessionUser): Promise<Response> {
  const [, a, b, c, d] = seg; // seg[0] === "api"
  const m = req.method;

  // --- boards --------------------------------------------------------------

  if (a === "boards" && !b && m === "GET") {
    // Pinned first, then manual order; recency only breaks ties among rows that
    // never got a position. Dragging is an explicit statement about where
    // something belongs, so it must not be undone by touching a card, and
    // pinning is a second such statement that outranks it.
    const { results } = await env.DB.prepare(
      // `shared_with` counts people given this one mindmap directly. Workspace
      // members are deliberately not counted: everything in a workspace is
      // visible to everyone in it, so a badge on every board would say nothing.
      // The signal worth showing is "this one has been handed to someone".
      `SELECT b.*,
              (SELECT COUNT(*) FROM board_shares bs WHERE bs.board_id = b.id) AS shared_with
         FROM boards b
        WHERE b.parent_id IS NULL AND ${BOARD_READABLE("b")}
        ORDER BY b.pinned DESC, b.position IS NULL, b.position ASC, b.updated_at DESC`,
    )
      .bind(user.id)
      .all();
    return json(env, results.map(hydrateBoard));
  }

  /**
   * Recall, for a person.
   *
   * The same `rankRecall` the MCP tool runs, returned as data instead of
   * markdown. One pipeline, two presentations: a second ranking for the UI
   * would drift from the agent's within a week, and then "you and your agent
   * see the same thing" stops being true.
   */
  if (a === "recall" && !b && m === "GET") {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return json(env, { hits: [], found: 0 });
    const scope = url.searchParams.get("mindmap_id");
    // The workspace the user is looking at, so recall stays one vector query
    // and never mixes work with personal context. Absent means "everywhere",
    // which is what an agent gets.
    const ws = url.searchParams.get("workspace");
    const result = await rankRecall(env, user.id, q, scope || null, 1, ws || null);
    return json(env, result);
  }

  /**
   * Rebuild `body` as markdown from `doc`, a page at a time.
   *
   * One-off repair for documents written before the derivation above existed.
   * Anything the browser editor saved has a `body` that is plain text clipped
   * to 500 characters, so those cards are missing from search and from recall
   * below their opening paragraph.
   *
   * Marks every card it rewrites as dirty, because the embeddings were built
   * from the truncated text and are wrong in exactly the same way. The sweep
   * picks them up.
   */
  if (a === "remarkdown" && !b && m === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const after = body?.after ? String(body.after) : null;
    const limit = Math.max(1, Math.min(200, Number(body?.limit) || 100));

    const { results } = await env.DB.prepare(
      `SELECT n.id, n.doc, n.body
         FROM nodes n JOIN boards b ON b.id = n.board_id
        WHERE ${BOARD_READABLE("b")}
          AND n.type IN (${INDEXABLE_SQL})
          AND n.doc IS NOT NULL AND n.doc != '' AND n.doc != '[]'
          AND (? IS NULL OR n.id > ?)
        ORDER BY n.id
        LIMIT ?`,
    )
      .bind(user.id, after, after, limit)
      .all<{ id: string; doc: string; body: string }>();

    const rows = results ?? [];
    const changed = rows
      .map((r) => ({ id: r.id, body: bodyFromDoc(r.doc), was: r.body ?? "" }))
      .filter((r) => r.body !== r.was);

    if (changed.length)
      await env.DB.batch(
        changed.map((r) =>
          env.DB.prepare(`UPDATE nodes SET body = ?, index_dirty = ? WHERE id = ?`)
            .bind(r.body, now(), r.id),
        ),
      );

    return json(env, {
      scanned: rows.length,
      rewritten: changed.length,
      next: rows.length ? rows[rows.length - 1].id : null,
      done: rows.length < limit,
    });
  }

  /**
   * Re-embed this account's cards, a page at a time.
   *
   * Scoped to the caller: there is no all-users variant, because "re-run
   * inference over everyone's data" is not an action a web request should be
   * able to start. Pump `next` until `done` — see the README.
   */
  if (a === "reindex" && !b && m === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const after = body?.after ? String(body.after) : null;
    const limit = Math.max(1, Math.min(50, Number(body?.limit) || 25));
    const page = await reindexPage(env, user.id, after, limit);
    return json(env, { ...page, count: page.processed.length });
  }

  if (a === "boards" && !b && m === "POST") {
    const body = await req.json<any>();
    // One above whatever is currently first, so a new mindmap appears at the
    // top without renumbering everything else.
    const top = await env.DB.prepare(
      `SELECT COALESCE(MIN(position), 0) AS top FROM boards
        WHERE user_id = ? AND parent_id IS NULL`,
    )
      .bind(user.id)
      .first<{ top: number }>();
    /*
     * Which workspace this lands in.
     *
     * The caller may name one, but only one they can write to — otherwise
     * creating a mindmap would be a way to write into someone else's space.
     * Anything unnamed or unauthorised falls back to the personal workspace,
     * which every account has and whose id is the user's own.
     */
    let workspaceId = await ensurePersonalWorkspace(env.DB, user.id);
    if (body.workspace_id && body.workspace_id !== workspaceId) {
      const role = await workspaceRole(env.DB, user.id, String(body.workspace_id));
      if (!canWrite(role))
        return json(env, { error: "You cannot add mindmaps to that workspace." }, 403);
      workspaceId = String(body.workspace_id);
    }

    const board = {
      id: id(),
      name: body.name ?? "Untitled mindmap",
      status: body.status ?? "active",
      parent_id: body.parent_id ?? null,
      node_id: body.node_id ?? null,
      created_at: now(),
      updated_at: now(),
      user_id: user.id,
      position: (top?.top ?? 0) - 1,
      description: body.description ?? null,
      labels: normaliseLabels(body.labels),
      pinned: body.pinned ? 1 : 0,
      workspace_id: workspaceId,
    };
    await env.DB.prepare(
      `INSERT INTO boards (id,name,status,parent_id,node_id,created_at,updated_at,user_id,position,description,labels,pinned,workspace_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(...Object.values(board))
      .run();
    return json(env, hydrateBoard(board), 201);
  }

  /**
   * Rewrite the rail order.
   *
   * Takes the full ordered list rather than a moved-item delta: the client
   * already knows the order it just rendered, and sending it whole means a
   * dropped request can never leave the list half-renumbered. Ids the caller
   * doesn't own are ignored rather than rejected, so a stale tab can't
   * renumber someone else's boards.
   */
  /*
   * Rail order.
   *
   * `position` and `pinned` are columns on the board, which was right when a
   * board had exactly one reader. Shared, they are a shared preference: two
   * people dragging the same mindmap fight over one column, and pinning it
   * pins it for everyone.
   *
   * Left shared for now rather than quietly making a member's drag do nothing.
   * The real fix is a `board_prefs(user_id, board_id, position, pinned)` table
   * so ordering is per person, which is a migration and a merge rule, not a
   * filter change — noted in TODO.md.
   */
  if (a === "boards" && b === "reorder" && m === "POST") {
    const { ids } = await req.json<{ ids?: unknown }>();
    if (!Array.isArray(ids)) return json(env, { error: "ids must be an array" }, 400);

    const { results } = await env.DB.prepare(
      `SELECT b.id FROM boards b
        WHERE b.parent_id IS NULL AND ${BOARD_READABLE("b")}`,
    )
      .bind(user.id)
      .all<{ id: string }>();
    const mine = new Set((results ?? []).map((r) => r.id));

    const ordered = ids.filter((v): v is string => typeof v === "string" && mine.has(v));
    if (!ordered.length) return json(env, { ok: true });

    await env.DB.batch(
      ordered.map((id, i) =>
        // Rail order is a shared column, not a per-user preference — see the
        // note above this route. Restricted to boards you can write so a viewer
        // cannot rearrange someone else's sidebar.
        env.DB.prepare(
          `UPDATE boards SET position = ?1
            WHERE id = ?2 AND ${BOARD_READABLE("boards", 3)}`,
        )
          .bind(i, id, user.id),
      ),
    );
    return json(env, { ok: true, count: ordered.length });
  }

  if (a === "boards" && b && !c && m === "PATCH") {
    const p = await req.json<any>();
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const k of ["name", "status", "home_view", "description"]) {
      if (p[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(p[k]);
      }
    }
    if (p.labels !== undefined) {
      sets.push("labels = ?");
      vals.push(normaliseLabels(p.labels));
    }
    if (p.pinned !== undefined) {
      sets.push("pinned = ?");
      vals.push(p.pinned ? 1 : 0);
    }
    if (!sets.length) return json(env, { ok: true });
    sets.push("updated_at = ?");
    vals.push(now(), b);
    {
      const deny = await requireBoardAdmin(env, user, b);
      if (deny) return deny;
    }
    await env.DB.prepare(`UPDATE boards SET ${sets.join(",")} WHERE id = ?`)
      .bind(...vals)
      .run();
    const updated = await env.DB.prepare(`SELECT * FROM boards WHERE id = ?`)
      .bind(b)
      .first();
    return json(env, hydrateBoard(updated));
  }

  // ON DELETE CASCADE clears this board's nodes, edges, strokes and any
  // sub-boards their cards owned — which is exactly why it is archived first.
  // This was the most destructive action in the app: it took every sheet on the
  // mindmap with it and left their R2 objects orphaned, with no way back.
  if (a === "boards" && b && !c && m === "DELETE") {
    {
      const deny = await requireBoardAdmin(env, user, b);
      if (deny) return deny;
    }
    await archiveBoard(env, user.id, b);

    // Vectors live in Vectorize and know nothing about this delete. Left
    // behind, they keep returning cards that no longer exist.
    const doomed = await env.DB.prepare(`SELECT id FROM nodes WHERE board_id = ?`)
      .bind(b)
      .all<{ id: string }>();
    await env.DB.prepare(`DELETE FROM boards WHERE id = ?`).bind(b).run();
    const ids = (doomed.results ?? []).map((r) => r.id);
    if (ids.length) await removeCards(env, ids);
    return json(env, { ok: true });
  }

  // --- trash ---------------------------------------------------------------

  // --- workspaces and members ---------------------------------------------

  if (a === "workspaces" && !b && m === "GET") {
    await ensurePersonalWorkspace(env.DB, user.id);
    return json(env, await workspacesFor(env.DB, user.id));
  }

  if (a === "workspaces" && !b && m === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const name = String(body?.name ?? "").trim() || "New workspace";
    const wsId = id();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_id, personal, created_at) VALUES (?,?,?,0,?)`,
    )
      .bind(wsId, name, user.id, now())
      .run();
    return json(env, { id: wsId, name, owner_id: user.id, personal: 0, role: "owner" }, 201);
  }

  /*
   * Members of a workspace, mindmap or artefact.
   *
   * One route shape for all three because the question is identical — who can
   * see this — and only the table differs. `canGrant` is what encodes that
   * workspaces and mindmaps are owner-only while an artefact can be passed on
   * by anyone who may edit it.
   */
  if ((a === "workspaces" || a === "boards" || a === "artefacts") && b && c === "members") {
    const target: Target = a === "workspaces" ? "workspace" : a === "boards" ? "board" : "node";

    if (m === "GET") {
      if (!(await canGrant(env, user.id, target, b)))
        return json(env, { error: "not found" }, 404);
      return json(env, await membersOf(env, target, b));
    }

    if (m === "POST") {
      if (!(await canGrant(env, user.id, target, b)))
        return json(env, { error: "You cannot share that." }, 403);
      const body = await req.json<any>().catch(() => ({}));
      const role = body?.role === "viewer" ? "viewer" : "editor";
      const result = await invite(env, user.id, target, b, String(body?.email ?? ""), role);
      if (!result) return json(env, { error: "That does not look like an email address." }, 400);
      return json(env, result, 201);
    }
  }

  if ((a === "workspaces" || a === "boards" || a === "artefacts") && b && c === "members" && d && m === "DELETE") {
    const target: Target = a === "workspaces" ? "workspace" : a === "boards" ? "board" : "node";
    // Leaving is always allowed; removing someone else needs the right to grant.
    if (d !== user.id && !(await canGrant(env, user.id, target, b)))
      return json(env, { error: "You cannot change who has access." }, 403);
    const gone = await removeMember(env, target, b, d);
    return gone ? json(env, { ok: true }) : json(env, { error: "not found" }, 404);
  }

  if (a === "invites" && b && m === "DELETE") {
    const gone = await revokeInvite(env, user.id, b);
    return gone ? json(env, { ok: true }) : json(env, { error: "not found" }, 404);
  }

  // --- shares -------------------------------------------------------------

  if (a === "artefacts" && b && c === "share" && m === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const share = await createShare(env as unknown as ShareEnv, user.id, b, {
      expiresAt: typeof body?.expires_at === "number" ? body.expires_at : null,
    });
    if (!share) return json(env, { error: "not found" }, 404);
    return json(env, { ...share, url: `${appOrigin(env)}/v/${share.token}` }, 201);
  }

  if (a === "artefacts" && b && c === "share" && m === "GET") {
    const rows = await sharesFor(env as unknown as ShareEnv, user.id, b);
    return json(
      env,
      rows.map((r) => ({ ...r, url: `${appOrigin(env)}/v/${r.token}` })),
    );
  }

  if (a === "shares" && b && m === "DELETE") {
    const gone = await revokeShare(env as unknown as ShareEnv, user.id, b);
    return gone ? json(env, { ok: true }) : json(env, { error: "not found" }, 404);
  }

  // Every artefact the user owns, newest first.
  //
  // Flat and across all mindmaps on purpose: an artefact is a thing you come
  // back to, and the board it happens to sit on is often the part you have
  // forgotten. `data` carries the counts, so the list describes each one
  // without reading a single R2 object.
  if (a === "artefacts" && !b && m === "GET") {
    const rows = await env.DB.prepare(
      `SELECT n.id, n.type, n.title, n.data, n.updated_at,
              b.id AS board_id, b.name AS board_name
         FROM nodes n
         JOIN boards b ON b.id = n.board_id
        WHERE ${NODE_READABLE("n", "b")} AND n.type IN (${ARTEFACT_SQL})
        ORDER BY n.updated_at DESC
        LIMIT 300`,
    )
      .bind(user.id)
      .all<any>();
    return json(
      env,
      (rows.results ?? []).map((r) => ({ ...r, data: JSON.parse(r.data || "{}") })),
    );
  }

  // A signed URL for rendering an HTML artefact. Ownership is checked here,
  // where there is a session; the mindbox has none and trusts only the
  // signature this produces.
  if (a === "artefacts" && b && c === "frame" && m === "GET") {
    if (!(await canReadNode(env, user, b))) return json(env, { error: "not found" }, 404);
    const href = await frameUrl(env as unknown as MindboxEnv, b);
    if (!href)
      return json(
        env,
        { error: "HTML artefacts are not configured on this deployment." },
        503,
      );
    return json(env, { url: href });
  }

  if (a === "trash" && !b && m === "GET") {
    return json(env, await listTrash(env, user.id));
  }

  if (a === "trash" && b && c === "restore" && m === "POST") {
    const res = await restoreTrash(env, user.id, b);
    if (!res.ok)
      return json(env, { error: res.error ?? "not found" }, res.error === "not found" ? 404 : 409);
    return json(env, { ok: true, board_id: res.boardId });
  }

  if (a === "trash" && b === "empty" && m === "POST") {
    return json(env, { ok: true, removed: await emptyTrash(env, user.id) });
  }

  if (a === "trash" && b && !c && m === "DELETE") {
    const gone = await purgeTrash(env, user.id, b);
    return gone ? json(env, { ok: true }) : json(env, { error: "not found" }, 404);
  }

  /**
   * Just enough of a board to populate a menu: id, title, type.
   *
   * Separate from `contents` because that carries every card's full BlockNote
   * document — on a large board that is hundreds of kilobytes to render a list
   * of titles.
   */
  if (a === "boards" && b && c === "cards" && m === "GET") {
    if (!(await canReadBoard(env, user, b))) return json(env, { error: "no such board" }, 404);
    const { results } = await env.DB.prepare(
      `SELECT id, title, type FROM nodes
        WHERE board_id = ? AND type IN (${INDEXABLE_SQL})
        ORDER BY updated_at DESC`,
    )
      .bind(b)
      .all();
    return json(env, results ?? []);
  }

  // full board contents: nodes + edges + strokes
  if (a === "boards" && b && c === "contents" && m === "GET") {
    if (!(await canReadBoard(env, user, b))) return json(env, { error: "no such board" }, 404);
    const [board, nodes, edges] = await Promise.all([
      env.DB.prepare(`SELECT b.*,
                (SELECT COUNT(*) FROM board_shares bs WHERE bs.board_id = b.id) AS shared_with
           FROM boards b WHERE b.id = ?`).bind(b).first(),
      // child_count and thread make a card's contents legible without opening it
      env.DB.prepare(NODES_WITH_STATE).bind(b).all(),
      // Either endpoint on this board. A link whose far end lives on another
      // mindmap still belongs here — it renders as a stub pointing off-canvas,
      // which is how a mindmap stops being an island.
      env.DB.prepare(
        `SELECT e.id, e.source_id, e.target_id, e.label,
                e.source_handle, e.target_handle,
                sn.board_id AS source_board, tn.board_id AS target_board,
                sn.title    AS source_title, tn.title    AS target_title,
                sb.name     AS source_board_name, tb.name AS target_board_name
           FROM edges e
           JOIN nodes  sn ON sn.id = e.source_id
           JOIN nodes  tn ON tn.id = e.target_id
           JOIN boards sb ON sb.id = sn.board_id
           JOIN boards tb ON tb.id = tn.board_id
          WHERE sn.board_id = ? OR tn.board_id = ?`,
      )
        .bind(b, b)
        .all(),
    ]);
    if (!board) return json(env, { error: "no such board" }, 404);
    return json(env, {
      board: hydrateBoard(board),
      nodes: (nodes.results ?? []).map(hydrateNode),
      edges: edges.results ?? [],
    });
  }

  // --- nodes ---------------------------------------------------------------

  if (a === "nodes" && !b && m === "POST") {
    const p = await req.json<any>();
    {
      const deny = await requireBoardWrite(env, user, p.board_id);
      if (deny) return deny;
    }
    const node = {
      // caller may supply an id so undo/redo can restore the same node and
      // keep any edges that reference it valid
      id: p.id ?? id(),
      board_id: p.board_id,
      type: p.type ?? "note",
      title: p.title ?? "",
      // Derived, never taken from the caller when a document is present.
      body: p.doc ? bodyFromDoc(p.doc) : (p.body ?? ""),
      doc: p.doc ?? null,
      x: p.x ?? 0,
      y: p.y ?? 0,
      w: p.w ?? 260,
      h: p.h ?? 140,
      data: JSON.stringify(p.data ?? {}),
      created_at: now(),
      updated_at: now(),
    };
    // An artefact's bytes go to R2 and the row keeps a pointer, a summary and
    // the text snapshot the brain reads.
    if (isArtefact(node.type)) {
      // A create that carries a pointer and no payload is a *restore* — undo
      // replays the node it captured, whose `data` is `{r2,kind,...}`. Treating
      // that as "no payload given, make a blank one" is what used to overwrite
      // the real workbook with an empty grid and call it a successful undo.
      const authored = p.sheets ?? p.blocks ?? p.slides ?? p.html;
      const restoring = !p.data?.workbook && !authored && typeof p.data?.r2 === "string";
      if (restoring) await untrashNode(env, node.id);

      const existing = restoring ? await getArtefact(env, node.id) : null;
      if (restoring && !existing)
        return json(
          env,
          { error: "That artefact's contents are gone and cannot be restored." },
          410,
        );

      // Recompute the pointer and snapshot from the bytes rather than trusting
      // the caller's copy, so a restored row can never describe something the
      // object does not say.
      const kind = node.type as ArtefactKind;
      const payload =
        existing ??
        p.data?.workbook ??
        payloadFromInput(kind, node.title, {
          sheets: p.sheets,
          blocks: p.blocks,
          slides: p.slides,
          html: p.html,
        });
      const stored = await putArtefact(env, node.id, kind, payload);
      node.data = JSON.stringify(stored.data);
      node.body = stored.body;
    } else if (node.type === "image") {
      // Same restore case, one bucket over.
      await untrashNode(env, node.id);
    } else if (isFileKind(node.type)) {
      // Undo of a file or folder. The bytes were only filed, so un-filing them
      // here is enough to save them. The rows that say what those bytes *are*
      // cascaded with the node and have to wait until it is back — see below.
      await untrashNode(env, node.id);
    }

    await env.DB.prepare(
      `INSERT INTO nodes (id,board_id,type,title,body,doc,x,y,w,h,data,created_at,updated_at,index_dirty)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(...Object.values(node), markIndex(node.type, node.title, node.body))
      .run();

    /*
     * A restored file node's rows, put back after the node itself.
     *
     * Strictly after the INSERT, because `files.node_id` is a foreign key: run
     * before it and the whole restore fails with a constraint error, which is
     * exactly what it did the first time this was written. The rows come from
     * the archive rather than from the caller, so an undo cannot invent a file
     * that was never there.
     */
    if (isFileKind(node.type)) {
      const back = await restoreFileRows(env, node.id);
      if (back) {
        const refreshed = await refreshFileNode(env, node.id, node.type, node.title);
        node.data = JSON.stringify(refreshed.data);
        node.body = refreshed.body;
      }
    }

    return json(env, hydrateNode(node), 201);
  }

  if (a === "nodes" && b && m === "PATCH") {
    {
      const deny = await requireNodeWrite(env, user, b);
      if (deny) return deny;
    }
    const p = await req.json<any>();
    const allowed = ["title", "body", "doc", "x", "y", "w", "h", "type"];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const k of allowed) {
      if (p[k] === undefined) continue;
      // A `doc` always wins: the markdown projection is derived from it here so
      // there is one implementation of that conversion, not one per client.
      if (k === "body" && p.doc !== undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(k === "body" ? p[k] : p[k]);
    }
    if (p.doc !== undefined) {
      sets.push("body = ?");
      vals.push(bodyFromDoc(p.doc));
    }
    if (p.data !== undefined) {
      sets.push("data = ?");
      vals.push(JSON.stringify(p.data));
    }
    if (!sets.length) return json(env, { ok: true });
    sets.push("updated_at = ?");
    vals.push(now());

    // Mark for re-embedding only when the *prose* changed. A drag sends x/y on
    // every drop, and a resize sends w/h; marking on those would queue an
    // inference call for moving a card across the canvas. `title`, `body` and
    // `doc` are the only fields the index is derived from.
    if (["title", "body", "doc"].some((k) => p[k] !== undefined)) {
      sets.push("index_dirty = ?");
      vals.push(now());
    }

    vals.push(b);
    await env.DB.prepare(`UPDATE nodes SET ${sets.join(",")} WHERE id = ?`)
      .bind(...vals)
      .run();
    return json(env, { ok: true });
  }

  // One node, for a route that opens a single artefact and needs its title
  // without fetching the board it sits on.
  if (a === "nodes" && b && !c && m === "GET") {
    if (!(await canReadNode(env, user, b))) return json(env, { error: "not found" }, 404);
    const row = await env.DB.prepare(`SELECT * FROM nodes WHERE id = ?`).bind(b).first();
    return row ? json(env, hydrateNode(row)) : json(env, { error: "not found" }, 404);
  }

  /**
   * The artefact payload, for the editor route.
   *
   * Deliberately not part of `/boards/:id/contents`. That query is
   * `SELECT n.*`, so a board holding several sheets would ship all of them on
   * open. The board gets a pointer and a summary; only the editor fetches
   * bytes, and only for the one node it is showing.
   */
  if (a === "artefacts" && b && !c && m === "GET") {
    if (!(await canReadNode(env, user, b))) return json(env, { error: "not found" }, 404);
    const payload = await getArtefact(env, b);
    if (!payload) return json(env, { error: "no payload" }, 404);
    return json(env, payload);
  }

  if (a === "artefacts" && b && !c && m === "PUT") {
    {
      const deny = await requireNodeWrite(env, user, b);
      if (deny) return deny;
    }
    const row = await env.DB.prepare(`SELECT type FROM nodes WHERE id = ?`)
      .bind(b)
      .first<{ type: string }>();
    if (!row || !isArtefact(row.type)) return json(env, { error: "not an artefact" }, 400);

    const payload = await req.json<unknown>();
    try {
      const stored = await putArtefact(env, b, row.type as ArtefactKind, payload);
      await env.DB.prepare(
        `UPDATE nodes SET data = ?, body = ?, index_dirty = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(JSON.stringify(stored.data), stored.body, now(), now(), b)
        .run();
      return json(env, { ok: true, ...stored.data });
    } catch (err: any) {
      return json(env, { error: String(err?.message ?? err) }, 413);
    }
  }

  // --- files: arbitrary uploads, singly and in folders ---------------------

  /*
   * Upload one file to a `file` or `folder` node.
   *
   * The metadata rides in headers rather than a multipart body so that the body
   * stays pure bytes and can go to R2 as a stream. Multipart would mean parsing
   * — and therefore buffering — the whole upload in the isolate, which is what
   * caps the size at memory rather than at a number we choose.
   *
   * `x-file-name` is URL-encoded, because a header is Latin-1 and filenames are
   * not.
   */
  if (a === "nodes" && b && c === "files" && m === "POST") {
    {
      const deny = await requireNodeWrite(env, user, b);
      if (deny) return deny;
    }
    const node = await env.DB.prepare(`SELECT type, title FROM nodes WHERE id = ?`)
      .bind(b)
      .first<{ type: string; title: string }>();
    if (!node || !isFileKind(node.type)) return json(env, { error: "not a file node" }, 400);

    const decode = (raw: string | null) => {
      if (!raw) return "";
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    };
    const name = decode(req.headers.get("x-file-name"));
    const description = decode(req.headers.get("x-file-description"));
    const contentType = (req.headers.get("content-type") ?? "application/octet-stream")
      .split(";")[0]
      .trim();
    const size = Number(req.headers.get("content-length") ?? 0);

    if (!name) return json(env, { error: "x-file-name is required" }, 400);
    if (!req.body) return json(env, { error: "no body" }, 400);

    // A `file` node holds one file. Uploading a second is not a merge, it is
    // almost certainly the wrong node — say so rather than quietly growing a
    // shape the editor does not render.
    if (node.type === "file" && (await filesOf(env, b)).length)
      return json(
        env,
        { error: "That node already holds a file. Use a folder to keep several." },
        409,
      );

    /*
     * Buffer only what we mean to read.
     *
     * A stream can be consumed once, so whether to extract a text snippet has
     * to be decided before the body is touched at all. Everything else goes
     * straight through and is never whole in memory.
     */
    const buffered = wantsSnippet(name, contentType, size);
    try {
      const row = await storeFile(env, {
        nodeId: b,
        kind: node.type,
        title: node.title,
        name,
        contentType,
        description,
        size,
        uploadedBy: user.id,
        source: buffered ? await req.arrayBuffer() : req.body,
      });
      const refreshed = await env.DB.prepare(`SELECT data, body FROM nodes WHERE id = ?`)
        .bind(b)
        .first<{ data: string; body: string }>();
      return json(
        env,
        { file: toMeta(row), data: JSON.parse(refreshed?.data ?? "{}"), body: refreshed?.body ?? "" },
        201,
      );
    } catch (err: any) {
      if (err instanceof FileError) return json(env, { error: err.message }, err.status);
      throw err;
    }
  }

  /*
   * List a node's files, each with a signed download URL.
   *
   * The URLs are minted here, where the session says who is asking and
   * `nodeRole` says what they may do. The download origin has no session and
   * re-checks only the signature — see mindbox.ts.
   */
  if (a === "nodes" && b && c === "files" && m === "GET") {
    const role = await nodeRole(env.DB, user.id, b);
    if (!role) return json(env, { error: "not found" }, 404);

    const rows = await filesOf(env, b);
    const files = await Promise.all(
      rows.map(async (row) => ({ ...toMeta(row), url: await fileUrl(env, row.id) })),
    );
    return json(env, { files });
  }

  /* Remove one file. The bytes are filed, not destroyed — see r2trash.ts. */
  if (a === "files" && b && m === "DELETE") {
    const row = await fileById(env, b);
    if (!row) return json(env, { error: "not found" }, 404);
    {
      const deny = await requireNodeWrite(env, user, row.node_id);
      if (deny) return deny;
    }
    const node = await env.DB.prepare(`SELECT type, title FROM nodes WHERE id = ?`)
      .bind(row.node_id)
      .first<{ type: string; title: string }>();
    if (!node || !isFileKind(node.type)) return json(env, { error: "not found" }, 404);

    await removeFile(env, row, node.type, node.title);
    return json(env, { ok: true });
  }

  /* Rename a file, or rewrite the one line that makes it findable. */
  if (a === "files" && b && m === "PATCH") {
    const row = await fileById(env, b);
    if (!row) return json(env, { error: "not found" }, 404);
    {
      const deny = await requireNodeWrite(env, user, row.node_id);
      if (deny) return deny;
    }
    const p = await req.json<any>();
    const name = typeof p.name === "string" ? p.name.trim().slice(0, 300) : row.name;
    const description =
      typeof p.description === "string" ? p.description.trim().slice(0, 1_000) : row.description;
    if (!name) return json(env, { error: "A file needs a name." }, 400);

    await env.DB.prepare(`UPDATE files SET name = ?, description = ? WHERE id = ?`)
      .bind(name, description, b)
      .run();

    const node = await env.DB.prepare(`SELECT type, title FROM nodes WHERE id = ?`)
      .bind(row.node_id)
      .first<{ type: string; title: string }>();
    if (node && isFileKind(node.type))
      await refreshFileNode(env, row.node_id, node.type, node.title);
    return json(env, { ok: true });
  }

  if (a === "nodes" && b && m === "DELETE") {
    {
      const deny = await requireNodeWrite(env, user, b);
      if (deny) return deny;
    }
    // Archive before deleting, while the row and its edges still exist. Edges
    // carry ON DELETE CASCADE on both endpoints (migration 0011), so removing
    // the node takes its links with it — including any reaching onto another
    // mindmap — and chunk rows go the same way (0017). The archive captures the
    // edges so a restore brings back a connected card rather than a stranded
    // one. R2 objects are filed in the same step; nothing cascades into R2.
    await archiveNode(env, user.id, b);
    await env.DB.prepare(`DELETE FROM nodes WHERE id = ?`).bind(b).run();
    // Vectors do not cascade — they live in Vectorize, which knows nothing about
    // this delete. Left behind, they keep returning a card that no longer
    // exists; the id survives retrieval and dies at the D1 join, so the symptom
    // is a recall that quietly returns fewer results than it found.
    await removeCards(env, [b]);
    return json(env, { ok: true });
  }


  // --- images: pasted or dropped into a card's document -------------------

  if (a === "images" && !b && m === "POST") {
    const type = req.headers.get("content-type") ?? "application/octet-stream";
    if (!type.startsWith("image/")) return json(env, { error: "not an image" }, 415);
    const ext = type.split("/")[1]?.split("+")[0] ?? "bin";
    const key = `${id()}.${ext}`;
    await env.IMAGES.put(key, req.body, { httpMetadata: { contentType: type } });
    return json(env, { key, url: `${issuerOf(req, env)}/api/images/${key}` }, 201);
  }

  /*
   * Serve an image.
   *
   * The two extra headers are not decoration. `image/*` includes
   * `image/svg+xml`, and an SVG is a document: navigated to directly it runs
   * its own script, on this origin, beside the `HttpOnly` session cookie that
   * a same-origin `fetch("/api/boards", { credentials: "include" })` attaches
   * by itself. Upload one to your own account, send the link to someone signed
   * in, and it reads their mindmaps — there is no ownership check here, because
   * the key is the capability.
   *
   * The CSP is what closes it: as a subresource in an `<img>` a document CSP is
   * irrelevant and the image still renders, and as a navigated document it gets
   * `default-src 'none'` and a sandbox, so nothing runs. `nosniff` stops the
   * same trick via a mislabelled content type.
   *
   * Newly uploaded files avoid this entirely by going out through the mindbox
   * origin. Images predate that and are still linked by URL from inside card
   * documents, so they are fixed in place rather than moved.
   */
  if (a === "images" && b && m === "GET") {
    const obj = await env.IMAGES.get(b);
    if (!obj) return new Response("not found", { status: 404, headers: cors(env) });
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
        ...cors(env),
      },
    });
  }

  // --- edges ---------------------------------------------------------------

  // An edge is between two cards, not on a board. Ownership is checked at both
  // ends, which is also what permits the two ends to be on different mindmaps.
  if (a === "edges" && !b && m === "POST") {
    const p = await req.json<any>();
    if (!(await canWriteNode(env, user, p.source_id)) || !(await canWriteNode(env, user, p.target_id)))
      return json(env, { error: "not found" }, 404);
    const edge = {
      id: p.id ?? id(),
      source_id: p.source_id,
      target_id: p.target_id,
      label: p.label ?? "",
      created_at: now(),
      // which side of each card the link attaches to
      source_handle: p.source_handle ?? null,
      target_handle: p.target_handle ?? null,
    };
    await env.DB.prepare(
      `INSERT OR REPLACE INTO edges
         (id,source_id,target_id,label,created_at,source_handle,target_handle)
       VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(...Object.values(edge))
      .run();
    return json(env, edge, 201);
  }

  // Endpoints and attachment sides are editable, not just the label — an edge
  // drawn the wrong way round used to be permanent.
  if (a === "edges" && b && m === "PATCH") {
    if (!(await canWriteEdge(env, user, b))) return json(env, { error: "not found" }, 404);
    const p = await req.json<any>();
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, column] of [
      ["label", "label"],
      ["source_id", "source_id"],
      ["target_id", "target_id"],
      ["source_handle", "source_handle"],
      ["target_handle", "target_handle"],
    ] as const) {
      if (p[key] !== undefined) {
        sets.push(`${column} = ?`);
        vals.push(p[key]);
      }
    }
    if (!sets.length) return json(env, { ok: true });
    vals.push(b);
    await env.DB.prepare(`UPDATE edges SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...vals)
      .run();
    return json(env, { ok: true });
  }

  if (a === "edges" && b && m === "DELETE") {
    if (!(await canWriteEdge(env, user, b))) return json(env, { error: "not found" }, 404);
    await env.DB.prepare(`DELETE FROM edges WHERE id = ?`).bind(b).run();
    return json(env, { ok: true });
  }

  // --- research: dispatch / resume a Claude session for a card -------------

  if (a === "nodes" && b && c === "research" && m === "POST") {
    const { brief } = await req.json<any>();
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN)
      return json(env, { error: "no Anthropic credentials configured" }, 501);
    if (!env.ANTHROPIC_AGENT_ID || !env.ANTHROPIC_ENVIRONMENT_ID)
      return json(env, { error: "run `npm run setup` to create agent + env" }, 501);

    const client = anthropicFor(env);
    const node = await env.DB.prepare(`SELECT * FROM nodes WHERE id = ?`)
      .bind(b)
      .first<any>();
    if (!node) return json(env, { error: "no such node" }, 404);

    // resume if this card already has a thread
    const existing = await env.DB.prepare(
      `SELECT * FROM sessions WHERE node_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(b)
      .first<any>();

    if (existing?.anthropic_session_id) {
      await client.sendMessage(existing.anthropic_session_id, brief);
      await env.DB.prepare(
        `UPDATE sessions SET status='running', updated_at=? WHERE id=?`,
      )
        .bind(now(), existing.id)
        .run();
      return json(env, { session: existing, resumed: true });
    }


    const remote = await client.createSession({
      agentId: env.ANTHROPIC_AGENT_ID,
      environmentId: env.ANTHROPIC_ENVIRONMENT_ID,
      title: node.title || "Research",
      brief,
      repos: [],
      githubToken: env.GITHUB_TOKEN,
    });

    const session = {
      id: id(),
      node_id: b,
      anthropic_session_id: remote.id,
      status: remote.status ?? "running",
      created_at: now(),
      updated_at: now(),
    };
    await env.DB.prepare(
      `INSERT INTO sessions (id,node_id,anthropic_session_id,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?)`,
    )
      .bind(...Object.values(session))
      .run();
    return json(env, { session, resumed: false }, 201);
  }

  // poll a card's thread (webhook is the fast path; this is the reconcile)
  if (a === "nodes" && b && c === "research" && m === "GET") {
    const session = await env.DB.prepare(
      `SELECT * FROM sessions WHERE node_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(b)
      .first<any>();
    if (!session) return json(env, { session: null, text: "", outputs: [] });
    if (!env.ANTHROPIC_API_KEY) return json(env, { session, text: "", outputs: [] });

    const client = anthropicFor(env);
    const sid = session.anthropic_session_id;
    const [remote, events] = await Promise.all([
      client.getSession(sid),
      client.listEvents(sid),
    ]);

    let outputs: any[] = [];
    if (remote.status === "idle" || remote.status === "terminated") {
      outputs = (await client.listOutputs(sid).catch(() => ({ data: [] }))).data ?? [];
    }

    if (remote.status !== session.status) {
      await env.DB.prepare(`UPDATE sessions SET status=?, updated_at=? WHERE id=?`)
        .bind(remote.status, now(), session.id)
        .run();
    }

    return json(env, {
      session: { ...session, status: remote.status },
      text: textFromEvents(events.data ?? []),
      outputs,
    });
  }

  // --- webhook -------------------------------------------------------------
  // NOTE: raw body only — .json() would re-serialise and break the HMAC.
  // Signature verification is TODO; see DESIGN.md §5.

  if (a === "webhooks" && b === "anthropic" && m === "POST") {
    const raw = await req.text();
    const evt = JSON.parse(raw);
    const sid = evt?.data?.id;
    if (!sid) return json(env, { ok: true });

    const session = await env.DB.prepare(
      `SELECT * FROM sessions WHERE anthropic_session_id = ?`,
    )
      .bind(sid)
      .first<any>();
    if (!session) return json(env, { ok: true });

    // anthropic_event_id is UNIQUE -> INSERT OR IGNORE dedupes retries
    await env.DB.prepare(
      `INSERT OR IGNORE INTO events (id,session_id,anthropic_event_id,type,payload,created_at)
       VALUES (?,?,?,?,?,?)`,
    )
      .bind(id(), session.id, evt.id, evt.data.type, raw, now())
      .run();

    const status = evt.data.type.replace("session.status_", "");
    await env.DB.prepare(`UPDATE sessions SET status=?, updated_at=? WHERE id=?`)
      .bind(status, now(), session.id)
      .run();

    return json(env, { ok: true });
  }

  return json(env, { error: "not found" }, 404);
}



/*
 * Access checks.
 *
 * These used to answer one question — is this yours — and every caller treated
 * the answer as permission to do anything. Now they answer "what role do you
 * hold", and each caller has to say what it needs. The `canRead`/`canWrite`
 * split is the whole point: a viewer on a shared mindmap passes the first and
 * must fail the second.
 *
 * Kept as thin wrappers over `access.ts` rather than inlined, so a call site
 * reads as an intent ("may this request write here") rather than as a role
 * comparison every reader has to decode.
 */

/*
 * Refusals that tell the truth.
 *
 * Returning "not found" for everything was right when the only question was
 * ownership: you either owned it or it may as well not exist. Now a viewer on a
 * shared mindmap can see the thing perfectly well, and answering "not found" to
 * their edit would be a lie they can disprove by looking at the screen.
 *
 * So: 404 when you cannot see it at all, 403 with the reason when you can see
 * it but may not do this. The 404 still reveals nothing, because it is returned
 * exactly when there is nothing to reveal.
 */
async function requireBoardWrite(env: Env, user: SessionUser, boardId?: string) {
  if (!boardId) return json(env, { error: "not found" }, 404);
  const role = await boardRole(env.DB, user.id, boardId);
  if (canWrite(role)) return null;
  return role
    ? json(env, { error: "You have view-only access to this mindmap." }, 403)
    : json(env, { error: "not found" }, 404);
}

async function requireBoardAdmin(env: Env, user: SessionUser, boardId?: string) {
  if (!boardId) return json(env, { error: "not found" }, 404);
  const role = await boardRole(env.DB, user.id, boardId);
  if (canAdmin(role)) return null;
  return role
    ? json(env, { error: "Only the owner can do that." }, 403)
    : json(env, { error: "not found" }, 404);
}

async function requireNodeWrite(env: Env, user: SessionUser, nodeId: string) {
  const role = await nodeRole(env.DB, user.id, nodeId);
  if (canWrite(role)) return null;
  return role
    ? json(env, { error: "You have view-only access to this." }, 403)
    : json(env, { error: "not found" }, 404);
}

/** May this user read this mindmap at all? */
async function canReadBoard(env: Env, user: SessionUser, boardId?: string): Promise<boolean> {
  if (!boardId) return false;
  return (await boardRole(env.DB, user.id, boardId)) !== null;
}

/** May this user change what is on this mindmap? */
async function canWriteBoard(env: Env, user: SessionUser, boardId?: string): Promise<boolean> {
  if (!boardId) return false;
  return canWrite(await boardRole(env.DB, user.id, boardId));
}

/** May this user delete this mindmap, or manage who is on it? Owners only. */
async function canAdminBoard(env: Env, user: SessionUser, boardId?: string): Promise<boolean> {
  if (!boardId) return false;
  return canAdmin(await boardRole(env.DB, user.id, boardId));
}

async function canReadNode(env: Env, user: SessionUser, nodeId: string): Promise<boolean> {
  return (await nodeRole(env.DB, user.id, nodeId)) !== null;
}

async function canWriteNode(env: Env, user: SessionUser, nodeId: string): Promise<boolean> {
  return canWrite(await nodeRole(env.DB, user.id, nodeId));
}

/**
 * Edge access, via its endpoints — edges do not belong to a board.
 *
 * Both ends are checked, and an edge spanning two mindmaps needs the role on
 * both. Writing an edge you can only half-see would let you discover what is on
 * the other side by watching what succeeds.
 */
async function canWriteEdge(env: Env, user: SessionUser, edgeId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT sn.id AS source_node, tn.id AS target_node
       FROM edges e
       JOIN nodes sn ON sn.id = e.source_id
       JOIN nodes tn ON tn.id = e.target_id
      WHERE e.id = ?`,
  )
    .bind(edgeId)
    .first<{ source_node: string; target_node: string }>();
  if (!row) return false;
  const [a, b] = await Promise.all([
    nodeRole(env.DB, user.id, row.source_node),
    nodeRole(env.DB, user.id, row.target_node),
  ]);
  return canWrite(a) && canWrite(b);
}

// --- auth -------------------------------------------------------------------

async function authRoute(
  req: Request,
  env: Env,
  seg: string[],
  user: SessionUser | null,
): Promise<Response> {
  const [, , action] = seg; // ["api","auth",action,...]
  const m = req.method;

  if (action === "me" && m === "GET") {
    return json(env, { user, googleEnabled: !!env.GOOGLE_CLIENT_ID });
  }

  if (action === "register" && m === "POST") {
    const { email, password, name } = await req.json<any>();
    const addr = String(email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr))
      return json(env, { error: "That doesn't look like an email address." }, 400);

    const problems = passwordProblems(String(password ?? ""));
    if (problems.length)
      return json(env, { error: "Your password needs " + problems.join(", ") + ".", problems }, 400);

    const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`)
      .bind(addr)
      .first();
    if (existing)
      return json(env, { error: "An account with that email already exists." }, 409);

    const { hash, salt } = await hashPassword(password);
    const uid = id();
    await env.DB.prepare(
      `INSERT INTO users (id,email,name,password_hash,password_salt,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(uid, addr, String(name ?? "").trim(), hash, salt, now(), now())
      .run();

    // The workspace first: the starter board references it, and `signIn` only
    // gets to creating one after this runs.
    await ensurePersonalWorkspace(env.DB, uid);

    // Awaited, not fire-and-forget: the redirect lands on /app immediately and
    // a board that appears a beat later reads as a bug. It cannot throw.
    await createStarterBoard(env.DB, uid, issuerOf(req, env));
    return signIn(req, env, uid);
  }

  if (action === "login" && m === "POST") {
    const { email, password } = await req.json<any>();
    const addr = String(email ?? "").trim().toLowerCase();
    const row = await env.DB.prepare(
      `SELECT id, password_hash, password_salt FROM users WHERE email = ?`,
    )
      .bind(addr)
      .first<{ id: string; password_hash: string | null; password_salt: string | null }>();

    // Same message whether the account is missing, has no password (Google
    // only), or the password is wrong — don't leak which emails exist.
    const bad = () => json(env, { error: "Email or password is incorrect." }, 401);
    if (!row?.password_hash || !row.password_salt) return bad();
    if (!(await verifyPassword(String(password ?? ""), row.password_hash, row.password_salt)))
      return bad();

    return signIn(req, env, row.id);
  }

  /**
   * Harnesses this account has connected over MCP.
   *
   * Grouped by client, not by token: refresh rotation mints a new row every
   * time Claude Code refreshes, so a raw token list would show the same
   * connection a dozen times and make "which of these is my laptop?"
   * unanswerable.
   */
  if (action === "connections" && m === "GET") {
    if (!user) return json(env, { error: "not signed in" }, 401);
    const { results } = await env.DB.prepare(
      `SELECT c.client_id, c.client_name,
              COUNT(*)          AS tokens,
              MIN(t.created_at) AS first_seen,
              MAX(t.created_at) AS last_seen,
              MAX(t.scope)      AS scope
         FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.user_id = ? AND t.revoked = 0 AND t.expires_at > ?
        GROUP BY c.client_id
        ORDER BY last_seen DESC`,
    )
      .bind(user.id, now())
      .all();
    return json(env, results ?? []);
  }

  /** Revoke every live token for one client — "disconnect this app". */
  if (action === "connections" && seg[3] && m === "DELETE") {
    if (!user) return json(env, { error: "not signed in" }, 401);
    const { meta } = await env.DB.prepare(
      `UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ? AND revoked = 0`,
    )
      .bind(user.id, seg[3])
      .run();
    return json(env, { ok: true, revoked: meta?.changes ?? 0 });
  }

  if (action === "logout" && m === "POST") {
    await destroySession(env.DB, readCookie(req, SESSION_COOKIE));
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": clearCookie(req),
        ...cors(env),
      },
    });
  }


  // --- Google OAuth ---------------------------------------------------------
  // Authorization-code flow. The `state` row is single-use and short-lived,
  // which is what stops a third party replaying our callback.

  if (action === "google" && m === "GET") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
      return json(env, { error: "Google sign-in isn't configured." }, 501);

    const url = new URL(req.url);
    const state = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO oauth_states (state,redirect_to,created_at,expires_at) VALUES (?,?,?,?)`,
    )
      .bind(state, url.searchParams.get("next") ?? "/app", now(), now() + 600_000)
      .run();

    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    auth.searchParams.set("redirect_uri", `${url.origin}/api/auth/google/callback`);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", "openid email profile");
    auth.searchParams.set("state", state);
    auth.searchParams.set("prompt", "select_account");
    return Response.redirect(auth.toString(), 302);
  }

  if (action === "google" && seg[3] === "callback" && m === "GET") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
      return json(env, { error: "Google sign-in isn't configured." }, 501);

    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const appOrigin = env.APP_ORIGIN ?? url.origin;
    const fail = (why: string) =>
      Response.redirect(`${appOrigin}/login?error=${encodeURIComponent(why)}`, 302);

    if (!code || !state) return fail("Google sign-in was cancelled.");

    // single use: consume the state row before doing anything with the code
    const row = await env.DB.prepare(
      `SELECT redirect_to FROM oauth_states WHERE state = ? AND expires_at > ?`,
    )
      .bind(state, now())
      .first<{ redirect_to: string }>();
    await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(state).run();
    if (!row) return fail("That sign-in link expired. Try again.");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) return fail("Google rejected the sign-in.");
    const { id_token } = await tokenRes.json<{ id_token?: string }>();
    if (!id_token) return fail("Google didn't return an identity token.");

    // Verify via Google's tokeninfo endpoint rather than checking the JWT
    // signature ourselves — the code was just exchanged over TLS with our
    // client secret, so this is about validating claims, not transport.
    const infoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(id_token)}`,
    );
    if (!infoRes.ok) return fail("Couldn't verify the Google account.");
    const info = await infoRes.json<any>();
    if (info.aud !== env.GOOGLE_CLIENT_ID) return fail("That token wasn't issued for this app.");
    if (info.email_verified === "false" || info.email_verified === false)
      return fail("That Google account has no verified email.");

    const email = String(info.email ?? "").toLowerCase();
    const sub = String(info.sub ?? "");
    if (!email || !sub) return fail("Google didn't return an email address.");

    // Match on google_sub first, then fall back to email so an existing
    // password account links rather than duplicating.
    let existing = await env.DB.prepare(`SELECT id FROM users WHERE google_sub = ?`)
      .bind(sub)
      .first<{ id: string }>();
    if (!existing) {
      existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`)
        .bind(email)
        .first<{ id: string }>();
      if (existing) {
        await env.DB.prepare(`UPDATE users SET google_sub = ?, updated_at = ? WHERE id = ?`)
          .bind(sub, now(), existing.id)
          .run();
      }
    }

    let uid = existing?.id;
    if (!uid) {
      uid = id();
      await env.DB.prepare(
        `INSERT INTO users (id,email,name,avatar_url,google_sub,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
        .bind(uid, email, String(info.name ?? ""), info.picture ?? null, sub, now(), now())
        .run();
      // Only inside this branch: `existing` means a returning account, and a
      // second Google sign-in is not a signup.
      await createStarterBoard(env.DB, uid, issuerOf(req, env));
    }

    const { token, expiresAt } = await createSession(
      env.DB,
      uid,
      req.headers.get("user-agent") ?? undefined,
    );
    return new Response(null, {
      status: 302,
      headers: {
        location: landingUrl(row.redirect_to, appOrigin, url.origin),
        "set-cookie": sessionCookie(req, token, Math.floor((expiresAt - Date.now()) / 1000)),
      },
    });
  }

  return json(env, { error: "not found" }, 404);
}

/**
 * Where to send the browser after Google signs someone in.
 *
 * Usually a path on the app. But when the OAuth authorize endpoint bounced the
 * user through sign-in, it's an absolute URL back to *this* origin so the
 * authorization request can resume. Anything absolute that isn't one of our
 * own origins is discarded — an attacker-supplied `next` must never become an
 * open redirect.
 */
function landingUrl(next: string, appOrigin: string, selfOrigin: string): string {
  if (/^https?:\/\//i.test(next)) {
    try {
      const target = new URL(next);
      if (target.origin === selfOrigin || target.origin === appOrigin) return target.toString();
    } catch {
      /* fall through */
    }
    return `${appOrigin}/app`;
  }
  return `${appOrigin}${next.startsWith("/") ? next : "/app"}`;
}

/** Issue a session cookie for a user id. */
async function signIn(req: Request, env: Env, userId: string): Promise<Response> {
  const { token, expiresAt } = await createSession(
    env.DB,
    userId,
    req.headers.get("user-agent") ?? undefined,
  );
  const user = await env.DB.prepare(
    `SELECT id,email,name,avatar_url FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{ id: string; email: string }>();

  /*
   * Everything an account needs to exist properly, done here because every way
   * in goes through this function — register, password login, and Google.
   *
   * Invites are claimed on every sign-in rather than only at sign-up: someone
   * may be invited after they already have an account but before they next log
   * in, and an invite that fired only at registration would strand them
   * permanently.
   *
   * Awaited rather than deferred. The response redirects straight to /app, and
   * a workspace that appears a beat later reads as a bug.
   */
  if (user?.email) {
    await ensurePersonalWorkspace(env.DB, userId);
    await claimInvites(env, userId, user.email);
  }

  return new Response(JSON.stringify({ user }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": sessionCookie(req, token, Math.floor((expiresAt - Date.now()) / 1000)),
      ...cors(env),
    },
  });
}

// --- helpers ---------------------------------------------------------------

/** API key or OAuth bearer token, whichever is configured. */
const anthropicFor = (env: Env) =>
  new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    authToken: env.ANTHROPIC_AUTH_TOKEN,
  });

/**
 * Labels come in as an array and go to SQLite as JSON.
 *
 * Trimmed, de-duplicated case-insensitively and capped. Free text means two
 * people (or an agent on two days) write "Auth" and "auth" and get two labels
 * that look identical in the rail and filter differently, so the dedupe is the
 * feature rather than tidiness.
 */
function normaliseLabels(input: unknown): string | null {
  if (input == null) return null;
  const list = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = String(raw ?? "").trim().slice(0, 32);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= 12) break;
  }
  return out.length ? JSON.stringify(out) : null;
}

/** Labels are stored as JSON; a bad row must not fail the whole board list. */
const parseLabels = (v: unknown): string[] => {
  if (typeof v !== "string" || !v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const hydrateBoard = (b: any) => ({ ...b, labels: parseLabels(b?.labels), pinned: !!b?.pinned });

const hydrateNode = (n: any) => ({ ...n, data: JSON.parse(n.data || "{}") });

/** Where share links live. The app, not the mindbox: the viewer is app chrome. */
const appOrigin = (env: Env) => env.APP_ORIGIN || env.PUBLIC_ORIGIN || "";

/**
 * Parse a `nodes.data` blob without letting a bad one throw.
 *
 * The delete path reads this to find an image's R2 key. A row whose data is
 * malformed should cost a leaked object, not a failed delete of the card the
 * user actually asked to remove.
 */
const safeJson = (raw: string | null): any => {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
};
