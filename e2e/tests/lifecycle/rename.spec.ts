import { test, expect } from "../../fixtures";
import { createWorkspace, listWorkspaces } from "../../support/api";
import { renameWorkspace } from "../../support/lifecycle";
import { makeOrg } from "../../support/org";
import { query } from "../../support/versions";

// Renaming a shared workspace: owner and admins only, validated, and recorded
// with `updated_at`. A personal home is not an organisation and has no name to
// change.

const nameOf = async (request: any, ws: string) => (await listWorkspaces(request)).find((w) => w.id === ws)?.name;

test.describe("who may rename", () => {
  test("the owner renames, and every member sees the new name", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Before");
    const res = await renameWorkspace(request, org.ws.id, "After");
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ id: org.ws.id, name: "After" });
    for (const who of [request, org.admin.request, org.editor.request, org.viewer.request])
      expect(await nameOf(who, org.ws.id)).toBe("After");
  });

  test("an admin renames", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Before");
    expect((await renameWorkspace(org.admin.request, org.ws.id, "By admin")).status()).toBe(200);
    expect(await nameOf(request, org.ws.id)).toBe("By admin");
  });

  test("an editor and a viewer are refused and nothing changes", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Stays");
    for (const who of [org.editor, org.viewer]) {
      expect((await renameWorkspace(who.request, org.ws.id, "Nope")).status()).toBe(403);
    }
    expect(await nameOf(request, org.ws.id)).toBe("Stays");
  });

  test("an outsider gets the same answer as for a workspace that does not exist", async ({ account, request, makePerson }) => {
    void account;
    const ws = await createWorkspace(request, "Private");
    const stranger = await makePerson("stranger");
    const real = await renameWorkspace(stranger.request, ws.id, "Nope");
    const missing = await renameWorkspace(stranger.request, "00000000-0000-0000-0000-000000000000", "Nope");
    expect(real.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(await real.text()).toBe(await missing.text());
    expect(await nameOf(request, ws.id)).toBe("Private");
  });

  test("signed out is refused", async ({ account, request, playwright, baseURL }) => {
    void account;
    const ws = await createWorkspace(request, "Private");
    const anon = await playwright.request.newContext({ baseURL });
    expect((await renameWorkspace(anon, ws.id, "Nope")).status()).toBe(401);
    await anon.dispose();
  });
});

test.describe("what a name may be", () => {
  test("is trimmed", async ({ account, request }) => {
    void account;
    const ws = await createWorkspace(request, "Old");
    const res = await renameWorkspace(request, ws.id, "   Spaced out  ");
    expect(res.status()).toBe(200);
    expect(await nameOf(request, ws.id)).toBe("Spaced out");
  });

  test("must be a non-empty string of at most 80 characters, with no control characters", async ({ account, request }) => {
    void account;
    const ws = await createWorkspace(request, "Keep me");
    for (const bad of ["", "   ", "x".repeat(81), "line\nbreak", "bell\u0007", null, 42, { a: 1 }, ["a"], undefined]) {
      const res = await renameWorkspace(request, ws.id, bad);
      expect(res.status(), JSON.stringify(bad)).toBe(400);
    }
    expect(await nameOf(request, ws.id)).toBe("Keep me");
    expect((await renameWorkspace(request, ws.id, "x".repeat(80))).status()).toBe(200);
  });

  test("another workspace may share it: names are labels, not keys", async ({ account, request }) => {
    void account;
    const a = await createWorkspace(request, "Alpha");
    const b = await createWorkspace(request, "Beta");
    expect((await renameWorkspace(request, b.id, "Alpha")).status()).toBe(200);
    expect(await nameOf(request, a.id)).toBe("Alpha");
  });
});

test.describe("the record", () => {
  test("updated_at moves on a rename and the creation time does not", async ({ account, request }) => {
    void account;
    const ws = await createWorkspace(request, "Timed");
    const before = (await query<any>(`SELECT created_at, updated_at FROM workspaces WHERE id = ?`, [ws.id]))[0];
    await new Promise((r) => setTimeout(r, 20));
    expect((await renameWorkspace(request, ws.id, "Timed again")).status()).toBe(200);
    const after = (await query<any>(`SELECT created_at, updated_at, name FROM workspaces WHERE id = ?`, [ws.id]))[0];
    expect(after.name).toBe("Timed again");
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).toBeGreaterThan(before.updated_at ?? before.created_at);
    // and the list says when
    expect((await listWorkspaces(request)).find((w) => w.id === ws.id)).toMatchObject({ updated_at: after.updated_at });
  });

  test("a refused rename leaves updated_at alone", async ({ account, request, makePerson }) => {
    void account;
    const org = await makeOrg(request, makePerson, "Quiet");
    const before = (await query<any>(`SELECT updated_at FROM workspaces WHERE id = ?`, [org.ws.id]))[0].updated_at;
    await renameWorkspace(org.editor.request, org.ws.id, "Nope");
    await renameWorkspace(request, org.ws.id, "");
    expect((await query<any>(`SELECT updated_at FROM workspaces WHERE id = ?`, [org.ws.id]))[0].updated_at).toBe(before);
  });
});

test.describe("personal homes", () => {
  test("cannot be renamed: it is a home, not an organisation", async ({ account, request }) => {
    void account;
    const home = (await listWorkspaces(request)).find((w) => w.personal)!;
    const res = await renameWorkspace(request, home.id, "My empire");
    expect(res.status()).toBe(400);
    expect((await listWorkspaces(request)).find((w) => w.personal)?.name).toBe("Personal");
  });
});
