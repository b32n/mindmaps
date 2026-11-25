import { expect, test } from "@playwright/test";
import { legalHostedWorker, legalOrgWorker, modeWorkers } from "../support/hosts";

// /privacy, /terms and security.txt in each mode, and with the operator's own
// settings. The hosted wording is covered in e2e/tests/legal/pages.spec.ts.

const PLACEHOLDER = ".legal-placeholder";

for (const mode of ["personal", "org"] as const) {
  test.describe(`${mode} mode, no operator details`, () => {
    test.use({ baseURL: modeWorkers[mode].baseURL });

    test("/api/legal says so", async ({ request }) => {
      expect(await (await request.get("/api/legal")).json()).toEqual({ mode, operator: { name: null, contact: null } });
    });

    for (const [path, title, what] of [
      ["/privacy", "Privacy policy", "privacy policy"],
      ["/terms", "Terms of service", "terms"],
    ] as const) {
      test(`${path} says the instance operator controls the data, in neutral words`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
        const note = page.getByTestId("operator-note");
        await expect(note).toContainText("run by whoever set it up, not by the Mindmaps project");
        await expect(note).toContainText("The operator controls the data stored here");
        await expect(note).toContainText(`the ${what} that applies to you is theirs`);
        await expect(note).toContainText("template");
        await expect(note).toContainText("review and replace");
        await expect(note).toContainText("The operator has not named themselves here");
        await expect(note).toContainText("ask whoever gave you access");
        // Never speaks for the hosted service.
        await expect(page.locator(".legal-body")).not.toContainText("mindmaps.b32n.io");
        await expect(page.locator(".legal-body")).not.toContainText("run by the Mindmaps project");
      });

      test(`${path} decides nothing for the operator: no hosted placeholders`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
        await expect(page.getByTestId("effective")).toContainText("Template text");
      });
    }

    test("the terms leave law and liability to the operator", async ({ page }) => {
      await page.goto("/terms");
      await expect(page.locator("#law")).toContainText("is for the operator of this instance to state");
      await expect(page.locator("#liability")).toContainText("operator of this instance sets their own limits");
      await expect(page.locator("#account")).toContainText("operator decides who may use this instance");
    });

    test("the privacy policy leaves backups and age to the operator", async ({ page }) => {
      await page.goto("/privacy");
      await expect(page.locator("#how-long")).toContainText("depends on the operator's Cloudflare plan");
      await expect(page.locator("#children")).toContainText("The operator decides who may use this instance");
    });

    test("it is still linked from sign-in and sign-up", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByRole("navigation", { name: "Legal" }).getByRole("link", { name: "Privacy" })).toBeVisible();
      await page.goto("/register");
      await expect(page.locator(".legal-agree").getByRole("link", { name: "Terms" })).toBeVisible();
    });
  });
}

test.describe("org mode with the operator's details set", () => {
  test.use({ baseURL: legalOrgWorker.baseURL });

  test("/api/legal carries them", async ({ request }) => {
    expect(await (await request.get("/api/legal")).json()).toEqual({
      mode: "org",
      operator: { name: "Example Org Ltd", contact: "privacy@example.test" },
    });
  });

  for (const path of ["/privacy", "/terms"]) {
    test(`${path} names the operator and links their contact`, async ({ page }) => {
      await page.goto(path);
      const note = page.getByTestId("operator-note");
      await expect(note).toContainText("run by Example Org Ltd, not by the Mindmaps project");
      await expect(note).toContainText("Operator: Example Org Ltd.");
      await expect(note).not.toContainText("has not named themselves");
      await expect(page.locator('.legal-body a[href="mailto:privacy@example.test"]').first()).toBeVisible();
      await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
    });
  }

  test("the terms speak of the operator by name", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.locator(".legal-body")).toContainText("between you and Example Org Ltd");
  });

  test("security.txt: SECURITY_CONTACT overrides Contact, everything else is unchanged", async ({ request, baseURL }) => {
    const body = await (await request.get("/.well-known/security.txt")).text();
    expect(body).toContain("Contact: mailto:security@example.test\n");
    expect(body).not.toContain("github.com/b32n/mindmaps/security/advisories");
    expect(body.match(/^Contact:/gm)).toHaveLength(1);
    expect(body).toContain("Preferred-Languages: en\n");
    expect(body).toContain("Policy: https://github.com/b32n/mindmaps/blob/main/SECURITY.md\n");
    expect(body).toContain(`Canonical: ${baseURL}/.well-known/security.txt\n`);
    const expires = Date.parse(/^Expires: (.+)$/m.exec(body)![1]);
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires - Date.now()).toBeLessThan(365 * 86_400_000);
  });
});

test.describe("hosted mode with an operator contact set", () => {
  test.use({ baseURL: legalHostedWorker.baseURL });

  test("the contact replaces the privacy-contact placeholder; the others stay", async ({ page, request }) => {
    expect((await (await request.get("/api/legal")).json()).operator).toEqual({
      name: null,
      contact: "https://privacy.example.test/contact",
    });
    await page.goto("/privacy");
    await expect(page.getByTestId("operator-note")).toContainText("run by the Mindmaps project");
    await expect(page.locator('#contact a[href="https://privacy.example.test/contact"]')).toBeVisible();
    await expect(page.locator('[data-placeholder="privacy-contact"]')).toHaveCount(0);
    await expect(page.locator('[data-placeholder="effective-date"]').first()).toBeVisible();
  });

  test("security.txt keeps the project's advisory contact when no override is set", async ({ request }) => {
    const body = await (await request.get("/.well-known/security.txt")).text();
    expect(body).toContain("Contact: https://github.com/b32n/mindmaps/security/advisories/new\n");
  });
});

test.describe("an unreadable mode", () => {
  test("an invalid MINDMAPS_MODE answers 500 and never serves a policy", async ({ request }) => {
    const res = await request.get(`${modeWorkers.invalid.baseURL}/api/legal`);
    expect(res.status()).toBe(500);
    expect((await request.get(`${modeWorkers.invalid.baseURL}/.well-known/security.txt`)).status()).toBe(500);
  });
});
