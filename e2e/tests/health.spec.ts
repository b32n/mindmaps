import { expect, test } from "@playwright/test";

test.describe("worker is up", () => {
  test("serves the app shell for client-side routes", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });

  test("API is closed to anonymous callers", async ({ request }) => {
    expect((await request.get("/api/boards")).status()).toBe(401);
    const me = await request.get("/api/auth/me");
    expect((await me.json()).user).toBeNull();
  });
});
