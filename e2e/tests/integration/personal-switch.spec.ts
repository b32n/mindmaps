import { test, expect } from "@playwright/test";
import { PrivateWorker } from "../../support/private-worker";
import { createBoard, inviteRaw, listBoards } from "../../support/api";
import { createOrganisation, signUp } from "../../support/organisation";

// An org-mode instance switched to personal (docs/MODES.md): team spaces are
// hidden and nothing new goes into them. That includes the organisation
// lifecycle's invitations and moves.

test.describe("org switched to personal", () => {
  let w: PrivateWorker;
  test.beforeEach(async () => {
    w = await new PrivateWorker({ mode: "org", signup: "open" }).start();
  });
  test.afterEach(async () => w.dispose());

  test("a pending workspace invitation is not listed or accepted; one to a mindmap still is", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();
    const board = await createBoard(owner, "Shared with Bea");

    const bea = await w.client();
    const beaUser = await signUp(bea, "bea");
    const toOrg = (await inviteRaw(owner, "workspaces", org.id, beaUser.email)).invited!;
    const toBoard = await inviteRaw(owner, "boards", board.id, beaUser.email, "viewer");
    expect(toBoard.added).toBeTruthy(); // a mindmap share is immediate, in any mode

    await w.restart("personal");

    const listed = ((await (await bea.get("/api/invites")).json()) as { invites: { token: string }[] }).invites;
    expect(listed.map((i) => i.token)).not.toContain(toOrg.token);
    const accept = await bea.post(`/api/invites/${toOrg.token}/accept`);
    expect(accept.status()).toBe(403);
    expect((await accept.json()).code).toBe("team_spaces_disabled");
    // the invitation is untouched: switching back offers it again
    await w.restart("org");
    const back = ((await (await bea.get("/api/invites")).json()) as { invites: { token: string }[] }).invites;
    expect(back.map((i) => i.token)).toContain(toOrg.token);
    expect((await bea.post(`/api/invites/${toOrg.token}/accept`)).status()).toBe(200);
    expect((await listBoards(bea)).map((b) => b.id)).toContain(board.id);
  });

  test("a mindmap cannot be moved into a hidden team space, and can be moved out", async () => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();
    const inOrg = await createBoard(owner, "In the organisation", { workspace_id: org.id });

    await w.restart("personal");

    const home = ((await (await owner.get("/api/workspaces")).json()) as { id: string; personal: number }[]).find((x) => x.personal)!;
    const mine = await createBoard(owner, "At home");
    const into = await owner.post(`/api/boards/${mine.id}/move`, { data: { workspace_id: org.id } });
    expect(into.status()).toBe(403);
    expect((await into.json()).code).toBe("team_spaces_disabled");

    const out = await owner.post(`/api/boards/${inOrg.id}/move`, { data: { workspace_id: home.id } });
    expect(out.status(), await out.text()).toBe(200);
  });
});
