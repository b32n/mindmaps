// Same-origin by default: Vite proxies /api to the Worker in dev, and in
// production the Worker is served from the same domain. Keeps the session
// cookie first-party.
const BASE = import.meta.env.VITE_API_URL ?? "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    credentials: "include", // send the session cookie
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export type NodeType =
  | "note" | "card" | "image" | "stroke"
  | "ticket" | "pr" | "session"
  // Artefacts: payload in R2, pointer and snapshot in D1 (ARTEFACTS.md §3).
  | "sheet" | "doc" | "deck" | "html"
  // Uploads: bytes in R2, one row per file in D1. A `file` holds one, a
  // `folder` holds many; both are otherwise ordinary nodes.
  | "file" | "folder";

export interface Workspace {
  id: string;
  name: string;
  owner_id: string;
  personal: number;
  role: "owner" | "editor" | "viewer";
}

export interface Member {
  user_id: string;
  email: string;
  name: string | null;
  role: "owner" | "editor" | "viewer";
  created_at: number;
}

export interface PendingInvite {
  token: string;
  email: string;
  role: "viewer" | "editor";
}

/** A share link, as its owner sees it. */
export interface Share {
  token: string;
  url: string;
  expires_at: number | null;
  revoked: number;
  created_at: number;
  last_seen_at: number | null;
  views: number;
}

/** What a share token resolves to, for whoever holds the link. */
export interface SharedArtefact {
  kind: "sheet" | "doc" | "deck" | "html";
  title: string;
  /** Null for `html`, which renders in the mindbox rather than from a payload. */
  payload: unknown;
  /** The mindbox URL for `html`, null otherwise. */
  frame: string | null;
}

/** One artefact, as the Artefacts list shows it. */
export interface ArtefactEntry {
  id: string;
  type: "sheet" | "doc" | "deck" | "html";
  title: string;
  /** The pointer and counts from `nodes.data`; no R2 read needed to describe it. */
  data: Record<string, unknown>;
  updated_at: number;
  board_id: string;
  board_name: string;
}

/** One deleted thing, as the trash list shows it. */
export interface TrashEntry {
  id: string;
  kind: "node" | "board";
  label: string | null;
  node_type: string | null;
  /** The mindmap a node came from. Null for a mindmap. */
  context: string | null;
  /** For a mindmap, what it held: "12 cards, 2 sheets". */
  summary: string | null;
  deleted_at: number;
}

export interface BoardNode {
  id: string;
  board_id: string;
  type: NodeType;
  title: string;
  /** plain-text projection of `doc`, for the collapsed card preview */
  body: string;
  /** Legacy BlockNote JSON. Markdown in `body` is the document now. */
  doc?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  data: Record<string, unknown>;
  /** latest research thread status, or null if the card has none */
  thread?: string | null;
}

export interface RecallHit {
  id: string;
  title: string;
  board_id: string;
  board_name: string;
  /** The passage that matched, or the head of the document if none did. */
  passage: string;
  truncated: boolean;
  why: string[];
  superseded: boolean;
  links: Array<{ id: string; title: string; label: string; board_id: string; board_name: string }>;
}

export interface RecallResult {
  hits: RecallHit[];
  found: number;
  degraded?: string;
}

export interface Board {
  id: string;
  name: string;
  /** active | at-risk | paused — rendered as the dot in the rail */
  status: string;
  parent_id: string | null;
  node_id: string | null;
  /** JSON BoardView: the declared default pan/zoom/open card, or null */
  home_view?: string | null;
  /** Which workspace this mindmap belongs to. */
  workspace_id?: string | null;
  /**
   * How many people this one mindmap has been handed to directly.
   *
   * Workspace members are not counted: everything in a workspace is visible to
   * everyone in it, so a badge on every board would carry no information.
   */
  shared_with?: number;
  /** Manual rail order, set by dragging. Null on rows that predate it. */
  position?: number | null;
  /** What belongs on this mindmap. Read by `list_mindmaps`, so agents use it. */
  description?: string | null;
  labels: string[];
  pinned: boolean;
}

export interface BoardEdge {
  id: string;
  source_id: string;
  target_id: string;
  /** which side of the card each end attaches to: top|right|bottom|left */
  source_handle?: string | null;
  target_handle?: string | null;
  label: string;
  /**
   * Where each end lives. An edge is not owned by a board, so either end may
   * sit on a different mindmap — that end renders as a stub pointing away.
   */
  source_board?: string;
  target_board?: string;
  source_title?: string;
  target_title?: string;
  source_board_name?: string;
  target_board_name?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

export const auth = {
  me: () => req<{ user: User | null; googleEnabled: boolean }>("/auth/me"),
  register: (email: string, password: string, name: string) =>
    req<{ user: User }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    }),
  login: (email: string, password: string) =>
    req<{ user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => req<{ ok: true }>("/auth/logout", { method: "POST" }),

  /** Harnesses connected over MCP, grouped by client. */
  connections: () => req<Connection[]>("/auth/connections"),
  disconnect: (clientId: string) =>
    req<{ ok: true; revoked: number }>(`/auth/connections/${clientId}`, { method: "DELETE" }),
};

export interface Connection {
  client_id: string;
  client_name: string;
  /** live tokens for this client — refresh rotation mints a new one each time */
  tokens: number;
  first_seen: number;
  last_seen: number;
  scope: string;
}

export const api = {
  /** Upload a pasted or dropped image; returns a URL for the editor. */
  uploadImage: async (file: File): Promise<string> => {
    const res = await fetch(`${BASE}/api/images`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!res.ok) throw new Error(`image upload failed: ${res.status}`);
    return ((await res.json()) as { url: string }).url;
  },

  listBoards: () => req<Board[]>("/boards"),

  createBoard: (b: Partial<Board>) =>
    req<Board>("/boards", { method: "POST", body: JSON.stringify(b) }),

  updateBoard: (id: string, patch: Partial<Board>) =>
    req<Board>(`/boards/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteBoard: (id: string) => req<{ ok: true }>(`/boards/${id}`, { method: "DELETE" }),

  /** Titles only — for menus, where full documents would be wasteful. */
  /** An artefact's payload, from R2. Only the editor route calls this. */
  artefact: (nodeId: string) => req<unknown>(`/artefacts/${nodeId}`),

  saveArtefact: (nodeId: string, payload: unknown) =>
    req<{ ok: true; sheets: number; cells: number }>(`/artefacts/${nodeId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  node: (id: string) => req<BoardNode>(`/nodes/${id}`),

  /**
   * A signed, expiring URL that renders an HTML artefact in the mindbox.
   *
   * Minted per render rather than derived from the id: the mindbox holds no
   * session, so this signature is the only thing standing between a URL and
   * someone else's page.
   */
  artefactFrame: (nodeId: string) => req<{ url: string }>(`/artefacts/${nodeId}/frame`),

  // --- workspaces and members ---
  workspaces: () => req<Workspace[]>("/workspaces"),

  createWorkspace: (name: string) =>
    req<Workspace>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),

  /** `kind` is the route segment: workspaces, boards or artefacts. */
  members: (kind: "workspaces" | "boards" | "artefacts", id: string) =>
    req<{ members: Member[]; pending: PendingInvite[] }>(`/${kind}/${id}/members`),

  addMember: (
    kind: "workspaces" | "boards" | "artefacts",
    id: string,
    email: string,
    role: "viewer" | "editor",
  ) =>
    req<{ added?: { email: string }; invited?: { email: string } }>(`/${kind}/${id}/members`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),

  removeMember: (kind: "workspaces" | "boards" | "artefacts", id: string, userId: string) =>
    req<{ ok: true }>(`/${kind}/${id}/members/${userId}`, { method: "DELETE" }),

  revokeInvite: (token: string) => req<{ ok: true }>(`/invites/${token}`, { method: "DELETE" }),

  /** Every artefact the user owns, newest first, across all mindmaps. */
  artefacts: () => req<ArtefactEntry[]>("/artefacts"),

  // --- sharing ---
  shares: (nodeId: string) => req<Share[]>(`/artefacts/${nodeId}/share`),

  createShare: (nodeId: string, expiresAt?: number | null) =>
    req<Share>(`/artefacts/${nodeId}/share`, {
      method: "POST",
      body: JSON.stringify({ expires_at: expiresAt ?? null }),
    }),

  revokeShare: (token: string) => req<{ ok: true }>(`/shares/${token}`, { method: "DELETE" }),

  /** Resolve a share link. The one call that works with no session. */
  shared: (token: string) => req<SharedArtefact>(`/shared/${token}`),

  /** The same ranking the MCP `recall` tool runs, as data. */
  recall: (q: string, signal?: AbortSignal, workspaceId?: string | null) =>
    req<RecallResult>(
      `/recall?q=${encodeURIComponent(q)}${workspaceId ? `&workspace=${workspaceId}` : ""}`,
      { signal },
    ),

  boardCards: (boardId: string) =>
    req<Array<{ id: string; title: string; type: string }>>(`/boards/${boardId}/cards`),

  contents: (boardId: string) =>
    req<{ board: Board; nodes: BoardNode[]; edges: BoardEdge[] }>(
      `/boards/${boardId}/contents`,
    ),

  createNode: (n: Partial<BoardNode>) =>
    req<BoardNode>("/nodes", { method: "POST", body: JSON.stringify(n) }),

  updateNode: (id: string, patch: Partial<BoardNode>) =>
    req<{ ok: true }>(`/nodes/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteNode: (id: string) => req<{ ok: true }>(`/nodes/${id}`, { method: "DELETE" }),

  // --- trash ---
  // Deleting archives rather than destroys; these are the ways back out.
  trash: () => req<TrashEntry[]>("/trash"),

  restoreTrash: (id: string) =>
    req<{ ok: true; board_id: string }>(`/trash/${id}/restore`, { method: "POST" }),

  purgeTrash: (id: string) => req<{ ok: true }>(`/trash/${id}`, { method: "DELETE" }),

  emptyTrash: () => req<{ ok: true; removed: number }>("/trash/empty", { method: "POST" }),

  reorderBoards: (ids: string[]) =>
    req<{ ok: true }>("/boards/reorder", { method: "POST", body: JSON.stringify({ ids }) }),

  createEdge: (e: Partial<BoardEdge>) =>
    req<BoardEdge>("/edges", { method: "POST", body: JSON.stringify(e) }),

  updateEdge: (
    id: string,
    patch: {
      label?: string;
      source_id?: string;
      target_id?: string;
      source_handle?: string | null;
      target_handle?: string | null;
    },
  ) =>
    req<{ ok: true }>(`/edges/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteEdge: (id: string) => req<{ ok: true }>(`/edges/${id}`, { method: "DELETE" }),

  research: (nodeId: string, brief: string) =>
    req<{ session: unknown; resumed: boolean; repos?: unknown[] }>(
      `/nodes/${nodeId}/research`,
      { method: "POST", body: JSON.stringify({ brief }) },
    ),

  researchStatus: (nodeId: string) =>
    req<{
      session: { status: string } | null;
      text: string;
      outputs: { id: string; filename: string }[];
    }>(`/nodes/${nodeId}/research`),

  /** The files behind a `file` or `folder` node, each with a signed URL. */
  files: (nodeId: string) => req<{ files: StoredFile[] }>(`/nodes/${nodeId}/files`),

  /**
   * Upload one file.
   *
   * `fetch` with a `File` body rather than `FormData`, because the Worker
   * streams the body straight into R2 and multipart would force it to buffer
   * and parse the whole upload first. The metadata travels in headers,
   * URL-encoded since a header cannot carry a non-Latin-1 filename.
   */
  uploadFile: async (
    nodeId: string,
    file: File,
    description: string,
  ): Promise<{ file: StoredFile; data: Record<string, unknown>; body: string }> => {
    const res = await fetch(`${BASE}/api/nodes/${nodeId}/files`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
        "x-file-description": encodeURIComponent(description),
      },
      body: file,
    });
    if (!res.ok) {
      // The server's refusals here are written to be read by a person — the
      // size limit and the missing description both say what to do next — so
      // surface the message rather than the status.
      const said = await res.json().catch(() => null);
      throw new Error((said as { error?: string })?.error ?? `Upload failed: ${res.status}`);
    }
    return await res.json();
  },

  deleteFile: (fileId: string) => req<{ ok: true }>(`/files/${fileId}`, { method: "DELETE" }),

  updateFile: (fileId: string, patch: { name?: string; description?: string }) =>
    req<{ ok: true }>(`/files/${fileId}`, { method: "PATCH", body: JSON.stringify(patch) }),
};

export interface StoredFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
  description: string;
  uploadedAt: number;
  uploadedBy: string | null;
  /**
   * A signed, expiring URL on the mindbox origin, minted per listing.
   *
   * Null when the deployment has no `MINDBOX_SECRET`, in which case downloads
   * are unavailable rather than served unsafely from the app origin.
   */
  url?: string | null;
}
