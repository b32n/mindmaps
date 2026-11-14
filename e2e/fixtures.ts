import { expect, test as base, type APIRequestContext } from "@playwright/test";
import { newUser, type TestUser } from "./support/users";

/** Register through the real API. The session cookie lands on `request`'s jar. */
export async function register(request: APIRequestContext, user: TestUser) {
  const res = await request.post("/api/auth/register", {
    data: { email: user.email, password: user.password, name: user.name },
  });
  expect(res.status(), `register ${user.email}: ${await res.text()}`).toBe(200);
}

interface Fixtures {
  /**
   * A freshly registered user, already signed in on this test's browser
   * context (`page` and `request` both carry the session). Unique per test.
   */
  account: TestUser;
}

export const test = base.extend<Fixtures>({
  account: async ({ context }, use) => {
    const user = newUser();
    // `context.request` shares its cookie jar with every page in the context.
    await register(context.request, user);
    await use(user);
  },
});

export { expect };
