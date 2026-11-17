/**
 * Every absolute URL this Worker hands out, built in one place.
 *
 * MCP tool results, REST responses and share links used to each decide for
 * themselves which origin to put in front of a path, and disagreed: MCP fell
 * back to the request's own address, `/frame` and `/api/shared` returned a
 * relative path when no mindbox host was configured, and a node had no URL at
 * all. Two origins are in play:
 *
 *  - the **app** origin, where the signed-in app and the share viewer live:
 *    `APP_ORIGIN`, else `PUBLIC_ORIGIN`, else the address the request came in on;
 *  - the **mindbox** origin, where signed frame and download URLs are served:
 *    `MINDBOX_ORIGIN`, else the app origin (local development, where there is
 *    one origin and none of the isolation; see mindbox.ts).
 *
 * Pass `req` when there is one. MCP calls arrive with `PUBLIC_ORIGIN` already
 * resolved (see `/mcp` in index.ts), so its callers can leave it out.
 */
import { issuerOf, type OriginEnv } from "./oauth";

export interface LinkEnv extends OriginEnv {
  APP_ORIGIN?: string;
  MINDBOX_ORIGIN?: string;
}

const bare = (origin: string) => origin.replace(/\/+$/, "");

export function appOrigin(env: LinkEnv, req?: Request): string {
  if (env.APP_ORIGIN) return bare(env.APP_ORIGIN);
  if (env.PUBLIC_ORIGIN) return bare(env.PUBLIC_ORIGIN);
  return req ? issuerOf(req, env) : "";
}

export function mindboxOrigin(env: LinkEnv, req?: Request): string {
  return env.MINDBOX_ORIGIN ? bare(env.MINDBOX_ORIGIN) : appOrigin(env, req);
}

/** The app route that opens each kind of node (see web/src/main.tsx). */
const EDITOR_ROUTE: Record<string, string> = {
  sheet: "sheet",
  doc: "doc",
  deck: "deck",
  html: "page",
  file: "file",
  folder: "file",
};

/** A mindmap's page. */
export const boardUrl = (env: LinkEnv, boardId: string, req?: Request) =>
  `${appOrigin(env, req)}/app/${boardId}`;

/**
 * Where the app shows a node: its editor for an artefact, file or folder, and
 * the card opened on its mindmap for everything else.
 */
export function nodeUrl(
  env: LinkEnv,
  node: { id: string; type: string; board_id: string },
  req?: Request,
): string {
  const route = EDITOR_ROUTE[node.type];
  return route
    ? `${appOrigin(env, req)}/${route}/${node.id}`
    : `${boardUrl(env, node.board_id, req)}?card=${node.id}`;
}

/** A public share link's viewer page. */
export const shareUrl = (env: LinkEnv, token: string, req?: Request) =>
  `${appOrigin(env, req)}/v/${token}`;
