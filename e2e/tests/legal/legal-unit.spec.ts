import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  DEFAULT_SECURITY_CONTACT,
  SECURITY_POLICY_URL,
  SECURITY_TXT_VALID_DAYS,
  operatorOf,
  securityContactOf,
  securityContactUri,
  securityTxt,
} from "../../../worker/src/legal";
import { PLACEHOLDERS, RETENTION, SECURITY_URL, placeholderId, undecided } from "../../../web/src/legal/config";

// The helpers behind security.txt and the operator details, and the numbers the
// legal pages quote, without a Worker.

const DAY = 86_400_000;
const src = (file: string) => readFileSync(resolve(process.cwd(), "worker/src", file), "utf8");

test.describe("securityContactUri", () => {
  test("accepts https, mailto, tel and a bare email", () => {
    expect(securityContactUri("https://example.test/report")).toBe("https://example.test/report");
    expect(securityContactUri("mailto:sec@example.test")).toBe("mailto:sec@example.test");
    expect(securityContactUri("sec@example.test")).toBe("mailto:sec@example.test");
    expect(securityContactUri("  sec@example.test \n")).toBe("mailto:sec@example.test");
    expect(securityContactUri("tel:+1-555-0100")).toBe("tel:+1-555-0100");
  });

  test("refuses anything that is not a usable contact", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "security",
      "http://example.test",
      "javascript:alert(1)",
      "mailto:not-an-email",
      "two words@example.test",
      "https://",
      "x".repeat(300),
    ])
      expect(securityContactUri(bad), String(bad)).toBeNull();
  });

  test("a value cannot smuggle in extra fields", () => {
    expect(securityContactUri("https://example.test/a\nExpires: 2099-01-01T00:00:00Z")).toBeNull();
    const txt = securityTxt("https://x.test", { SECURITY_CONTACT: "a@example.test\nContact: https://evil.test" });
    expect(txt.match(/^Contact:/gm)).toHaveLength(1);
    expect(txt).toContain(`Contact: ${DEFAULT_SECURITY_CONTACT}`);
  });

  test("falls back to the project's advisory form", () => {
    expect(securityContactOf({})).toBe("https://github.com/b32n/mindmaps/security/advisories/new");
    expect(securityContactOf({ SECURITY_CONTACT: "nope" })).toBe(DEFAULT_SECURITY_CONTACT);
    expect(securityContactOf({ SECURITY_CONTACT: "sec@example.test" })).toBe("mailto:sec@example.test");
  });
});

test.describe("securityTxt", () => {
  const at = new Date("2026-11-25T10:00:00.000Z");

  test("has exactly the fields RFC 9116 needs, in a stable order, ending in a newline", () => {
    const txt = securityTxt("https://notes.example.test", {}, at);
    expect(txt.split("\n")).toEqual([
      `Contact: ${DEFAULT_SECURITY_CONTACT}`,
      `Expires: ${new Date(at.getTime() + SECURITY_TXT_VALID_DAYS * DAY).toISOString()}`,
      "Preferred-Languages: en",
      `Policy: ${SECURITY_POLICY_URL}`,
      "Canonical: https://notes.example.test/.well-known/security.txt",
      "",
    ]);
  });

  test("Expires is in the future and under a year, whatever the clock says", () => {
    expect(SECURITY_TXT_VALID_DAYS).toBeGreaterThan(300);
    expect(SECURITY_TXT_VALID_DAYS).toBeLessThan(365);
    for (const when of ["2026-01-01T00:00:00Z", "2028-02-29T23:59:59Z", "2031-12-31T00:00:00Z"]) {
      const now = new Date(when);
      const expires = new Date(/^Expires: (.+)$/m.exec(securityTxt("https://x.test", {}, now))![1]);
      expect(expires.getTime()).toBeGreaterThan(now.getTime());
      expect(expires.getTime() - now.getTime()).toBeLessThan(365 * DAY);
    }
  });

  test("never contains an invented email address", () => {
    expect(securityTxt("https://x.test", {}, at)).not.toMatch(/@|mailto:/);
  });

  test("the policy link points at the SECURITY.md the legal pages link to", () => {
    expect(SECURITY_POLICY_URL).toBe(SECURITY_URL);
  });
});

test.describe("operatorOf", () => {
  test("unset is null, never invented", () => {
    expect(operatorOf({})).toEqual({ name: null, contact: null });
    expect(operatorOf({ OPERATOR_NAME: "  ", OPERATOR_CONTACT: "" })).toEqual({ name: null, contact: null });
  });

  test("keeps a name and an email or https contact as written", () => {
    expect(operatorOf({ OPERATOR_NAME: " Acme \n Ltd ", OPERATOR_CONTACT: "privacy@acme.test" })).toEqual({
      name: "Acme Ltd",
      contact: "privacy@acme.test",
    });
    expect(operatorOf({ OPERATOR_CONTACT: "https://acme.test/contact" }).contact).toBe("https://acme.test/contact");
  });

  test("drops a contact that is neither an email nor an https URL", () => {
    for (const bad of ["javascript:alert(1)", "http://acme.test", "call me", "x".repeat(300)])
      expect(operatorOf({ OPERATOR_CONTACT: bad }).contact, bad).toBeNull();
  });
});

test.describe("what the legal pages quote matches the Worker", () => {
  test("trash retention", () => {
    const days = Number(/RETENTION_MS = (\d+) \* 24 \* 60 \* 60 \* 1000/.exec(src("r2trash.ts"))![1]);
    expect(RETENTION.trashDays).toBe(days);
  });

  test("session, access token and refresh token lifetimes", () => {
    expect(RETENTION.sessionDays).toBe(Number(/SESSION_DAYS = (\d+)/.exec(src("auth.ts"))![1]));
    const oauth = src("oauth.ts");
    expect(RETENTION.accessTokenDays).toBe(Number(/TOKEN_TTL_MS = (\d+) \* 86_400_000/.exec(oauth)![1]));
    expect(RETENTION.refreshTokenDays).toBe(Number(/REFRESH_TTL_MS = (\d+) \* 86_400_000/.exec(oauth)![1]));
  });

  test("the session cookie the page names is the one the Worker sets", () => {
    expect(src("auth.ts")).toContain('SESSION_COOKIE = "wb_session"');
  });
});

test.describe("placeholders", () => {
  test("every decision that needs a person is listed, and none is decided for them", () => {
    expect(Object.keys(PLACEHOLDERS).sort()).toEqual(
      [
        "backupWindow",
        "effectiveDate",
        "governingLaw",
        "jurisdiction",
        "legalEntity",
        "liabilityCap",
        "minimumAge",
        "privacyContact",
      ].sort(),
    );
    expect(undecided().sort()).toEqual(Object.keys(PLACEHOLDERS).sort());
  });

  test("ids are kebab-case", () => {
    expect(placeholderId("governingLaw")).toBe("governing-law");
    expect(placeholderId("effectiveDate")).toBe("effective-date");
    expect(placeholderId("minimumAge")).toBe("minimum-age");
  });
});
