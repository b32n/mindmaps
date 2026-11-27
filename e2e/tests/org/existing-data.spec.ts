import { test, expect } from "@playwright/test";
import { PrivateWorker } from "../../support/private-worker";
import { addMember, contents, createBoard, createNode, createWorkspace, listBoards, listWorkspaces } from "../../support/api";
import { createOrganisation, organisation, refusal, signUp } from "../../support/organisation";

// An install that has been running (multitenant, or before modes existed) and is
// then switched to org mode keeps everything. Nothing is migrated or hidden; the
// instance's first account decides, explicitly, which workspace is the
// organisation, or makes a new one.

test.describe("switching a populated instance to org mode", () => {
  let w: PrivateWorker;
  test.beforeEach(async () => {
    w = await new PrivateWorker({ signup: "open" }).start(); // mode unset, as before modes existed
  });
  test.afterEach(async () => w.dispose());

  /** A (first account) owns Team and Labs, B is in Team, C has only a personal space. */
  async function populate() {
    const a = await w.client(), b = await w.client(), c = await w.client();
    const ua = await signUp(a, "a"), ub = await signUp(b, "b");
    await signUp(c, "c");
    const team = await createWorkspace(a, "Team");
    const labs = await createWorkspace(a, "Labs");
    await addMember(a, "workspaces", team.id, ub.email, "editor");
    const board = await createBoard(a, "Roadmap", { workspace_id: team.id });
    const card = await createNode(a, board.id, { title: "Keep me" });
    const labsBoard = await createBoard(a, "Experiments", { workspace_id: labs.id });
    const mine = await createBoard(c, "C private");
    return { a, b, c, ua, team, labs, board, card, labsBoard, mine };
  }

  test("nothing is lost or hidden, and nobody is made the organisation silently", async () => {
    const d = await populate();
    await w.restart("org");

    expect((await listWorkspaces(d.a)).filter((x) => !x.personal).map((x) => x.name)).toEqual(["Team", "Labs"]);
    expect((await listBoards(d.a)).map((x) => x.id)).toEqual(expect.arrayContaining([d.board.id, d.labsBoard.id]));
    expect((await contents(d.a, d.board.id)).nodes.map((n) => n.id)).toContain(d.card.id);
    expect((await contents(d.b, d.board.id)).nodes.map((n) => n.id)).toContain(d.card.id);
    expect((await listBoards(d.c)).map((x) => x.id)).toContain(d.mine.id);

    // the first account is asked; it is offered what it owns; the others wait
    expect(await organisation(d.a)).toMatchObject({
      mode: "org",
      state: "setup",
      can_create: true,
      organisation: null,
      gated: false,
      adoptable: [{ name: "Team" }, { name: "Labs" }].map((x) => expect.objectContaining(x)),
    });
    expect(await organisation(d.b)).toMatchObject({ state: "waiting", can_create: false, adoptable: [] });
    expect(await organisation(d.c)).toMatchObject({ state: "waiting", can_create: false });
  });

  test("until it is chosen, no new shared workspaces appear", async () => {
    const d = await populate();
    await w.restart("org");
    expect(await refusal(await d.a.post("/api/workspaces", { data: { name: "More" } }))).toEqual({ status: 409, code: "organisation_setup_required" });
    expect(await refusal(await d.b.post("/api/workspaces", { data: { name: "More" } }))).toEqual({ status: 409, code: "organisation_setup_required" });
  });

  test("only the first account can choose, and only a workspace it owns", async () => {
    const d = await populate();
    await w.restart("org");
    expect(await refusal(await createOrganisation(d.b, { workspace_id: d.team.id }))).toEqual({ status: 403, code: "not_instance_owner" });
    expect(await refusal(await createOrganisation(d.c, { name: "Mine" }))).toEqual({ status: 403, code: "not_instance_owner" });

    const personal = (await listWorkspaces(d.a)).find((x) => x.personal)!;
    expect(await refusal(await createOrganisation(d.a, { workspace_id: personal.id }))).toEqual({ status: 400, code: "workspace_not_adoptable" });
    expect(await refusal(await createOrganisation(d.a, { workspace_id: "no-such-id" }))).toEqual({ status: 404, code: "workspace_not_found" });
    const theirs = (await listWorkspaces(d.c)).find((x) => x.personal)!;
    expect(await refusal(await createOrganisation(d.a, { workspace_id: theirs.id }))).toEqual({ status: 404, code: "workspace_not_found" });
    expect((await organisation(d.a)).state).toBe("setup");
  });

  test("choosing Team makes it the organisation, with its people and mindmaps as they were", async () => {
    const d = await populate();
    await w.restart("org");
    const res = await createOrganisation(d.a, { workspace_id: d.team.id });
    expect(res.status()).toBe(201);
    expect(await res.json()).toMatchObject({ id: d.team.id, name: "Team", adopted: true, role: "owner" });

    expect(await organisation(d.a)).toMatchObject({ state: "member", organisation: { workspace_id: d.team.id, name: "Team", role: "owner" } });
    expect(await organisation(d.b)).toMatchObject({ state: "member", organisation: { workspace_id: d.team.id, role: "editor" } });
    // C had an account before the organisation: not shut out of what is theirs
    expect(await organisation(d.c)).toMatchObject({ state: "outside", gated: false });
    expect((await listBoards(d.c)).map((x) => x.id)).toContain(d.mine.id);
    // Labs is still there, still Alice's, and still works
    expect((await listWorkspaces(d.a)).map((x) => x.id)).toContain(d.labs.id);
    expect((await contents(d.a, d.labsBoard.id)).board.id).toBe(d.labsBoard.id);
    // and that is the one organisation
    expect(await refusal(await createOrganisation(d.a, { name: "Another" }))).toEqual({ status: 409, code: "organisation_exists" });
    expect(await refusal(await createOrganisation(d.a, { workspace_id: d.labs.id }))).toEqual({ status: 409, code: "organisation_exists" });
  });

  test("or the first account makes a brand new one, and the old workspaces stay", async () => {
    const d = await populate();
    await w.restart("org");
    const res = await createOrganisation(d.a, { name: "Fresh" });
    expect(res.status()).toBe(201);
    expect(await res.json()).toMatchObject({ name: "Fresh", adopted: false });
    expect((await listWorkspaces(d.a)).filter((x) => !x.personal).map((x) => x.name)).toEqual(["Team", "Labs", "Fresh"]);
    expect((await organisation(d.b)).state).toBe("outside");
    expect((await contents(d.b, d.board.id)).nodes.map((n) => n.id)).toContain(d.card.id);
  });

  test("switching back to multitenant leaves the data alone and lets people create again", async () => {
    const d = await populate();
    await w.restart("org");
    await createOrganisation(d.a, { workspace_id: d.team.id });
    await w.restart("multitenant");
    expect(await organisation(d.a)).toMatchObject({ mode: "multitenant", state: "available", can_create: true });
    expect((await createWorkspace(d.a, "Again")).name).toBe("Again");
    expect((await contents(d.b, d.board.id)).nodes.map((n) => n.id)).toContain(d.card.id);
    // and org again later finds the organisation it had
    await w.restart("org");
    expect(await organisation(d.b)).toMatchObject({ state: "member", organisation: { workspace_id: d.team.id } });
  });

  test("personal hides nothing it did not before: the data is simply not offered for creation", async () => {
    const d = await populate();
    await w.restart("personal");
    expect(await organisation(d.a)).toMatchObject({ mode: "personal", state: "disabled", can_create: false });
    expect((await contents(d.b, d.board.id)).nodes.map((n) => n.id)).toContain(d.card.id);
  });
});
