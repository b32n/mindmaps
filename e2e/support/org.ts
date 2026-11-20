// Organisation safety through the real HTTP API: roles on a shared workspace,
// changing them, and moving ownership.
import { expect, type APIRequestContext } from "@playwright/test";
import type { Person } from "../fixtures";
import { addMember, createWorkspace, type ApiWorkspace } from "./api";
import { meId } from "./account";

export type WorkspaceRole = "admin" | "editor" | "viewer";

export const setRole = (request: APIRequestContext, ws: string, userId: string, role: string) =>
  request.patch(`/api/workspaces/${ws}/members/${userId}`, { data: { role } });

export const transferOwnership = (request: APIRequestContext, ws: string, userId: string) =>
  request.post(`/api/workspaces/${ws}/transfer`, { data: { user_id: userId } });

export const removeMemberRaw = (request: APIRequestContext, ws: string, userId: string) =>
  request.delete(`/api/workspaces/${ws}/members/${userId}`);

export interface Org {
  ws: ApiWorkspace;
  ownerId: string;
  admin: Person & { id: string };
  editor: Person & { id: string };
  viewer: Person & { id: string };
}

/**
 * A shared workspace owned by the signed-in `request`, with one admin, one
 * editor and one viewer. The admin is promoted by the owner through the API,
 * as a user would.
 */
export async function makeOrg(
  request: APIRequestContext,
  makePerson: (label?: string) => Promise<Person>,
  name = "Org",
): Promise<Org> {
  const ws = await createWorkspace(request, name);
  const ownerId = await meId(request);
  const make = async (label: string, role: "editor" | "viewer") => {
    const p = await makePerson(label);
    await addMember(request, "workspaces", ws.id, p.user.email, role);
    return { ...p, id: await meId(p.request) };
  };
  const admin = await make("admin", "editor");
  const editor = await make("editor", "editor");
  const viewer = await make("viewer", "viewer");
  const res = await setRole(request, ws.id, admin.id, "admin");
  expect(res.status(), `promote: ${await res.text()}`).toBe(200);
  return { ws, ownerId, admin, editor, viewer };
}
