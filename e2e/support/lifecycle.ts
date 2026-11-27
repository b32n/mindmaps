// The organisation lifecycle through the real HTTP API: rename, close and
// reopen, leave, pending invitations, and moving a mindmap between workspaces.
import type { APIRequestContext } from "@playwright/test";

export const renameWorkspace = (request: APIRequestContext, ws: string, name: unknown) =>
  request.patch(`/api/workspaces/${ws}`, { data: { name } });

export const closeWorkspace = (request: APIRequestContext, ws: string) => request.post(`/api/workspaces/${ws}/close`);

export const reopenWorkspace = (request: APIRequestContext, ws: string) => request.post(`/api/workspaces/${ws}/reopen`);

export interface ClosedWorkspace {
  id: string;
  name: string;
  closed_at: number;
  reopen_until: number;
  reopenable: boolean;
}

export async function closedWorkspaces(request: APIRequestContext): Promise<ClosedWorkspace[]> {
  const res = await request.get("/api/workspaces/closed");
  if (!res.ok()) throw new Error(`closed list: ${res.status()} ${await res.text()}`);
  return (await res.json()) as ClosedWorkspace[];
}

export const leaveWorkspace = (request: APIRequestContext, ws: string, myId: string) =>
  request.delete(`/api/workspaces/${ws}/members/${myId}`);

export interface PendingInviteForMe {
  token: string;
  target_type: "workspace" | "board" | "node";
  target_id: string;
  target_name: string;
  role: "viewer" | "editor";
  invited_by: { email: string; name: string | null };
  created_at: number;
}

export async function pendingInvites(request: APIRequestContext): Promise<PendingInviteForMe[]> {
  const res = await request.get("/api/invites");
  if (!res.ok()) throw new Error(`invites: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { invites: PendingInviteForMe[] }).invites;
}

export const acceptInvite = (request: APIRequestContext, token: string) => request.post(`/api/invites/${token}/accept`);
export const declineInvite = (request: APIRequestContext, token: string) => request.post(`/api/invites/${token}/decline`);

export const moveBoard = (request: APIRequestContext, boardId: string, workspaceId: string) =>
  request.post(`/api/boards/${boardId}/move`, { data: { workspace_id: workspaceId } });
