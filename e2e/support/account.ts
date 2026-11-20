// Account export and deletion through the real HTTP API, and a way to read what
// the server kept (out of band, read-only, like support/versions.ts).
import { expect, type APIRequestContext } from "@playwright/test";
import type { TestUser } from "./users";
import { readZip } from "./zip";

export async function meId(request: APIRequestContext): Promise<string> {
  const me = await (await request.get("/api/auth/me")).json();
  return me.user.id as string;
}

/** Download the export as the signed-in user and open it. */
export async function exportZip(request: APIRequestContext) {
  const res = await request.get("/api/account/export");
  expect(res.status(), `export: ${res.status()}`).toBe(200);
  const body = await res.body();
  return { res, zip: readZip(body), body };
}

export const deleteAccount = (request: APIRequestContext, data: Record<string, unknown>) =>
  request.delete("/api/account", { data });

/** Delete as the user would: typing their own email. */
export async function deleteWithEmail(request: APIRequestContext, user: Pick<TestUser, "email">) {
  const res = await deleteAccount(request, { email: user.email });
  expect(res.status(), `delete: ${await res.text()}`).toBe(200);
}
