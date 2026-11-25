import { expect, test } from "@playwright/test";
import { DEFAULT_SECURITY_CONTACT, SECURITY_POLICY_URL } from "../../../worker/src/legal";
import { MAIN_PORT } from "../../support/hosts";

// /.well-known/security.txt on the main Worker (no overrides). The override var
// is exercised in e2e/modes/legal-modes.spec.ts.

const DAY = 86_400_000;

/** Fields as a list, since Contact may repeat. */
const fields = (body: string) =>
  body
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i), l.slice(i + 1).trim()] as const;
    });

test.describe("/.well-known/security.txt", () => {
  test("is plain text, public, with the fields RFC 9116 asks for", async ({ request }) => {
    const res = await request.get("/.well-known/security.txt", { headers: { cookie: "" } });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    const f = fields(await res.text());
    expect(f.map(([k]) => k)).toEqual(["Contact", "Expires", "Preferred-Languages", "Policy", "Canonical"]);
    const get = (k: string) => f.find(([n]) => n === k)![1];
    expect(get("Contact")).toBe("https://github.com/b32n/mindmaps/security/advisories/new");
    expect(get("Contact")).toBe(DEFAULT_SECURITY_CONTACT);
    expect(get("Preferred-Languages")).toBe("en");
    expect(get("Policy")).toBe(SECURITY_POLICY_URL);
    expect(get("Policy")).toBe("https://github.com/b32n/mindmaps/blob/main/SECURITY.md");
  });

  test("Expires is a valid UTC timestamp, in the future and under a year out", async ({ request }) => {
    const before = Date.now();
    const body = await (await request.get("/.well-known/security.txt")).text();
    const raw = /^Expires: (.+)$/m.exec(body)![1];
    expect(raw).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    const at = Date.parse(raw);
    expect(at).toBeGreaterThan(before);
    expect(at - before).toBeLessThan(365 * DAY);
    expect(at - before).toBeGreaterThan(300 * DAY);
  });

  test("Expires moves with the clock instead of being baked in at build time", async ({ request }) => {
    const first = Date.parse(/^Expires: (.+)$/m.exec(await (await request.get("/.well-known/security.txt")).text())![1]);
    await new Promise((r) => setTimeout(r, 25));
    const second = Date.parse(/^Expires: (.+)$/m.exec(await (await request.get("/.well-known/security.txt")).text())![1]);
    expect(second).toBeGreaterThan(first);
  });

  test("Canonical is the origin the request came to", async ({ request, baseURL }) => {
    const body = await (await request.get("/.well-known/security.txt")).text();
    expect(baseURL).toBe(`http://127.0.0.1:${MAIN_PORT}`);
    expect(/^Canonical: (.+)$/m.exec(body)![1]).toBe(`${baseURL}/.well-known/security.txt`);
    // ...and it follows a different host name for the same Worker.
    const other = await request.get(`http://localhost:${MAIN_PORT}/.well-known/security.txt`);
    expect(/^Canonical: (.+)$/m.exec(await other.text())![1]).toBe(`http://localhost:${MAIN_PORT}/.well-known/security.txt`);
  });

  test("names no email address", async ({ request }) => {
    expect(await (await request.get("/.well-known/security.txt")).text()).not.toMatch(/@|mailto:/);
  });

  test("HEAD answers with the headers and no body", async ({ request }) => {
    const res = await request.head("/.well-known/security.txt");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/plain");
    expect(await res.text()).toBe("");
  });

  test("does not disturb the other discovery documents", async ({ request }) => {
    expect((await request.get("/.well-known/oauth-protected-resource")).status()).toBe(200);
    expect((await request.get("/.well-known/oauth-authorization-server")).status()).toBe(200);
  });

  test("/api/legal is public and says what the pages need", async ({ request }) => {
    const res = await request.get("/api/legal", { headers: { cookie: "" } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ mode: "multitenant", operator: { name: null, contact: null } });
  });
});
