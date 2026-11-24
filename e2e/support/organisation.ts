// The organisation through the real HTTP API: who may create it, and what a
// person sees of it. See docs/MODES.md and worker/src/organisation.ts.
import { expect, type APIRequestContext } from "@playwright/test";
import { register } from "../fixtures";
import { newUser, type TestUser } from "./users";

export type OrgState = "disabled" | "setup" | "waiting" | "member" | "outside" | "available";

export interface OrgInfo {
  mode: "personal" | "org" | "multitenant";
  state: OrgState;
  can_create: boolean;
  /** Org mode, member: the organisation. */
  organisation: { workspace_id: string; name: string; role: "owner" | "admin" | "editor" | "viewer" } | null;
  /** Org mode, setup: the shared workspaces this person owns that could become the organisation. */
  adoptable: { id: string; name: string }[];
  /** Org mode, outsider: should the app show only the "ask for an invite" page. */
  gated: boolean;
}

export async function organisation(request: APIRequestContext): Promise<OrgInfo> {
  const res = await request.get("/api/organisation");
  expect(res.status(), `organisation: ${await res.text()}`).toBe(200);
  return (await res.json()) as OrgInfo;
}

export const createOrganisation = (request: APIRequestContext, data: Record<string, unknown>) =>
  request.post("/api/organisation", { data });

/** Register a new account on whichever Worker `request` points at. */
export async function signUp(request: APIRequestContext, label = "person"): Promise<TestUser> {
  const user = newUser(label);
  await register(request, user);
  return user;
}

/** The status and the machine-readable code of a refusal. */
export async function refusal(res: Awaited<ReturnType<APIRequestContext["post"]>>) {
  return { status: res.status(), code: ((await res.json().catch(() => ({}))) as { code?: string }).code };
}
