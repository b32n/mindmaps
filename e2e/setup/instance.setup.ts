import { expect, test as setup } from "@playwright/test";
import { register } from "../fixtures";
import { OWNER_STATE } from "../support/state";
import { newUser } from "../support/users";

/**
 * Runs once before the browser projects. Waits for the Worker, then registers
 * the instance owner (the first account on an empty database) and stores its
 * session so specs that need an admin can opt in with
 *   test.use({ storageState: OWNER_STATE })
 * Everything else registers its own user (see ../fixtures.ts).
 */
setup("register the instance owner", async ({ request }) => {
  const me = await request.get("/api/auth/me");
  expect(me.ok()).toBe(true);
  await register(request, newUser("owner"));
  await request.storageState({ path: OWNER_STATE });
});
