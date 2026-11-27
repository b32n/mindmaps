import { expect, test } from "../../fixtures";
import { Rail } from "../../support/rail";

// /privacy and /terms on the main Worker, which leaves MINDMAPS_MODE unset: the
// hosted service (multitenant). Other modes: e2e/modes/legal-modes.spec.ts.

const PLACEHOLDER = ".legal-placeholder";

/** Every decision that needs a person, by the id on its marker. */
const PRIVACY_PLACEHOLDERS = [
  "effective-date",
  "legal-entity",
  "privacy-contact",
  "backup-window",
  "minimum-age",
];
const TERMS_PLACEHOLDERS = [
  "effective-date",
  "legal-entity",
  "minimum-age",
  "liability-cap",
  "governing-law",
  "jurisdiction",
  "privacy-contact",
];

const ids = (page: import("@playwright/test").Page) =>
  page.locator(`${PLACEHOLDER}[data-placeholder]`).evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-placeholder")))].sort());

test.describe("privacy policy", () => {
  test("is reachable signed out", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
    await expect(page.getByTestId("legal-loading")).toHaveCount(0);
  });

  test("lists what is stored, who else handles it, cookies and retention", async ({ page }) => {
    await page.goto("/privacy");
    for (const h of ["What is stored", "What it is used for", "Who else handles it", "Cookies and local storage", "How long it is kept", "Your controls", "Contact"])
      await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
    const body = page.locator(".legal-body");
    await expect(body).toContainText("Cloudflare");
    await expect(body).toContainText("Google");
    await expect(body).toContainText("not sold");
    await expect(body).toContainText("no tracking");
    await expect(body).toContainText("wb_session");
    await expect(body).toContainText("7 days");
    await expect(body).toContainText("Download my data");
    await expect(body).toContainText("Delete account");
  });

  test("names the sign-up check, single sign-on and the sign-up-attempt email, each only where turned on", async ({ page }) => {
    await page.goto("/privacy");
    const who = page.locator("#who-else");
    const item = (name: string) => who.locator("li", { hasText: name });
    await expect(item("Cloudflare Turnstile")).toContainText("only where the operator has turned on the sign-up check");
    await expect(item("Cloudflare Turnstile")).toContainText("Where it is off, nothing is loaded");
    await expect(item("identity provider")).toContainText("only where the operator has set up single sign-on");
    await expect(item("Email.")).toContainText("someone tried to sign up with it");
    await expect(item("Email.")).toContainText("an instance without email turned on sends none");
    // The claim about scripts has to stay true when the check is on.
    await expect(page.locator("#what-we-do")).toContainText("The one third-party script is Cloudflare's sign-up check");
  });

  test("on the hosted service the operator is the Mindmaps project", async ({ page }) => {
    await page.goto("/privacy");
    const note = page.getByTestId("operator-note");
    await expect(note).toContainText("hosted service at https://mindmaps.b32n.io");
    await expect(note).toContainText("run by the Mindmaps project");
    await expect(note).not.toContainText("template");
  });

  test("shows every undecided legal choice as a visible placeholder", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByTestId("operator-note")).toBeVisible();
    expect(await ids(page)).toEqual([...PRIVACY_PLACEHOLDERS].sort());
    for (const el of await page.locator(PLACEHOLDER).all()) {
      await expect(el).toBeVisible();
      await expect(el).toContainText("to be decided");
    }
    await expect(page.getByTestId("effective")).toContainText("Effective date: to be decided");
  });

  test("the retention figures and cookie lifetime are the Worker's", async ({ page }) => {
    await page.goto("/privacy");
    const body = page.locator(".legal-body");
    await expect(body).toContainText("lasts 30 days");
    await expect(body).toContainText("access tokens last 30 days");
    await expect(body).toContainText("refresh token that lasts 180 days");
  });

  test("links to the security policy", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.locator('.legal-body a[href$="/blob/main/SECURITY.md"]').first()).toBeVisible();
  });
});

test.describe("terms of service", () => {
  test("is reachable signed out", async ({ page }) => {
    await page.goto("/terms");
    await expect(page).toHaveURL(/\/terms$/);
    await expect(page.getByRole("heading", { level: 1, name: "Terms of service" })).toBeVisible();
  });

  test("covers the account, content, acceptable use, agents and liability", async ({ page }) => {
    await page.goto("/terms");
    for (const h of ["The service", "Your account", "Your content", "Using it properly", "AI tools you connect", "No guarantees", "Liability", "Governing law and disputes"])
      await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
    await expect(page.locator(".legal-body")).toContainText("MIT licence");
  });

  test("on the hosted service the operator is the Mindmaps project", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByTestId("operator-note")).toContainText("run by the Mindmaps project");
    await expect(page.locator(".legal-body")).toContainText("between you and the Mindmaps project");
  });

  test("shows every undecided legal choice as a visible placeholder", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByTestId("operator-note")).toBeVisible();
    expect(await ids(page)).toEqual([...TERMS_PLACEHOLDERS].sort());
    await expect(page.locator('[data-placeholder="governing-law"]').first()).toContainText("Governing law: to be decided");
    await expect(page.locator('[data-placeholder="liability-cap"]').first()).toContainText("Limit of liability: to be decided");
  });

  test("the two pages link to each other and to the privacy policy", async ({ page }) => {
    await page.goto("/terms");
    await page.locator(".legal-head").getByRole("link", { name: "Privacy policy" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await page.locator(".legal-head").getByRole("link", { name: "Terms of service" }).click();
    await expect(page).toHaveURL(/\/terms$/);
  });
});

test.describe("where they are linked from", () => {
  test("the sign-in page", async ({ page }) => {
    await page.goto("/login");
    const nav = page.getByRole("navigation", { name: "Legal" });
    await nav.getByRole("link", { name: "Privacy" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await page.goto("/login");
    await nav.getByRole("link", { name: "Terms" }).click();
    await expect(page).toHaveURL(/\/terms$/);
  });

  test("the sign-up page, as part of the agreement", async ({ page }) => {
    await page.goto("/register");
    const agree = page.locator(".legal-agree");
    await expect(agree).toContainText("By creating an account you agree to");
    await agree.getByRole("link", { name: "Terms" }).click();
    await expect(page).toHaveURL(/\/terms$/);
    await page.goto("/register");
    await page.locator(".legal-agree").getByRole("link", { name: "Privacy policy" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
  });

  test("the landing page footer", async ({ page }) => {
    await page.goto("/");
    const foot = page.locator(".lp-foot");
    await expect(foot.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    await expect(foot.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  });

  test("inside the app, in the rail beside Settings and Sign out", async ({ page, account }) => {
    void account;
    await page.goto("/app");
    const rail = page.locator(".rail-account");
    await expect(rail.getByRole("link", { name: "Privacy" })).toBeVisible();
    await rail.getByRole("link", { name: "Terms" }).click();
    await expect(page).toHaveURL(/\/terms$/);
    // Signed in, the page offers the way back rather than the sign-in link.
    await expect(page.locator(".legal-head").getByRole("link", { name: "Back to your mindmaps" })).toBeVisible();
    await expect(page.locator(".legal-head").getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await page.locator(".legal-head").getByRole("link", { name: "Back to your mindmaps" }).click();
    await expect(page).toHaveURL(/\/app\//);
    await new Rail(page).names().first().waitFor();
  });

  test("a signed-out visitor is offered sign-in from the pages", async ({ page }) => {
    await page.goto("/privacy");
    await page.locator(".legal-head").getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test("neither page needs a session, and neither loads anything from a third party", async ({ page }) => {
  const hosts = new Set<string>();
  page.on("request", (r) => hosts.add(new URL(r.url()).host));
  for (const path of ["/privacy", "/terms"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  expect([...hosts]).toEqual([new URL(page.url()).host]);
});
