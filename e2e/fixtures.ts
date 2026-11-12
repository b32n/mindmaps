import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test";
import { newUser, type TestUser } from "./support/users";

/** Register through the real API. The session cookie lands on `request`'s jar. */
export async function register(request: APIRequestContext, user: TestUser) {
  const res = await request.post("/api/auth/register", {
    data: { email: user.email, password: user.password, name: user.name },
  });
  expect(res.status(), `register ${user.email}: ${await res.text()}`).toBe(200);
}

/** A user that exists on the server, plus an API client signed in as them. */
export interface Person {
  user: TestUser;
  request: APIRequestContext;
}

interface Fixtures {
  /**
   * A freshly registered user, already signed in on this test's browser
   * context (`page` and `request` both carry the session). Unique per test.
   */
  account: TestUser;
  /**
   * A registered user whose session is NOT on the test's browser context: the
   * page stays signed out, so sign-in can be exercised through the UI. The
   * returned `request` is signed in as them, for arranging data.
   */
  existing: Person;
  /**
   * Builds more people on demand (a collaborator, a second owner...), each with
   * their own cookie jar. Disposed with the test.
   */
  makePerson: (label?: string) => Promise<Person>;
  /**
   * A page signed in as `person`, in its own browser context (its own cookie
   * jar), so two people can use the app side by side in one test. The context
   * is closed with the test.
   */
  openAs: (person: Person) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  // The default `request` has its own cookie jar. Share the browser context's
  // instead, so API calls in a test are made as whoever the page is signed in as
  // (nobody, until `account` runs) and reads/writes line up with what the UI sees.
  request: async ({ context }, use) => {
    await use(context.request);
  },

  account: async ({ context }, use) => {
    const user = newUser();
    // `context.request` shares its cookie jar with every page in the context.
    await register(context.request, user);
    await use(user);
  },

  makePerson: async ({ playwright, baseURL }, use) => {
    const made: APIRequestContext[] = [];
    await use(async (label = "person") => {
      const request = await playwright.request.newContext({ baseURL });
      made.push(request);
      const user = newUser(label);
      await register(request, user);
      return { user, request };
    });
    await Promise.all(made.map((r) => r.dispose()));
  },

  openAs: async ({ browser }, use) => {
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    await use(async (person) => {
      const context = await browser.newContext({ storageState: await person.request.storageState() });
      contexts.push(context);
      return context.newPage();
    });
    await Promise.all(contexts.map((c) => c.close()));
  },

  existing: async ({ makePerson }, use) => {
    await use(await makePerson("existing"));
  },
});

export { expect };
