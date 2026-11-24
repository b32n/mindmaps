import { test, expect } from "@playwright/test";
import { PrivateWorker } from "../../support/private-worker";
import { MembersPanel } from "../../support/members";
import { signUpViaForm } from "../../support/auth";
import { addMember, createWorkspace, inviteRaw } from "../../support/api";
import { createOrganisation, signUp } from "../../support/organisation";
import { newUser } from "../../support/users";

// First run, as a person sees it. Each test has a Worker of its own (an empty
// database is what makes the first account special).

test.describe("org mode, first run", () => {
  let w: PrivateWorker;
  test.beforeEach(async () => {
    w = await new PrivateWorker({ mode: "org", signup: "closed" }).start();
  });
  test.afterEach(async () => w.dispose());

  test("the first account sets up the organisation, invites people, and lands in it", async ({ browser }) => {
    const page = await (await w.context(browser)).newPage();
    const owner = newUser("owner");
    await signUpViaForm(page, owner);

    await expect(page.getByRole("heading", { name: "Set up your organisation" })).toBeVisible();
    // no way round it yet: there is no app behind this page
    await expect(page.locator(".rail")).toHaveCount(0);
    await page.getByLabel("Organisation name").fill("Acme Ltd");
    await page.getByRole("button", { name: "Create organisation" }).click();

    await expect(page.getByRole("heading", { name: "Invite your team" })).toBeVisible();
    const panel = new MembersPanel(page.locator(".org-onboarding"));
    const teammate = newUser("mate");
    const sent = await panel.invite(teammate.email);
    expect(sent.status).toBe(201);
    await expect(panel.row(teammate.email)).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.locator(".ws-trigger")).toContainText("Acme Ltd");

    // and there is no way to make a second one
    await page.locator(".ws-trigger").click();
    await expect(page.getByRole("menuitem", { name: /Acme Ltd/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New workspace" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Create organisation" })).toHaveCount(0);

    // a reload does not ask again
    await page.reload();
    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Set up your organisation" })).toHaveCount(0);
  });

  test("a blank name is not accepted", async ({ browser }) => {
    const page = await (await w.context(browser)).newPage();
    await signUpViaForm(page, newUser("owner"));
    await expect(page.getByRole("button", { name: "Create organisation" })).toBeDisabled();
    await page.getByLabel("Organisation name").fill("   ");
    await expect(page.getByRole("button", { name: "Create organisation" })).toBeDisabled();
  });

  test("an invited person signs up, is told to accept, and is in once they do", async ({ browser }) => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();
    const mate = newUser("mate");
    await inviteRaw(owner, "workspaces", org.id, mate.email, "editor");

    const page = await (await w.context(browser)).newPage();
    await signUpViaForm(page, mate);
    await expect(page.getByRole("heading", { name: "Ask your admin for an invite" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "You're invited" })).toBeVisible();
    await expect(page.locator(".org-gate")).toContainText("Acme");
    await expect(page.locator(".rail")).toHaveCount(0);
    await page.getByRole("button", { name: "Accept" }).click();

    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.locator(".ws-trigger")).toContainText("Acme");
  });
});

test.describe("org mode, sign-up open", () => {
  let w: PrivateWorker;
  test.beforeEach(async () => {
    w = await new PrivateWorker({ mode: "org", signup: "open" }).start();
  });
  test.afterEach(async () => w.dispose());

  test("before setup, a second account is told the organisation is not ready", async ({ browser }) => {
    await signUp(await w.client(), "owner");
    const page = await (await w.context(browser)).newPage();
    await signUpViaForm(page, newUser("second"));
    await expect(page.getByRole("heading", { name: "The organisation isn't set up yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Create organisation/ })).toHaveCount(0);
    await expect(page.locator(".rail")).toHaveCount(0);
  });

  test("after setup, an uninvited sign-up is told to ask for an invite, safely", async ({ browser }) => {
    const owner = await w.client();
    await signUp(owner, "owner");
    await createOrganisation(owner, { name: "Acme" });

    const page = await (await w.context(browser)).newPage();
    await signUpViaForm(page, newUser("walkin"));
    await expect(page.getByRole("heading", { name: "Ask your admin for an invite" })).toBeVisible();
    await expect(page.locator(".org-gate")).toContainText("Acme");
    await expect(page.locator(".rail")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Create organisation|New workspace/ })).toHaveCount(0);
    // the board routes are no way in either
    await page.goto("/artefacts");
    await expect(page.getByRole("heading", { name: "Ask your admin for an invite" })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/(login)?$/);
  });

  test("an invitation that arrives while they wait shows up when they reload", async ({ browser }) => {
    const owner = await w.client();
    await signUp(owner, "owner");
    const org = await (await createOrganisation(owner, { name: "Acme" })).json();
    const mate = newUser("mate");
    const page = await (await w.context(browser)).newPage();
    await signUpViaForm(page, mate);
    await expect(page.getByRole("heading", { name: "Ask your admin for an invite" })).toBeVisible();

    await inviteRaw(owner, "workspaces", org.id, mate.email, "viewer");
    await page.reload();
    await expect(page.getByRole("heading", { name: "You're invited" })).toBeVisible();
    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page.locator(".ws-trigger")).toContainText("Acme");
  });
});

test.describe("org mode on an install that already has workspaces", () => {
  test("the first account is offered what it owns, and keeps everything", async ({ browser }) => {
    const w = await new PrivateWorker({ signup: "open" }).start();
    try {
      const a = await w.client();
      await signUp(a, "a");
      const team = await createWorkspace(a, "Team");
      await createWorkspace(a, "Labs");
      const b = await w.client();
      const ub = await signUp(b, "b");
      await addMember(a, "workspaces", team.id, ub.email, "editor");
      await w.restart("org");

      const page = await (await w.context(browser, a)).newPage();
      await page.goto("/app");
      await expect(page.getByRole("heading", { name: "Set up your organisation" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Use Team as the organisation" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Use Labs as the organisation" })).toBeVisible();
      await page.getByRole("button", { name: "Use Team as the organisation" }).click();
      await expect(page.getByRole("heading", { name: "Invite your team" })).toBeVisible();
      await page.getByRole("button", { name: "Done" }).click();
      await expect(page.locator(".ws-trigger")).toContainText("Team");
      // Labs is still there
      await page.locator(".ws-trigger").click();
      await expect(page.getByRole("menuitem", { name: /Labs/ })).toBeVisible();

      // the member of Team is in, and was not asked anything
      const mate = await (await w.context(browser, b)).newPage();
      await mate.goto("/app");
      await expect(mate.locator(".rail")).toBeVisible();
      await expect(mate.getByRole("heading", { name: /Set up|Ask your admin/ })).toHaveCount(0);
    } finally {
      await w.dispose();
    }
  });
});
