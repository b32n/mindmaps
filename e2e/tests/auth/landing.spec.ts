import { test, expect } from "../../fixtures";

test.describe("landing page", () => {
  test("renders for a signed-out visitor with the pitch and a way in", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Memory for your agent.");
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Get started" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Start a mindmap" }).first()).toBeVisible();
  });

  test("“Sign in” goes to the sign-in form", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("“Get started” and “Start a mindmap” go to sign-up", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Get started" }).first().click();
    await expect(page).toHaveURL(/\/register$/);

    await page.goto("/");
    await page.getByRole("link", { name: "Start a mindmap" }).first().click();
    await expect(page).toHaveURL(/\/register$/);
  });

  test("the connect panel shows this server's MCP command and switches tabs", async ({ page, baseURL }) => {
    await page.goto("/");
    const mcp = `${baseURL}/mcp`;
    await expect(page.getByText(`claude mcp add --transport http mindmaps ${mcp}`).first()).toBeVisible();
    await page.getByRole("tab", { name: "Codex" }).first().click();
    await expect(page.getByText(`codex mcp add mindmaps --url ${mcp}`).first()).toBeVisible();
  });

  test("a signed-in visitor is offered the app instead of sign-up", async ({ page, account }) => {
    void account;
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await page.getByRole("link", { name: "Open your boards" }).first().click();
    await expect(page).toHaveURL(/\/app\//);
  });
});

test.describe("the brain page", () => {
  test("is public and explains retrieval", async ({ page }) => {
    await page.goto("/brain");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What is stored" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Retrieval: five signals/ })).toBeVisible();
  });

  test("is reachable from the landing page", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "How the brain works", exact: true }).click();
    await expect(page).toHaveURL(/\/brain$/);
  });
});
