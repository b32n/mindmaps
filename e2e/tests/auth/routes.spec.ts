import { test, expect } from "../../fixtures";
import { createBoard } from "../../support/api";

test.describe("protected routes while signed out", () => {
  const protectedPaths = [
    "/app",
    "/app/00000000-0000-0000-0000-000000000000",
    "/artefacts",
    "/sheet/abc",
    "/doc/abc",
    "/page/abc",
    "/deck/abc",
    "/file/abc",
  ];
  for (const path of protectedPaths) {
    test(`${path} redirects to the sign-in form`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    });
  }

  test("the API refuses every board route without a session", async ({ request }) => {
    for (const path of ["/api/boards", "/api/trash", "/api/workspaces", "/api/artefacts", "/api/recall?q=x"]) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
    expect((await request.post("/api/nodes", { data: { board_id: "x" } })).status()).toBe(401);
  });

  test("an unknown route sends you to the landing page", async ({ page }) => {
    await page.goto("/no/such/page");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Memory for your agent.");
  });
});

test.describe("routes while signed in", () => {
  test("/app lands on a concrete mindmap URL", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    await expect(page).toHaveURL(/\/app\/[0-9a-f-]{36}$/);
  });

  test("an id that is not yours falls back to your own first mindmap", async ({ page, account }) => {
    void account;
    await page.goto("/app/00000000-0000-0000-0000-000000000000");
    await expect(page).toHaveURL(/\/app\/(?!0{8})[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: "Start here" })).toBeVisible();
  });

  test("another user's mindmap id does not open", async ({ page, account, existing }) => {
    void account;
    const theirs = await createBoard(existing.request, "Theirs");
    await page.goto(`/app/${theirs.id}`);
    await expect(page).not.toHaveURL(new RegExp(theirs.id));
    await expect(page.getByRole("heading", { level: 1, name: "Theirs" })).toHaveCount(0);
  });
});
