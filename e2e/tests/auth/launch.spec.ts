import { test, expect } from "../../fixtures";
import { modeWorkers } from "../../support/hosts";

const REPO = "https://github.com/b32n/mindmaps";

test.describe("launch metadata", () => {
  test("the landing page has an accurate title, description, Open Graph and Twitter tags", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/^mindmaps: memory for your agent/);
    const meta = (sel: string) => page.locator(`head meta[${sel}]`).first().getAttribute("content");
    expect(await meta('name="description"')).toMatch(/open-source mindmap.*MCP.*Cloudflare/);
    expect(await meta('property="og:type"')).toBe("website");
    expect(await meta('property="og:site_name"')).toBe("mindmaps");
    expect(await meta('property="og:title"')).toMatch(/^mindmaps/);
    expect(await meta('property="og:description"')).toMatch(/MCP/);
    expect(await meta('name="twitter:card"')).toBe("summary");
    expect(await meta('name="twitter:title"')).toMatch(/^mindmaps/);
  });

  test("no image or hosted-address tags are shipped until artwork is approved", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('head meta[property="og:image"], head meta[name="twitter:image"], head meta[property="og:url"]')).toHaveCount(0);
  });

  test("the canonical link is this origin, never the hosted site", async ({ page, baseURL }) => {
    await page.goto("/");
    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    await expect(canonical).toHaveAttribute("href", `${baseURL}/`);
    expect(await page.locator("head").innerHTML()).not.toContain("mindmaps.b32n.io");
  });

  test("the canonical link is dropped when leaving the landing page", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('head link[rel="canonical"]')).toHaveCount(1);
    await page.getByRole("link", { name: "How the brain works", exact: true }).click();
    await expect(page).toHaveURL(/\/brain$/);
    await expect(page.locator('head link[rel="canonical"]')).toHaveCount(0);
  });
});

test.describe("launch links and cost text", () => {
  test("source and self-hosting links are visible signed out and point at the repo", async ({ page }) => {
    await page.goto("/");
    const section = page.locator("#self-host");
    await section.scrollIntoViewIfNeeded();
    const source = section.getByRole("link", { name: "Source on GitHub" });
    const install = section.getByRole("link", { name: "Self-hosting instructions" });
    const deploy = section.getByRole("link", { name: "Deploy to Cloudflare" });
    await expect(source).toBeVisible();
    await expect(install).toBeVisible();
    await expect(deploy).toBeVisible();
    await expect(source).toHaveAttribute("href", REPO);
    await expect(install).toHaveAttribute("href", `${REPO}/blob/main/INSTALL.md`);
    await expect(deploy).toHaveAttribute("href", `https://deploy.workers.cloudflare.com/?url=${REPO}`);
  });

  test("the footer links to the source and the install guide", async ({ page }) => {
    await page.goto("/");
    const foot = page.locator("footer.lp-foot");
    await expect(foot.getByRole("link", { name: "Source" })).toHaveAttribute("href", REPO);
    await expect(foot.getByRole("link", { name: "Self-host" })).toHaveAttribute("href", `${REPO}/blob/main/INSTALL.md`);
  });

  test("the cost text is honest about Cloudflare and links its pricing", async ({ page }) => {
    await page.goto("/");
    const section = page.locator("#self-host");
    await expect(section).toContainText("free to try");
    await expect(section).toContainText("your own Cloudflare account");
    await expect(section).toContainText("Workers Paid plan is recommended");
    await expect(section).toContainText("R2 storage needs a payment method on file");
    await expect(section.getByRole("link", { name: "Cloudflare's pricing" })).toHaveAttribute(
      "href",
      "https://developers.cloudflare.com/workers/platform/pricing/",
    );
  });
});

// "The hosted instance is free to try" describes the hosted service only, so a
// personal or org install must not show that section. Multitenant (and unset,
// which is the same thing) keep it.
for (const mode of ["personal", "org", "multitenant"] as const) {
  test.describe(`hosted-or-self-hosted section, ${mode} mode`, () => {
    test.use({ baseURL: modeWorkers[mode].baseURL });

    test(mode === "multitenant" ? "is shown" : "is not shown", async ({ page }) => {
      await page.goto("/");
      // The mode arrives with /api/auth/me; wait for it so "absent" is not just "not rendered yet".
      await expect(page.locator("html")).toHaveAttribute("data-mindmaps-mode", mode);
      await expect(page.locator("footer.lp-foot")).toBeVisible();
      const section = page.locator("#self-host");
      if (mode === "multitenant") {
        await expect(section).toContainText("The hosted instance is free to try");
      } else {
        await expect(section).toHaveCount(0);
        await expect(page.getByText("The hosted instance is free to try")).toHaveCount(0);
        await expect(page.getByText("Hosted or self-hosted")).toHaveCount(0);
      }
    });
  });
}

test.describe("robots.txt", () => {
  test("allows the public pages and disallows the app, API and per-user paths", async ({ request }) => {
    const res = await request.get("/robots.txt");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Allow: /$");
    for (const p of ["/app", "/api/", "/mcp", "/oauth/", "/s/", "/f/"]) {
      expect(body).toContain(`Disallow: ${p}`);
    }
    expect(body).not.toContain("mindmaps.b32n.io");
  });
});
