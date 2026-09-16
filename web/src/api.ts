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
  | "ticket" | "pr" | "session";

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
  /** The same ranking the MCP `recall` tool runs, as data. */
  recall: (q: string, signal?: AbortSignal) =>
    req<RecallResult>(`/recall?q=${encodeURIComponent(q)}`, { signal }),

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
};
