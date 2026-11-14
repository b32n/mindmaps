import { test, expect } from "../../fixtures";
import { expectSignedInShell, signUpViaForm } from "../../support/auth";
import { newUser, strongPassword } from "../../support/users";

// The live rule list on /register (web/src/pages/Auth.tsx).
const RULES = [
  "12 characters or more",
  "a lowercase letter",
  "an uppercase letter",
  "a number",
  "a symbol",
  "no character 4+ times in a row",
] as const;

test.describe("sign up through the form", () => {
  test("creates the account, signs in and lands on the starter mindmap", async ({ page }) => {
    const user = newUser("signup");
    await signUpViaForm(page, user);

    await expectSignedInShell(page, user.name);
    await expect(page.getByRole("heading", { level: 1, name: "Start here" })).toBeVisible();
    await expect(page.locator(".rail-row .rail-name")).toHaveText(["Start here"]);
    // the avatar is the initial of the name
    await expect(page.locator(".rail-account .avatar")).toHaveText(user.name[0].toUpperCase());
  });

  test("a name is optional: the rail falls back to the email address", async ({ page }) => {
    const user = newUser("noname");
    await page.goto("/register");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expectSignedInShell(page, user.email);
  });

  test("email is case-insensitive and stored lower-cased", async ({ page, makePerson }) => {
    const user = newUser("case");
    await signUpViaForm(page, { ...user, email: user.email.toUpperCase() });
    await expectSignedInShell(page, user.name);

    const me = await (await page.request.get("/api/auth/me")).json();
    expect(me.user.email).toBe(user.email.toLowerCase());

    // and the lower-case spelling is the same account
    const dup = await (await makePerson()).request.post("/api/auth/register", {
      data: { email: user.email.toLowerCase(), password: strongPassword(), name: "dup" },
    });
    expect(dup.status()).toBe(409);
  });

  test("an email that is already registered is refused with a message", async ({ page, existing }) => {
    await signUpViaForm(page, { ...newUser("dup"), email: existing.user.email });

    await expect(page.locator(".auth-error")).toHaveText("An account with that email already exists.");
    await expect(page).toHaveURL(/\/register$/);
    // the form is usable again
    await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  test("a malformed email is stopped by the browser before anything is sent", async ({ page }) => {
    let sent = false;
    page.on("request", (r) => {
      if (r.url().includes("/api/auth/register")) sent = true;
    });
    await page.goto("/register");
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByLabel("Password").fill(strongPassword());
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByLabel("Email")).toHaveJSProperty("validity.typeMismatch", true);
    await expect(page).toHaveURL(/\/register$/);
    expect(sent).toBe(false);
  });

  test("the server rejects an address without a domain dot", async ({ request }) => {
    const res = await request.post("/api/auth/register", {
      data: { email: "someone@localhost", password: strongPassword(), name: "x" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe("That doesn't look like an email address.");
  });
});

test.describe("password policy", () => {
  test("no rules are listed until the password is touched", async ({ page }) => {
    await page.goto("/register");
    await expect(page.locator(".pw-rules")).toHaveCount(0);
    await page.getByLabel("Password").fill("a");
    await expect(page.locator(".pw-rules li")).toHaveText([
      "○ 12 characters or more",
      "✓ a lowercase letter",
      "○ an uppercase letter",
      "○ a number",
      "○ a symbol",
      "✓ no character 4+ times in a row",
    ]);
  });

  test("leaving the password field empty also reveals the rules", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Password").focus();
    await page.getByLabel("Name").focus(); // blur
    await expect(page.locator(".pw-rules li")).toHaveCount(RULES.length);
    await expect(page.locator(".pw-rules li.ok")).toHaveCount(1); // only "no 4 in a row" holds for ""
    await expect(page.getByRole("button", { name: "Create account" })).toBeDisabled();
  });

  // One password per rule, each breaking exactly that rule.
  const cases: Array<[string, (typeof RULES)[number]]> = [
    ["Aa1!bcdefg", "12 characters or more"],
    ["AA1!BCDEFGHIJK", "a lowercase letter"],
    ["aa1!bcdefghijk", "an uppercase letter"],
    ["Aa!bcdefghijkl", "a number"],
    ["Aa1bcdefghijkl", "a symbol"],
    ["Aa1!bcdxxxxefg", "no character 4+ times in a row"],
  ];
  for (const [password, broken] of cases) {
    test(`“${password}” fails only: ${broken}`, async ({ page }) => {
      await page.goto("/register");
      await page.getByLabel("Password").fill(password);

      const failing = page.locator(".pw-rules li.no");
      await expect(failing).toHaveCount(1);
      await expect(failing).toContainText(broken);
      await expect(failing).toContainText("○");
      await expect(page.locator(".pw-rules li.ok").first()).toContainText("✓");
      await expect(page.getByRole("button", { name: "Create account" })).toBeDisabled();
    });
  }

  test("a compliant password ticks every rule and enables the button", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Password").fill(strongPassword());
    await expect(page.locator(".pw-rules li.ok")).toHaveCount(RULES.length);
    await expect(page.locator(".pw-rules li.no")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  test("the rules update live as the password is edited", async ({ page }) => {
    await page.goto("/register");
    const password = page.getByLabel("Password");
    await password.fill("abcdefghijkl");
    await expect(page.locator(".pw-rules li.no")).toHaveCount(3); // upper, number, symbol
    await password.fill("abcdefghijkL");
    await expect(page.locator(".pw-rules li.no")).toHaveCount(2);
    await password.fill("abcdefghijkL1");
    await expect(page.locator(".pw-rules li.no")).toHaveCount(1);
    await password.fill("abcdefghijkL1!");
    await expect(page.locator(".pw-rules li.no")).toHaveCount(0);
  });

  test("the server enforces the same policy and lists every problem", async ({ request }) => {
    const res = await request.post("/api/auth/register", {
      data: { email: newUser("weak").email, password: "short", name: "x" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.problems).toEqual([
      "at least 12 characters",
      "an uppercase letter",
      "a number",
      "a symbol",
    ]);
    expect(body.error).toBe(
      "Your password needs at least 12 characters, an uppercase letter, a number, a symbol.",
    );
  });

  test("a weak password never creates an account", async ({ request, page }) => {
    const user = newUser("weak2");
    const res = await request.post("/api/auth/register", {
      data: { email: user.email, password: "alllowercaseletters", name: "x" },
    });
    expect(res.status()).toBe(400);
    // so signing in with it fails too
    await page.goto("/login");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill("alllowercaseletters");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator(".auth-error")).toHaveText("Email or password is incorrect.");
  });
});
