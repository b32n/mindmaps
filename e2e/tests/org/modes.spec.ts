import { test, expect } from "../../fixtures";
import { createBoard, createWorkspace, inviteRaw, listBoards, listWorkspaces } from "../../support/api";
import { createOrganisation, organisation, refusal } from "../../support/organisation";
import { acceptInvite, pendingInvites } from "../../support/lifecycle";
import { MAIN_PORT, modeWorkers } from "../../support/hosts";

// What creating an organisation means in each mode. These run on the shared
// Workers (sign-up open), so none of them creates THE organisation of the org
// Worker: that is first-run-api.spec.ts, on Workers of their own.

const MAIN = `http://127.0.0.1:${MAIN_PORT}`;

test.describe("personal: no organisation, anywhere", () => {
  test.use({ baseURL: modeWorkers.personal.baseURL });

  test("the API says it is off, with a code", async ({ account, request }) => {
    void account;
    expect(await organisation(request)).toMatchObject({ mode: "personal", state: "disabled", can_create: false, organisation: null, adoptable: [] });
    expect(await refusal(await createOrganisation(request, { name: "Acme" }))).toEqual({ status: 403, code: "team_spaces_disabled" });
    expect(await refusal(await request.post("/api/workspaces", { data: { name: "Acme" } }))).toEqual({
      status: 403,
      code: "team_spaces_disabled",
    });
    expect((await listWorkspaces(request)).filter((w) => !w.personal)).toEqual([]);
  });

  test("sharing a mindmap with one person still works, exactly as before", async ({ account, request, makePerson }) => {
    void account;
    const friend = await makePerson("friend");
    const board = await createBoard(request, "Notes");
    const sent = await inviteRaw(request, "boards", board.id, friend.user.email, "viewer");
    expect(sent.added ?? sent.invited).toBeTruthy();
    expect((await listBoards(friend.request)).map((b) => b.id)).toContain(board.id);
    expect((await friend.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
  });
});

for (const [name, baseURL] of [
  ["unset", MAIN],
  ["multitenant", modeWorkers.multitenant.baseURL],
  ["empty", modeWorkers.empty.baseURL],
] as const) {
  test.describe(`${name} (multitenant): anyone creates organisations, as many as they like`, () => {
    test.use({ baseURL });

    test("state, creation, and the old route side by side", async ({ account, request }) => {
      void account;
      expect(await organisation(request)).toMatchObject({ mode: "multitenant", state: "available", can_create: true, organisation: null });

      const res = await createOrganisation(request, { name: " Acme " });
      expect(res.status()).toBe(201);
      const acme = await res.json();
      expect(acme).toMatchObject({ name: "Acme", personal: 0, role: "owner" });
      // a second one is fine here: this is the hosted service
      expect((await createOrganisation(request, { name: "Beta" })).status()).toBe(201);
      // the route the app has always used is unchanged
      expect((await createWorkspace(request, "Gamma")).name).toBe("Gamma");
      expect((await listWorkspaces(request)).filter((w) => !w.personal).map((w) => w.name)).toEqual(["Acme", "Beta", "Gamma"]);
    });

    test("a name is required, and it is only a label", async ({ account, request }) => {
      void account;
      expect(await refusal(await createOrganisation(request, { name: "  " }))).toEqual({ status: 400, code: "invalid_name" });
      expect(await refusal(await createOrganisation(request, {}))).toEqual({ status: 400, code: "invalid_name" });
    });

    test("it cannot adopt a workspace, which is an org-mode step", async ({ account, request }) => {
      void account;
      const ws = await createWorkspace(request, "Existing");
      expect(await refusal(await createOrganisation(request, { workspace_id: ws.id, name: "X" }))).toEqual({
        status: 400,
        code: "adopt_not_available",
      });
    });

    test("the people in it: an invited person joins by accepting, as for any workspace", async ({ account, request, makePerson }) => {
      void account;
      const org = await (await createOrganisation(request, { name: "Acme" })).json();
      const hire = await makePerson("hire");
      await inviteRaw(request, "workspaces", org.id, hire.user.email, "editor");
      const [invite] = await pendingInvites(hire.request);
      expect((await acceptInvite(hire.request, invite.token)).status()).toBe(200);
      expect((await listWorkspaces(hire.request)).find((w) => w.id === org.id)).toMatchObject({ role: "editor" });
      // nothing about being a member of one organisation stops them making their own
      expect((await createOrganisation(hire.request, { name: "Theirs" })).status()).toBe(201);
    });
  });
}

test.describe("org on a shared Worker: creating a workspace is not a way round the single organisation", () => {
  test.use({ baseURL: modeWorkers.org.baseURL });

  test("POST /api/workspaces is refused whatever the state", async ({ account, request }) => {
    void account;
    const r = await refusal(await request.post("/api/workspaces", { data: { name: "Side door" } }));
    expect(r.status).toBe(409);
    expect(["organisation_exists", "organisation_setup_required"]).toContain(r.code);
    expect((await listWorkspaces(request)).filter((w) => !w.personal)).toEqual([]);
  });
});
