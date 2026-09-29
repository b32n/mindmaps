/**
 * The mindbox: where HTML artefacts run.
 *
 * Named for what it is — the sandbox for mindmaps. The browser's own sandboxing
 * primitives below keep their real names (`sandbox="allow-scripts"`), because
 * those are HTML, not ours to rename.
 *
 * This is the only artefact type that is *code*. A sheet, a document and a deck
 * are data that a trusted editor renders; an HTML page is script we hand to the
 * browser and ask it to run. And the author is usually an agent, which means a
 * prompt injection in anything that agent read is a way to author one.
 *
 * So it never runs on the app's origin. Three layers, in order of how much they
 * matter:
 *
 *  1. A separate hostname. `mindmaps.b32n.io` holds a `HttpOnly; SameSite=Lax`
 *     session cookie, and `HttpOnly` does nothing against a same-origin
 *     `fetch("/api/boards", { credentials: "include" })` — the browser attaches
 *     the cookie itself. A page running there could read every card the user
 *     owns and delete every mindmap. On its own hostname it has no session to
 *     borrow and same-origin policy does the work.
 *
 *  2. `sandbox="allow-scripts"` on the iframe, and deliberately *not*
 *     `allow-same-origin`: granted together they let a frame reach out and
 *     remove its own sandbox. Without it the frame gets an opaque origin, so
 *     artefacts are isolated from each other as well as from the app.
 *
 *  3. A CSP with `connect-src 'none'`. The first two stop a page reading the
 *     user's data; this stops it sending anything anywhere even if it somehow
 *     did. Everything an artefact needs must be inlined.
 *
 * Access is a signed, short-lived URL rather than a cookie, because the mindbox
 * deliberately has no session. The app, which does have one, mints the
 * URL after checking ownership.
 */

import { fileById, type FileEnv } from "./files";
import { resolveShare } from "./shares";

export interface MindboxEnv {
  DB: D1Database;
  ARTEFACTS: R2Bucket;
  /** HMAC key for frame URLs. Set with `wrangler secret put MINDBOX_SECRET`. */
  MINDBOX_SECRET?: string;
  /** Where the mindbox answers. Absent in local dev, where there is one origin. */
  MINDBOX_ORIGIN?: string;
  APP_ORIGIN?: string;
}

/**
 * How long a frame URL is good for.
 *
 * Long enough to open an artefact and keep it open for a while, short enough
 * that a URL leaking through a referrer header or a screenshot is not a durable
 * grant. The app mints a fresh one every time it renders the frame.
 */
const TTL_MS = 60 * 60 * 1000;

const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

/** Constant-time compare, so a wrong signature leaks nothing by how long it took. */
function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A URL that renders one artefact, for one hour.
 *
 * The node id is signed along with the expiry so neither can be edited: swapping
 * the id would otherwise let anyone holding one valid URL read every artefact
 * in the system.
 */
export async function frameUrl(env: MindboxEnv, nodeId: string): Promise<string | null> {
  if (!env.MINDBOX_SECRET) return null;
  const exp = Date.now() + TTL_MS;
  const sig = await sign(env.MINDBOX_SECRET, `${nodeId}.${exp}`);
  // No configured mindbox origin means local development, where there is only
  // one origin to serve from. Same path, same signing, none of the isolation —
  // which is why it is a dev-only fallback and the deploy notes say to set it.
  const base = env.MINDBOX_ORIGIN ?? "";
  return `${base}/s/${nodeId}?exp=${exp}&sig=${sig}`;
}

/**
 * A URL that downloads one file, for one hour.
 *
 * Same signer, same window, different noun: the id here is a row in `files`,
 * not a node. Files go out through the mindbox for the reason HTML artefacts
 * do — they are bytes we did not write, served back to a browser, and some of
 * them (an SVG, an HTML export, a PDF) are documents that can run script. On
 * the app origin that script sits beside the session cookie. On this one there
 * is no cookie to borrow.
 */
export async function fileUrl(env: MindboxEnv, fileId: string): Promise<string | null> {
  if (!env.MINDBOX_SECRET) return null;
  const exp = Date.now() + TTL_MS;
  const sig = await sign(env.MINDBOX_SECRET, `${fileId}.${exp}`);
  const base = env.MINDBOX_ORIGIN ?? "";
  return `${base}/f/${fileId}?exp=${exp}&sig=${sig}`;
}

/**
 * Types we will render in place rather than hand over as a download.
 *
 * Raster images and PDFs are what people actually want to look at without
 * saving first. SVG is deliberately absent: it is the one image type that is a
 * document, with script and external references, and although the mindbox
 * origin contains that, there is no reason to render it inline when nothing
 * needs it.
 */
const INLINE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
  "application/pdf",
]);

/** The CSP every artefact is served under. */
function policy(appOrigin: string): string {
  return [
    // Nothing is permitted that is not named below.
    "default-src 'none'",
    // Inline script is the whole point of the artefact. `unsafe-eval` is left
    // out until something real needs it.
    "script-src 'unsafe-inline' blob:",
    "style-src 'unsafe-inline'",
    // Inlined images only: a remote image URL is an exfiltration channel, since
    // the path can carry data.
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    // The one that matters. No fetch, no XHR, no WebSocket, no beacon.
    "connect-src 'none'",
    // A form post would be a way out of connect-src.
    "form-action 'none'",
    "base-uri 'none'",
    // Only our app may frame this, so the URL cannot be embedded elsewhere
    // while it is valid. The share viewer lives on the app origin too, so this
    // covers both the editor preview and a shared page.
    `frame-ancestors ${appOrigin}`,
  ].join("; ");
}

/**
 * Serve an artefact's HTML, if the signature holds.
 *
 * Returns null when the path is not ours, so normal routing continues.
 */
export async function serveMindbox(req: Request, env: MindboxEnv, url: URL): Promise<Response | null> {
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "s" || !seg[1] || seg.length !== 2) return null;

  const deny = (why: string, status = 403) =>
    new Response(why, { status, headers: { "content-type": "text/plain" } });

  if (!env.MINDBOX_SECRET) return deny("Artefact rendering is not configured.", 503);

  /*
   * Never serve this on the app's own origin.
   *
   * Both hostnames route to the same Worker, so without this a valid signature
   * also renders on mindmaps.b32n.io — where the page sits alongside the
   * session cookie, which is the one thing this whole design exists to prevent.
   * Nothing generates such a URL; the app builds them from MINDBOX_ORIGIN. But
   * "nothing generates it" is a convention, and a convention is not a boundary.
   * Share links will put many more of these URLs in front of many more people.
   *
   * Phrased as "refuse on the app host" rather than "require the mindbox host"
   * because that is the actual hazard, and because it degrades correctly: a
   * deployment with no separate mindbox configured has nothing to refuse rather
   * than being silently broken.
   *
   * Not exercisable in local development: `wrangler dev` reports the route's
   * hostname as `url.host` whatever you connect to, and locally the app and the
   * mindbox share one origin anyway. Verify it on the deployed site.
   */
  const hostOf = (origin: string | undefined) => {
    try {
      return origin ? new URL(origin).host : null;
    } catch {
      return null;
    }
  };
  const appHost = hostOf(env.APP_ORIGIN);
  const boxHost = hostOf(env.MINDBOX_ORIGIN);
  if (appHost && boxHost && boxHost !== appHost && url.host === appHost)
    return deny(`Artefacts are served from ${boxHost}, not here.`, 404);

  const nodeId = seg[1];

  /*
   * Two ways in, and they authorise different things.
   *
   * `t` is a share token: a row the owner can revoke, checked against the
   * database, and valid for whoever holds the link. `exp`+`sig` is the owner's
   * own hour-long preview, checked against a secret and never handed out.
   *
   * A share token is checked against the node in the URL rather than trusted to
   * name it, so one valid share cannot be pointed at a different artefact.
   */
  const token = url.searchParams.get("t");
  if (token) {
    const share = await resolveShare(env, token);
    if (!share || share.nodeId !== nodeId) return deny("This link is not available.", 404);
    if (share.kind !== "html") return deny("This link is not available.", 404);
  } else {
    const exp = Number(url.searchParams.get("exp") ?? 0);
    const sig = url.searchParams.get("sig") ?? "";
    // Order matters only for the message: a URL with no parameters at all is
    // not an expired link, and saying so sends someone looking for the wrong
    // problem.
    if (!exp || !sig || !Number.isFinite(exp)) return deny("Not a valid link.");
    if (exp < Date.now()) return deny("This link has expired.");

    const expected = await sign(env.MINDBOX_SECRET, `${nodeId}.${exp}`);
    if (!sameSignature(expected, sig)) return deny("Not a valid link.");
  }

  const obj = await env.ARTEFACTS.get(`artefacts/${nodeId}`);
  if (!obj) return deny("Not found.", 404);

  let html = "";
  try {
    html = String(((await obj.json()) as { html?: unknown })?.html ?? "");
  } catch {
    return deny("This artefact is damaged.", 500);
  }

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": policy(env.APP_ORIGIN || "'self'"),
      // Belt and braces with frame-ancestors, for anything that predates CSP.
      "x-frame-options": "SAMEORIGIN",
      "x-content-type-options": "nosniff",
      // Keep the signed URL out of anything the page navigates to.
      "referrer-policy": "no-referrer",
      // A signed URL is per-render; caching it anywhere shared would outlive
      // the permission check that produced it.
      "cache-control": "private, no-store",
    },
  });
}

/**
 * Serve one uploaded file, if the signature holds.
 *
 * Returns null when the path is not ours, so normal routing continues.
 *
 * The permission check happened when the URL was minted: the app knew who was
 * asking and what role they held, and signed the result. This path re-checks
 * only that the signature is intact and unexpired, which is what lets it answer
 * on an origin that has no session to check against.
 */
export async function serveFile(req: Request, env: MindboxEnv, url: URL): Promise<Response | null> {
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "f" || !seg[1] || seg.length !== 2) return null;

  const deny = (why: string, status = 403) =>
    new Response(why, { status, headers: { "content-type": "text/plain" } });

  if (!env.MINDBOX_SECRET) return deny("File downloads are not configured.", 503);
  // A signed download URL is a read capability and nothing else.
  if (req.method !== "GET" && req.method !== "HEAD")
    return deny("Method not allowed.", 405);

  // Same refusal as the artefact path, for the same reason: both hostnames
  // route to this Worker, so without it a valid signature also serves on the
  // app origin — which is the entire thing this indirection exists to prevent.
  const hostOf = (origin: string | undefined) => {
    try {
      return origin ? new URL(origin).host : null;
    } catch {
      return null;
    }
  };
  const appHost = hostOf(env.APP_ORIGIN);
  const boxHost = hostOf(env.MINDBOX_ORIGIN);
  if (appHost && boxHost && boxHost !== appHost && url.host === appHost)
    return deny(`Files are served from ${boxHost}, not here.`, 404);

  const fileId = seg[1];
  const row = await fileById(env as unknown as FileEnv, fileId);
  if (!row) return deny("Not found.", 404);

  /*
   * Two ways in, as with artefacts.
   *
   * A share token authorises the *node*, so the file is checked to belong to
   * it. Without that check any valid share on any folder would serve any file
   * in the system, which is the same mistake as trusting a URL to name its own
   * artefact.
   */
  const token = url.searchParams.get("t");
  if (token) {
    const share = await resolveShare(env, token);
    if (!share || share.nodeId !== row.node_id) return deny("This link is not available.", 404);
  } else {
    const exp = Number(url.searchParams.get("exp") ?? 0);
    const sig = url.searchParams.get("sig") ?? "";
    if (!exp || !sig || !Number.isFinite(exp)) return deny("Not a valid link.");
    if (exp < Date.now()) return deny("This link has expired.");
    const expected = await sign(env.MINDBOX_SECRET, `${fileId}.${exp}`);
    if (!sameSignature(expected, sig)) return deny("Not a valid link.");
  }

  const obj = await env.ARTEFACTS.get(row.r2_key);
  if (!obj) return deny("Not found.", 404);

  const inline = INLINE_TYPES.has(row.content_type.split(";")[0].trim().toLowerCase());
  // Quotes and backslashes would let a filename break out of the header value.
  const filename = row.name.replace(/["\\\r\n]/g, "");

  return new Response(obj.body, {
    headers: {
      "content-type": row.content_type || "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "content-length": String(row.size),
      // Without this a .txt full of markup is sniffed as HTML and rendered.
      "x-content-type-options": "nosniff",
      // Defence in depth behind the separate origin: even navigated to
      // directly, the document gets an opaque origin and no script.
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
      // The signed URL is per-render and outlives nothing. A shared cache
      // holding it would outlive the permission check that produced it.
      "cache-control": "private, no-store",
    },
  });
}
