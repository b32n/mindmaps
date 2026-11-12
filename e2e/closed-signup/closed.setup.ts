import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test as setup } from "../fixtures";
import { signUpViaForm } from "../support/auth";
import { CLOSED_OWNER_CREDS, CLOSED_OWNER_STATE } from "../support/state";
import { newUser } from "../support/users";

/**
 * The owner-first rule, on a Worker that runs without ALLOW_SIGNUPS.
 *
 * "The first account on an empty database is the owner" can only be observed
 * once per database, so this runs once per server start: Playwright starts the
 * closed Worker fresh every run (it is never reused), and this is the first
 * thing to touch it. A second pass against the same server (`--repeat-each`, or
 * a retry after this test already created the owner) is skipped, not failed,
 * because the precondition "empty database" no longer holds.
 */
setup("the first account on an empty instance becomes its owner", async ({ page, request }, testInfo) => {
  setup.skip(
    testInfo.repeatEachIndex > 0 || testInfo.retry > 0,
    "needs an empty database; this server already has its owner",
  );

  const owner = newUser("closed-owner");
  await signUpViaForm(page, owner);

  // Sign-up worked although nobody invited this address: the instance was empty.
  await expect(page).toHaveURL(/\/app\//);
  await expect(page.locator(".rail-account .who-name")).toHaveText(owner.name);

  mkdirSync("e2e/.auth", { recursive: true });
  await page.context().storageState({ path: CLOSED_OWNER_STATE });
  writeFileSync(CLOSED_OWNER_CREDS, JSON.stringify(owner));

  // And the door shut behind them.
  const second = await request.post("/api/auth/register", {
    data: { email: newUser("late").email, password: newUser("late").password, name: "late" },
  });
  expect(second.status()).toBe(403);
});
