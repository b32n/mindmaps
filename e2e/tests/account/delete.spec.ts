import { test, expect, register } from "../../fixtures";
import {
  addMember, createArtefact, createBoard, createLink, createNode, createWorkspace, listBoards, listFiles, listWorkspaces, membersOf, shareBoard, uploadFile,
} from "../../support/api";
import { deleteAccount, deleteWithEmail, meId } from "../../support/account";
import { connectMcp } from "../../support/mcp";
import { newUser } from "../../support/users";
import { query } from "../../support/versions";

// Account deletion: DELETE /api/account with a typed confirmation. The user row
// is kept but marked (status, deleted_at) and scrubbed; sessions and tokens go;
// what they own is deleted and unreachable; grants to others stop working.

const SHEET = [{ name: "Q1", rows: [["item", "cost"], ["tea", 3]] }];

test.describe("confirming", () => {
  test("needs a session", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    expect((await deleteAccount(anon, { email: "x@example.test" })).status()).toBe(401);
    await anon.dispose();
  });

  test("a missing or wrong confirmation deletes nothing", async ({ account, request }) => {
    const board = await createBoard(request, "Survives");
    for (const body of [{}, { email: "" }, { email: "someone-else@example.test" }, { password: "wrong-Password-1!" }, { email: 42 }]) {
      const res = await deleteAccount(request, body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toMatch(/confirm/i);
    }
    expect((await request.get("/api/auth/me")).status()).toBe(200);
    expect((await listBoards(request)).some((b) => b.id === board.id)).toBe(true);
    void account;
  });

  test("the email is matched without regard to case or surrounding space", async ({ account, request }) => {
    const res = await deleteAccount(request, { email: `  ${account.email.toUpperCase()} ` });
    expect(res.status()).toBe(200);
  });

  test("the account's password confirms it just as well", async ({ account, request }) => {
    const res = await deleteAccount(request, { password: account.password });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

test.describe("sessions, tokens and sign-in", () => {
  test("every session dies at once, the cookie is cleared, and the account can no longer sign in", async ({ account, request, playwright, baseURL }) => {
    const id = await meId(request);
    // a second browser session for the same account
    const other = await playwright.request.newContext({ baseURL });
    expect((await other.post("/api/auth/login", { data: { email: account.email, password: account.password } })).status()).toBe(200);
    expect((await other.get("/api/auth/me").then((r) => r.json())).user).not.toBeNull();

    const res = await deleteAccount(request, { email: account.email });
    expect(res.status()).toBe(200);
    expect(res.headers()["set-cookie"]).toMatch(/wb_session=;.*Max-Age=0/);

    for (const r of [request, other]) {
      expect((await r.get("/api/auth/me").then((x) => x.json())).user).toBeNull();
      expect((await r.get("/api/boards")).status()).toBe(401);
    }
    const again = await playwright.request.newContext({ baseURL });
    const login = await again.post("/api/auth/login", { data: { email: account.email, password: account.password } });
    expect(login.status()).toBe(401);
    expect((await login.json()).error).toBe("Email or password is incorrect.");
    await again.dispose();
    await other.dispose();

    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?`, [id]);
    expect(rows[0]!.n).toBe(0);
  });

  test("MCP tokens stop working immediately, and so does the refresh token", async ({ account, request, playwright, baseURL }) => {
    void account;
    const id = await meId(request);
    const mcp = await connectMcp(request);
    expect((await mcp.call("list_mindmaps", {})).isError).toBe(false);
    const { accessToken, refreshToken, clientId } = mcp.credentials;

    expect((await deleteAccount(request, { email: account.email })).status()).toBe(200);

    const bare = await playwright.request.newContext({ baseURL });
    const call = await bare.post("/mcp", {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_mindmaps", arguments: {} } },
    });
    expect(call.status()).toBe(401);
    const refreshed = await bare.post("/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId },
    });
    expect(refreshed.status()).toBe(400);
    expect((await refreshed.json()).error).toBe("invalid_grant");
    await bare.dispose();

    const live = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM oauth_tokens WHERE user_id = ? AND revoked = 0`, [id]);
    expect(live[0]!.n).toBe(0);
  });

  test("an unredeemed authorisation code cannot be traded for a token afterwards", async ({ account, request, playwright, baseURL }) => {
    void account;
    const { createHash, randomBytes } = await import("node:crypto");
    const redirect = "http://127.0.0.1:9/callback";
    const reg = await request.post("/oauth/register", { data: { client_name: "late", redirect_uris: [redirect] } });
    const clientId = (await reg.json()).client_id as string;
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: redirect, response_type: "code", state: "s",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    });
    const approved = await request.post(`/oauth/authorize?${q}`, { maxRedirects: 0 });
    const code = new URL(approved.headers()["location"]!).searchParams.get("code")!;

    expect((await deleteAccount(request, { email: account.email })).status()).toBe(200);

    const bare = await playwright.request.newContext({ baseURL });
    const token = await bare.post("/oauth/token", {
      form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect },
    });
    expect(token.status()).toBe(400);
    await bare.dispose();
  });
});

test.describe("what others can still reach", () => {
  test("a mindmap, an artefact grant and a link given to others stop working", async ({ account, request, makePerson, playwright, baseURL }) => {
    void account;
    const friend = await makePerson("friend");

    const board = await createBoard(request, "Handed over");
    const card = await createNode(request, board.id, { title: "GONE-CARD-7731", body: "GONE-BODY-7731" });
    await shareBoard(request, board.id, friend.user.email, "editor");

    const sheetBoard = await createBoard(request, "Sheet board");
    const sheet = await createArtefact(request, sheetBoard.id, "sheet", { title: "Granted sheet", sheets: SHEET } as any);
    await addMember(request, "artefacts", sheet.id, friend.user.email, "viewer");
    const link = await createLink(request, sheet.id);

    // before: all three work
    expect((await listBoards(friend.request)).some((b) => b.id === board.id)).toBe(true);
    expect((await friend.request.get(`/api/artefacts/${sheet.id}`)).status()).toBe(200);
    const anon = await playwright.request.newContext({ baseURL });
    expect((await anon.get(`/api/shared/${link.token}`)).status()).toBe(200);

    await deleteWithEmail(request, account);

    expect((await listBoards(friend.request)).some((b) => b.id === board.id || b.id === sheetBoard.id)).toBe(false);
    expect((await friend.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(404);
    expect((await friend.request.get(`/api/nodes/${card.id}`)).status()).toBe(404);
    expect((await friend.request.get(`/api/artefacts/${sheet.id}`)).status()).toBe(404);
    expect((await anon.get(`/api/shared/${link.token}`)).status()).toBe(404);
    const writeBack = await friend.request.post("/api/nodes", { data: { board_id: board.id, type: "card", title: "late", x: 0, y: 0 } });
    expect(writeBack.ok()).toBe(false);
    await anon.dispose();

    // the link is revoked in the table too, not merely orphaned
    const shares = await query<{ revoked: number }>(`SELECT revoked FROM shares WHERE token = ?`, [link.token]);
    expect(shares).toEqual([{ revoked: 1 }]);
    const left = await query<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM board_shares WHERE board_id = ?) + (SELECT COUNT(*) FROM artefact_grants WHERE node_id = ?) AS n`,
      [board.id, sheet.id],
    );
    expect(left[0]!.n).toBe(0);
  });

  test("a signed link to an artefact's page or file no longer serves anything", async ({ account, request }) => {
    void account;
    const board = await createBoard(request, "Files");
    const fileNode = await createArtefact(request, board.id, "file", { title: "Report" });
    expect((await uploadFile(request, fileNode.id, { name: "a.txt", type: "text/plain", data: "secret bytes" })).status()).toBe(201);
    const url = (await listFiles(request, fileNode.id))[0]!.url;
    expect(url, "the listing carries a download url").toBeTruthy();
    const path = new URL(url!, "http://x").pathname + new URL(url!, "http://x").search;
    expect((await request.get(path)).status()).toBe(200);

    await deleteWithEmail(request, account);
    expect((await request.get(path, { headers: { cookie: "" } })).status()).toBe(404);
  });

  test("content the user wrote in someone else's workspace stays there; their membership and shares to them go", async ({ account, request, makePerson }) => {
    const owner = await makePerson("owner");
    const ws = await createWorkspace(owner.request, "Owner space");
    await addMember(owner.request, "workspaces", ws.id, account.email, "editor");
    const theirs = await createBoard(owner.request, "Owner board", { workspace_id: ws.id });
    const mine = await createNode(request, theirs.id, { title: "WRITTEN-IN-OWNER-SPACE", body: "kept" });

    await deleteWithEmail(request, account);

    // the owner's workspace and what is in it are untouched
    expect((await listBoards(owner.request)).some((b) => b.id === theirs.id)).toBe(true);
    expect((await owner.request.get(`/api/nodes/${mine.id}`)).status()).toBe(200);
    const members = await membersOf(owner.request, "workspaces", ws.id);
    expect(JSON.stringify(members)).not.toContain(account.email);
    expect((await query(`SELECT 1 FROM workspace_members WHERE workspace_id = ?`, [ws.id])).length).toBe(0);
  });

  test("someone else's account and content are untouched", async ({ account, request, makePerson }) => {
    void account;
    const bystander = await makePerson("bystander");
    const board = await createBoard(bystander.request, "Bystander board");
    const card = await createNode(bystander.request, board.id, { title: "STAYS", body: "stays" });
    const before = (await listWorkspaces(bystander.request)).length;

    await deleteWithEmail(request, account);

    expect((await bystander.request.get(`/api/nodes/${card.id}`)).status()).toBe(200);
    expect((await listWorkspaces(bystander.request)).length).toBe(before);
    expect((await bystander.request.get("/api/auth/me").then((r) => r.json())).user.email).toBe(bystander.user.email);
  });
});

test.describe("the email can be used again", () => {
  test("a new sign-up with the same address works, and starts empty", async ({ account, request, playwright, baseURL }) => {
    const board = await createBoard(request, "Old life");
    const oldId = await meId(request);
    await deleteWithEmail(request, account);

    const fresh = await playwright.request.newContext({ baseURL });
    const again = newUser("again");
    again.email = account.email;
    await register(fresh, again);
    const newId = await meId(fresh);
    expect(newId).not.toBe(oldId);
    expect((await listBoards(fresh)).some((b) => b.id === board.id)).toBe(false);

    // the old password does not open the new account; the new one does
    const probe = await playwright.request.newContext({ baseURL });
    if (again.password !== account.password)
      expect((await probe.post("/api/auth/login", { data: { email: account.email, password: account.password } })).status()).toBe(401);
    expect((await probe.post("/api/auth/login", { data: { email: account.email, password: again.password } })).status()).toBe(200);
    await probe.dispose();
    await fresh.dispose();
  });

  test("the old row is marked, timestamped and scrubbed of personal data", async ({ account, request }) => {
    const id = await meId(request);
    const before = Date.now();
    await deleteWithEmail(request, account);
    const [row] = await query<Record<string, any>>(`SELECT * FROM users WHERE id = ?`, [id]);
    expect(row).toBeTruthy(); // never hard-deleted
    expect(row!.status).toBe("deleted");
    expect(row!.deleted_at).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.deleted_at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(row!.email).not.toBe(account.email);
    expect(row!.email).toMatch(/@deleted\.invalid$/);
    expect(row!.name).toBe("");
    expect(row!.avatar_url).toBeNull();
    expect(row!.password_hash).toBeNull();
    expect(row!.password_salt).toBeNull();
    expect(row!.google_sub).toBeNull();
    expect(JSON.stringify(row)).not.toContain(account.email);
    expect(JSON.stringify(row)).not.toContain(account.name);
  });

  test("an ordinary account is 'active' with no deletion time", async ({ account, request }) => {
    void account;
    const [row] = await query<Record<string, any>>(`SELECT status, deleted_at FROM users WHERE id = ?`, [await meId(request)]);
    expect(row).toEqual({ status: "active", deleted_at: null });
  });

  test("invitations the user sent that nobody has accepted are revoked", async ({ account, request }) => {
    const id = await meId(request);
    const ws = await createWorkspace(request, "Mine");
    const pending = `held-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    expect((await addMember(request, "workspaces", ws.id, pending, "viewer")).invited).toBeTruthy();
    const open = () => query<{ n: number }>(`SELECT COUNT(*) AS n FROM invites WHERE invited_by = ? AND revoked = 0 AND accepted_at IS NULL`, [id]);
    expect((await open())[0]!.n).toBe(1);
    await deleteWithEmail(request, account);
    expect((await open())[0]!.n).toBe(0);
  });
});

test.describe("what is deleted", () => {
  test("the user's mindmaps, cards and files are gone, their objects are queued for deletion, their history is redacted", async ({ account, request }) => {
    const id = await meId(request);
    const board = await createBoard(request, "To erase");
    const card = await createNode(request, board.id, { title: "ERASE-ME-9902", body: "ERASE-BODY-9902" });
    const sheet = await createArtefact(request, board.id, "sheet", { title: "ERASE-SHEET-9902", sheets: SHEET } as any);
    const fileNode = await createArtefact(request, board.id, "file", { title: "Doc" });
    expect((await uploadFile(request, fileNode.id, { name: "e.txt", type: "text/plain", data: "erase these bytes" })).status()).toBe(201);
    const fileKey = (await query<{ r2_key: string }>(`SELECT r2_key FROM files WHERE node_id = ?`, [fileNode.id]))[0]!.r2_key;
    const img = await (await request.post("/api/images", { data: Buffer.from("iVBORw0KGgo=", "base64"), headers: { "content-type": "image/png" } })).json();
    const imgNode = await createNode(request, board.id, { type: "image", title: "p", data: { url: img.url } as any });
    // an agent's write seals the person's version, so a payload copy exists under versions/
    const mcp = await connectMcp(request);
    expect((await mcp.call("update_artefact", { id: sheet.id, sheets: [{ name: "Q3", rows: [["ERASE-PAYLOAD-9902"]] }] })).isError).toBe(false);
    const versionsBefore = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM versions WHERE node_id IN (?,?)`, [card.id, sheet.id]);
    expect(versionsBefore[0]!.n).toBeGreaterThan(0);

    await deleteWithEmail(request, account);

    const ids = [board.id, card.id, sheet.id, fileNode.id, imgNode.id];
    expect((await query(`SELECT 1 FROM boards WHERE id = ?`, [board.id])).length).toBe(0);
    for (const n of ids.slice(1)) expect((await query(`SELECT 1 FROM nodes WHERE id = ?`, [n])).length, n).toBe(0);
    expect((await query(`SELECT 1 FROM boards WHERE user_id = ?`, [id])).length).toBe(0);
    expect((await query(`SELECT 1 FROM workspaces WHERE owner_id = ?`, [id])).length).toBe(0);
    expect((await query(`SELECT 1 FROM trash WHERE user_id = ?`, [id])).length).toBe(0);

    // R2: filed for the cron's reaper, and due at once, not after the 7-day undo window
    const queued = await query<{ bucket: string; key: string; node_id: string; deleted_at: number }>(
      `SELECT bucket, key, node_id, deleted_at FROM r2_trash WHERE node_id IN (${ids.map(() => "?").join(",")})`, ids,
    );
    const keys = queued.map((q) => `${q.bucket}:${q.key}`);
    expect(keys).toEqual(expect.arrayContaining([`ARTEFACTS:artefacts/${sheet.id}`, `ARTEFACTS:${fileKey}`]));
    expect(queued.some((q) => q.bucket === "IMAGES" && q.key === new URL(img.url).pathname.split("/").pop())).toBe(true);
    for (const q of queued) expect(q.deleted_at, q.key).toBeLessThan(Date.now() - 7 * 86_400_000);

    // history: rows stay (nothing is ever deleted there), content does not
    const v = await query<Record<string, any>>(`SELECT * FROM versions WHERE node_id IN (?,?)`, [card.id, sheet.id]);
    expect(v.length).toBe(versionsBefore[0]!.n);
    for (const row of v) {
      expect(row.status).toBe("redacted");
      for (const col of ["title", "body", "doc", "data_json", "payload_key"]) expect(row[col], col).toBeNull();
    }
    expect(JSON.stringify(v)).not.toContain("ERASE-");
    const sealedKeys = queued.filter((q) => q.key.startsWith("versions/"));
    expect(sealedKeys.length).toBeGreaterThan(0);
  });

  test("their recall history and trash are cleared, and what the trash held is due for the reaper", async ({ account, request }) => {
    const id = await meId(request);
    const board = await createBoard(request, "Trash me");
    const sheet = await createArtefact(request, board.id, "sheet", { title: "In trash", sheets: SHEET } as any);
    await request.get("/api/recall?q=anything-at-all");
    expect((await request.delete(`/api/boards/${board.id}`)).ok()).toBe(true);
    expect((await query(`SELECT 1 FROM trash WHERE user_id = ?`, [id])).length).toBe(1);
    const fresh = await query<{ deleted_at: number }>(`SELECT deleted_at FROM r2_trash WHERE node_id = ?`, [sheet.id]);
    expect(fresh[0]!.deleted_at).toBeGreaterThan(Date.now() - 7 * 86_400_000);

    await deleteWithEmail(request, account);

    expect((await query(`SELECT 1 FROM trash WHERE user_id = ?`, [id])).length).toBe(0);
    expect((await query(`SELECT 1 FROM recall_queries WHERE user_id = ?`, [id])).length).toBe(0);
    const due = await query<{ deleted_at: number }>(`SELECT deleted_at FROM r2_trash WHERE node_id = ?`, [sheet.id]);
    expect(due[0]!.deleted_at).toBeLessThan(Date.now() - 7 * 86_400_000);
  });
});

test.describe("workspaces with other people in them", () => {
  test("deletion is refused, with a message that says what to do, and nothing changes", async ({ account, request, makePerson }) => {
    const member = await makePerson("member");
    const ws = await createWorkspace(request, "Shared space");
    await addMember(request, "workspaces", ws.id, member.user.email, "editor");
    const board = await createBoard(request, "In shared space", { workspace_id: ws.id });

    const res = await deleteAccount(request, { email: account.email });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/transfer|remove/i);
    expect(body.error).toContain("Shared space");
    expect(body.workspaces).toEqual([{ id: ws.id, name: "Shared space" }]);

    expect((await request.get("/api/auth/me").then((r) => r.json())).user.email).toBe(account.email);
    expect((await listBoards(request)).some((b) => b.id === board.id)).toBe(true);
    expect((await member.request.get(`/api/boards/${board.id}/contents`)).status()).toBe(200);
    const [row] = await query<any>(`SELECT status FROM users WHERE id = ?`, [await meId(request)]);
    expect(row.status).toBe("active");
  });

  test("once the members are removed, deletion goes through and takes the workspace with it", async ({ account, request, makePerson }) => {
    const member = await makePerson("member");
    const ws = await createWorkspace(request, "Soon gone");
    await addMember(request, "workspaces", ws.id, member.user.email, "editor");
    const board = await createBoard(request, "Soon gone board", { workspace_id: ws.id });
    expect((await deleteAccount(request, { email: account.email })).status()).toBe(409);

    const memberId = await meId(member.request);
    expect((await request.delete(`/api/workspaces/${ws.id}/members/${memberId}`)).status()).toBe(200);
    await deleteWithEmail(request, account);

    expect((await query(`SELECT 1 FROM workspaces WHERE id = ?`, [ws.id])).length).toBe(0);
    expect((await query(`SELECT 1 FROM boards WHERE id = ?`, [board.id])).length).toBe(0);
  });

  test("a member of someone else's workspace can delete their account: it is not theirs to block", async ({ account, request, makePerson }) => {
    const owner = await makePerson("owner");
    const ws = await createWorkspace(owner.request, "Theirs");
    await addMember(owner.request, "workspaces", ws.id, account.email, "viewer");
    await deleteWithEmail(request, account);
    expect((await listWorkspaces(owner.request)).some((w) => w.id === ws.id)).toBe(true);
  });
});
