import { expect, test } from "../fixtures";
import { newUser } from "../support/users";

test("register, create a mindmap, add a card, and find it after a reload", async ({ page }) => {
  const user = newUser("smoke");
  const mindmap = `Smoke ${user.email.split("@")[0]}`;
  const title = "Quarterly findings";
  const body = "The cache is invalidated twice per write.";

  // Through the real sign-up form, as a new visitor would.
  await page.goto("/register");
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app/);

  // A new mindmap.
  await page.getByRole("button", { name: "New mindmap" }).first().click();
  await page.getByLabel("Name").fill(mindmap);
  await page.getByRole("button", { name: "Create mindmap" }).click();
  await expect(page.getByRole("button", { name: mindmap })).toBeVisible();

  // A card with a title and some body text. Each edit is saved by the app with
  // a PATCH; waiting on those responses (rather than a delay) is what tells us
  // the content has reached the server before we reload.
  const saved = (field: "title" | "body", value: string) =>
    page.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        /\/api\/nodes\//.test(r.url()) &&
        String((r.request().postDataJSON() as Record<string, unknown>)[field] ?? "").trim() === value &&
        r.ok(),
    );

  await page.getByRole("button", { name: "Add card" }).click();
  const titleSaved = saved("title", title);
  await page.getByPlaceholder("Untitled").fill(title);
  await titleSaved;

  await page.getByRole("button", { name: "Open" }).click();
  const editor = page.locator(".card-doc .ProseMirror");
  await editor.click();
  const bodySaved = saved("body", body);
  await page.keyboard.type(body);
  await expect(editor).toContainText(body);
  await bodySaved;

  await page.getByRole("button", { name: "Close" }).click();
  // Wait for the close to settle. The app remembers the open card in the URL
  // and, debounced, in localStorage; a reload before that lands would bring the
  // card back open, which is a different thing from what this test checks.
  await expect(editor).toHaveCount(0);
  await expect(page).not.toHaveURL(/card=/);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values(localStorage).some((v) => /"openCard":"[^"]+"/.test(v)),
      ),
    )
    .toBe(false);
  await expect(page.locator(".card-preview")).toHaveText(body);

  // It survives a reload, with the same content.
  await page.reload();
  await expect(page.getByPlaceholder("Untitled")).toHaveValue(title);
  await expect(page.locator(".card-preview")).toHaveText(body);
});
