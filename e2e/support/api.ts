// Thin wrappers over the app's own HTTP API, for arranging state quickly and for
// reading back what the server really stored. Tests drive the UI for the
// behaviour under test and use these for everything around it (a fresh board to
// work on, a card to start from, "what did the server save?").
//
// They are the same endpoints the web app calls (web/src/api.ts), on the
// `request` of a signed-in context, so no test-only path exists in the Worker.
import { expect, type APIRequestContext } from "@playwright/test";

export interface ApiBoard {
  id: string;
  name: string;
  pinned: boolean;
  labels: string[];
  description: string | null;
  home_view: string | null;
  workspace_id: string | null;
}

export interface ApiNode {
  id: string;
  board_id: string;
  type: string;
  title: string;
  body: string;
  x: number;
  y: number;
  w: number;
  h: number;
  data: Record<string, unknown>;
}

export interface ApiEdge {
  id: string;
  source_id: string;
  target_id: string;
  label: string;
  source_handle: string | null;
  target_handle: string | null;
  source_board: string;
  target_board: string;
}

async function ok<T>(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<T> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

export async function listBoards(request: APIRequestContext): Promise<ApiBoard[]> {
  return ok(await request.get("/api/boards"), "list boards");
}

export async function createBoard(
  request: APIRequestContext,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<ApiBoard> {
  return ok(await request.post("/api/boards", { data: { name, ...extra } }), "create board");
}

export async function deleteBoard(request: APIRequestContext, id: string) {
  await ok(await request.delete(`/api/boards/${id}`), "delete board");
}

export async function createNode(
  request: APIRequestContext,
  boardId: string,
  node: Partial<Omit<ApiNode, "id" | "board_id">> = {},
): Promise<ApiNode> {
  return ok(
    await request.post("/api/nodes", {
      data: { board_id: boardId, type: "card", title: "", x: 0, y: 0, ...node },
    }),
    "create node",
  );
}

export async function deleteNode(request: APIRequestContext, id: string) {
  await ok(await request.delete(`/api/nodes/${id}`), "delete node");
}

export async function createEdge(
  request: APIRequestContext,
  e: {
    source_id: string;
    target_id: string;
    label?: string;
    source_handle?: string | null;
    target_handle?: string | null;
  },
): Promise<ApiEdge> {
  return ok(await request.post("/api/edges", { data: e }), "create edge");
}

export async function contents(
  request: APIRequestContext,
  boardId: string,
): Promise<{ board: ApiBoard; nodes: ApiNode[]; edges: ApiEdge[] }> {
  return ok(await request.get(`/api/boards/${boardId}/contents`), "board contents");
}

export async function nodeById(request: APIRequestContext, id: string): Promise<ApiNode> {
  return ok(await request.get(`/api/nodes/${id}`), "get node");
}

export interface ApiTrashEntry {
  id: string;
  kind: "node" | "board";
  label: string | null;
  node_type: string | null;
  context: string | null;
  summary: string | null;
  deleted_at: number;
}

export async function trash(request: APIRequestContext): Promise<ApiTrashEntry[]> {
  return ok(await request.get("/api/trash"), "list trash");
}

/** Give a board to someone by email. They become an editor unless told otherwise. */
export async function shareBoard(
  request: APIRequestContext,
  boardId: string,
  email: string,
  role: "editor" | "viewer" = "editor",
) {
  return ok<Record<string, unknown>>(
    await request.post(`/api/boards/${boardId}/members`, { data: { email, role } }),
    "share board",
  );
}

// --- workspaces, members, artefacts, files ----------------------------------

export interface ApiWorkspace {
  id: string;
  name: string;
  owner_id: string;
  personal: number;
  role: "owner" | "editor" | "viewer";
}

export async function listWorkspaces(request: APIRequestContext): Promise<ApiWorkspace[]> {
  return ok(await request.get("/api/workspaces"), "list workspaces");
}

export async function createWorkspace(request: APIRequestContext, name: string): Promise<ApiWorkspace> {
  return ok(await request.post("/api/workspaces", { data: { name } }), "create workspace");
}

/** The three things access can be granted on; the URL segment each uses. */
export type Shareable = "workspaces" | "boards" | "artefacts";

export interface ApiMembers {
  members: { user_id: string; email: string; name: string | null; role: "editor" | "viewer"; created_at: number }[];
  pending: { token: string; email: string; role: "editor" | "viewer" }[];
}

export async function membersOf(request: APIRequestContext, kind: Shareable, id: string): Promise<ApiMembers> {
  return ok(await request.get(`/api/${kind}/${id}/members`), `members of ${kind}/${id}`);
}

/** Invite by email. Returns `{ added }` for an existing account, `{ invited }` for a pending invite. */
export async function addMember(
  request: APIRequestContext,
  kind: Shareable,
  id: string,
  email: string,
  role: "editor" | "viewer" = "editor",
) {
  return ok<{
    added?: { userId: string; email: string; role: string };
    invited?: { token: string; email: string; role: string };
  }>(await request.post(`/api/${kind}/${id}/members`, { data: { email, role } }), `invite to ${kind}/${id}`);
}

/** A card/artefact node with the given type, made through the real create route. */
export async function createArtefact(
  request: APIRequestContext,
  boardId: string,
  type: "sheet" | "doc" | "deck" | "html" | "file" | "folder",
  node: Record<string, unknown> = {},
): Promise<ApiNode> {
  return createNode(request, boardId, { type, ...node } as Partial<Omit<ApiNode, "id" | "board_id">>);
}

export interface ApiFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
  description: string;
  uploadedBy: string | null;
  url?: string;
}

/** Upload one file to a file/folder node, the way the app does (metadata in headers). */
export async function uploadFile(
  request: APIRequestContext,
  nodeId: string,
  f: { name: string; type: string; data: Buffer | string; description?: string },
) {
  const body = typeof f.data === "string" ? Buffer.from(f.data) : f.data;
  return request.post(`/api/nodes/${nodeId}/files`, {
    data: body,
    headers: {
      "content-type": f.type,
      "x-file-name": encodeURIComponent(f.name),
      ...(f.description ? { "x-file-description": encodeURIComponent(f.description) } : {}),
    },
  });
}

export async function listFiles(request: APIRequestContext, nodeId: string): Promise<ApiFile[]> {
  return (await ok<{ files: ApiFile[] }>(await request.get(`/api/nodes/${nodeId}/files`), "list files")).files;
}

/** Create a public link on an artefact. */
export async function createLink(request: APIRequestContext, nodeId: string) {
  return ok<{ token: string; url: string }>(await request.post(`/api/artefacts/${nodeId}/share`, { data: {} }), "create link");
}
