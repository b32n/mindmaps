import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseMail, mailInToml, parseMailDomain, parseMailFrom,
  // @ts-expect-error plain .mjs without types
} from "../../scripts/lib/mail-config.mjs";
// @ts-expect-error plain .mjs without types
import { setupSendingDomain } from "../../scripts/lib/mail-cloudflare.mjs";
// @ts-expect-error plain .mjs without types
import { HOSTED_HOST, localToml } from "../../scripts/lib/install-config.mjs";

// The installer's email handling (docs/EMAIL.md): flags and defaults through the
// real script's --dry-run, the pure decisions, and the Cloudflare onboarding
// steps against a fake API. No Cloudflare account is needed.

const repo = fileURLToPath(new URL("../..", import.meta.url));

let root: string;
test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mindmaps-install-mail-"));
  mkdirSync(join(root, "scripts"));
  cpSync(join(repo, "scripts/install.mjs"), join(root, "scripts/install.mjs"));
  cpSync(join(repo, "scripts/lib"), join(root, "scripts/lib"), { recursive: true });
  cpSync(join(repo, "wrangler.toml"), join(root, "wrangler.toml"));
});
test.afterEach(() => rmSync(root, { recursive: true, force: true }));

function install(...args: string[]) {
  const r = spawnSync("node", [join(root, "scripts/install.mjs"), "--dry-run", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let plan: any = null;
  try {
    plan = JSON.parse(r.stdout);
  } catch {
    /* a refusal prints no plan */
  }
  return { status: r.status, stderr: r.stderr, plan };
}
const varsOf = (toml: string) => toml.match(/^\[vars\]\n((?:.+\n?)*)/m)?.[1] ?? "";
const count = (toml: string, re: RegExp) => (toml.match(re) ?? []).length;

test.describe("flags and defaults (dry run)", () => {
  test("--yes with a domain defaults the sender to mindmaps@<domain>", () => {
    const r = install("--yes", "--domain", "notes.example.com");
    expect(r.status).toBe(0);
    expect(r.plan.mail).toEqual({ from: "mindmaps@notes.example.com", fromName: "mindmaps", domain: "notes.example.com" });
    expect(r.plan.config).toContain("[[send_email]]\nname = \"EMAIL\"");
    const vars = varsOf(r.plan.config);
    for (const l of ['MAIL_FROM = "mindmaps@notes.example.com"', 'MAIL_FROM_NAME = "mindmaps"', 'MAIL_DOMAIN = "notes.example.com"']) expect(vars).toContain(l);
  });

  test("--mail-domain and --mail-from override, and share the one [vars] table", () => {
    const r = install("--yes", "--domain", "notes.example.com", "--mail-domain", "example.com", "--mail-from", "hello@mail.example.com");
    expect(r.status).toBe(0);
    expect(r.plan.mail.domain).toBe("example.com");
    expect(r.plan.mail.from).toBe("hello@mail.example.com");
    expect(count(r.plan.config, /^\[vars\]/gm)).toBe(1);
    expect(count(r.plan.config, /^\[\[send_email\]\]/gm)).toBe(1);
    expect(varsOf(r.plan.config)).toContain('PUBLIC_ORIGIN = "https://notes.example.com"');
  });

  test("--mail-domain alone derives the address; --mail-from alone derives the domain", () => {
    expect(install("--yes", "--mail-domain", "example.com").plan.mail.from).toBe("mindmaps@example.com");
    expect(install("--yes", "--mail-from", "Hi@Example.com").plan.mail).toMatchObject({ from: "hi@example.com", domain: "example.com" });
  });

  test("--no-email leaves email out entirely", () => {
    const r = install("--yes", "--domain", "notes.example.com", "--no-email");
    expect(r.plan.mail).toBeNull();
    expect(r.plan.config).not.toContain("send_email");
    expect(r.plan.config).not.toContain("MAIL_FROM");
  });

  test("--yes with no domain skips email, and says how to add it", () => {
    const r = install("--yes");
    expect(r.status).toBe(0);
    expect(r.plan.mail).toBeNull();
    expect(r.plan.mailSource).toBe("no-domain");
    expect(r.stderr).toContain("--mail-domain");
    expect(r.plan.config).not.toContain("send_email");
  });

  test("bad values are refused before anything happens", () => {
    for (const args of [
      ["--mail-domain", "not a domain"],
      ["--mail-domain"],
      ["--mail-from", "nope"],
      ["--mail-from", "--yes"],
      ["--mail-domain", "example.com", "--mail-from", "a@other.org"],
      ["--no-email", "--mail-domain", "example.com"],
    ]) {
      const r = install("--yes", ...args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.plan, args.join(" ")).toBeNull();
    }
  });

  test("the committed wrangler.toml has no email binding (the Deploy button install runs without email)", () => {
    const committed = readCommitted();
    expect(committed).not.toContain("send_email");
    expect(committed).not.toContain("MAIL_FROM");
  });
});

function readCommitted() {
  return spawnSync("cat", [join(repo, "wrangler.toml")], { encoding: "utf8" }).stdout;
}

test.describe("re-runs", () => {
  const first = () => install("--yes", "--domain", "notes.example.com", "--mail-from", "hello@notes.example.com").plan.config as string;

  test("a re-run with no email flags keeps the sender the install already has", () => {
    writeFileSync(join(root, "wrangler.local.toml"), first());
    const r = install("--yes", "--domain", "notes.example.com");
    expect(r.plan.mailSource).toBe("existing");
    expect(r.plan.mail.from).toBe("hello@notes.example.com");
    expect(r.plan.config).toBe(first().replace("<database-id>", "<database-id>"));
  });

  test("running it over its own output changes nothing and duplicates nothing", () => {
    writeFileSync(join(root, "wrangler.local.toml"), first());
    const again = install("--yes", "--domain", "notes.example.com").plan.config as string;
    writeFileSync(join(root, "wrangler.local.toml"), again);
    const thrice = install("--yes", "--domain", "notes.example.com").plan.config as string;
    expect(thrice).toBe(again);
    expect(count(thrice, /^\[\[send_email\]\]/gm)).toBe(1);
    expect(count(thrice, /^MAIL_FROM\s*=/gm)).toBe(1);
  });

  test("--no-email on a re-run removes it, and a later run does not bring it back", () => {
    writeFileSync(join(root, "wrangler.local.toml"), first());
    const off = install("--yes", "--domain", "notes.example.com", "--no-email").plan.config as string;
    expect(off).not.toContain("MAIL_FROM");
    writeFileSync(join(root, "wrangler.local.toml"), off);
    const next = install("--yes", "--domain", "notes.example.com");
    // no sender in the file: a --yes run decides again from the domain, as a first install would
    expect(next.plan.mailSource).toBe("default");
  });

  test("flags on a re-run change the sender", () => {
    writeFileSync(join(root, "wrangler.local.toml"), first());
    const r = install("--yes", "--domain", "notes.example.com", "--mail-from", "team@notes.example.com");
    expect(r.plan.mail.from).toBe("team@notes.example.com");
  });
});

test.describe("the hosted site", () => {
  test("is still pinned to multitenant when email is set up for it", () => {
    const r = install("--yes", "--domain", HOSTED_HOST, "--mail-domain", "b32n.io");
    expect(r.status).toBe(0);
    expect(r.plan.mode).toBe("multitenant");
    expect(varsOf(r.plan.config)).toContain('MINDMAPS_MODE = "multitenant"');
    expect(r.plan.mail.domain).toBe("b32n.io");
    expect(count(r.plan.config, /^\[vars\]/gm)).toBe(1);
  });

  test("still refuses another mode, with or without email", () => {
    for (const extra of [[], ["--mail-domain", "b32n.io"]]) {
      const r = install("--yes", "--domain", HOSTED_HOST, "--mode", "personal", ...extra);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("always multitenant");
    }
  });

  test("a re-run of the hosted config keeps its email and its pin", () => {
    writeFileSync(join(root, "wrangler.local.toml"), install("--yes", "--domain", HOSTED_HOST, "--mail-domain", "b32n.io").plan.config);
    const r = install("--yes");
    expect(r.plan.mode).toBe("multitenant");
    expect(r.plan.mail.domain).toBe("b32n.io");
  });
});

test.describe("decisions", () => {
  test("parsing", () => {
    expect(parseMailDomain(" Example.COM ")).toBe("example.com");
    expect(() => parseMailDomain("localhost")).toThrow();
    expect(parseMailFrom("A@b.co")).toEqual({ address: "a@b.co", domain: "b.co" });
    expect(() => parseMailFrom("a@@b.co")).toThrow();
  });

  test("prompting: default domain, then address; 'none' and Enter decline", async () => {
    const asked: string[] = [];
    const answers = ["example.com", "hi@example.com"];
    const ask = async (q: string, d: string) => (asked.push(`${q}|${d}`), answers.shift() ?? d);
    const out = await chooseMail({ appDomain: "notes.example.com", yes: false, existing: null, ask });
    expect(out.mail).toMatchObject({ domain: "example.com", from: "hi@example.com" });
    expect(asked[0].endsWith("|notes.example.com")).toBe(true);
    expect((await chooseMail({ yes: false, existing: null, ask: async () => "none" })).mail).toBeNull();
    expect((await chooseMail({ yes: false, existing: null, ask: async (_q: string, d: string) => d })).source).toBe("declined");
  });

  test("mailInToml reads back what localToml wrote", () => {
    const toml = localToml('compatibility_date = "2026-09-01"\n[vars]\n', { name: "m", dbId: "x", search: true, mail: { from: "a@b.co", fromName: "N", domain: "b.co" } });
    expect(mailInToml(toml)).toEqual({ from: "a@b.co", fromName: "N", domain: "b.co" });
    expect(mailInToml("[vars]\n")).toBeNull();
  });
});

/** A small fake of the parts of the Cloudflare API the onboarding uses. */
function fakeCloudflare(opts: { zones?: Record<string, string>; deny?: boolean; existingSub?: boolean; dnsPresent?: boolean } = {}) {
  const zones = opts.zones ?? { "example.com": "z1" };
  const calls: string[] = [];
  const records: any[] = opts.dnsPresent ? [{ type: "TXT", name: "cf-bounce.example.com", content: "v=spf1 include:x ~all" }] : [];
  const subs: any[] = opts.existingSub ? [{ name: "example.com", tag: "t1", enabled: true }] : [];
  const reply = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code });
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push(key + (init.body ? ` ${init.body}` : ""));
    expect(init.headers.authorization).toBe("Bearer secret-token");
    if (opts.deny) return reply(403, { success: false, errors: [{ message: "forbidden" }] });
    if (key === "GET /client/v4/zones") return reply(200, { success: true, result: zones[u.searchParams.get("name")!] ? [{ id: zones[u.searchParams.get("name")!] }] : [] });
    if (key === "GET /client/v4/zones/z1/email/sending/subdomains") return reply(200, { success: true, result: subs });
    if (key === "POST /client/v4/zones/z1/email/sending/subdomains") {
      const s = { name: JSON.parse(init.body).name, tag: "t1", enabled: true };
      subs.push(s);
      return reply(200, { success: true, result: s });
    }
    if (key === "GET /client/v4/zones/z1/email/sending/subdomains/t1/dns")
      return reply(200, {
        success: true,
        result: [
          { type: "MX", name: "cf-bounce.example.com", content: "mx.cf.test", priority: 10 },
          { type: "TXT", name: "cf-bounce.example.com", content: "v=spf1 include:x ~all" },
        ],
      });
    if (key === "GET /client/v4/zones/z1/dns_records")
      return reply(200, { success: true, result: records.filter((r) => r.type === u.searchParams.get("type") && r.name === u.searchParams.get("name")) });
    if (key === "POST /client/v4/zones/z1/dns_records") {
      records.push(JSON.parse(init.body));
      return reply(200, { success: true, result: {} });
    }
    return reply(404, { success: false, errors: [{ message: `no route ${key}` }] });
  };
  return { fetchImpl, calls, records };
}

test.describe("onboarding through the API", () => {
  test("enables the domain and adds the records it lists", async () => {
    const f = fakeCloudflare();
    const r = await setupSendingDomain({ domain: "example.com", token: "secret-token", fetchImpl: f.fetchImpl });
    expect(r.status).toBe("ready");
    expect(f.records.map((x: any) => x.type).sort()).toEqual(["MX", "TXT"]);
    expect(f.records.find((x: any) => x.type === "MX").priority).toBe(10);
  });

  test("finds the zone of a subdomain by trying its parents", async () => {
    const f = fakeCloudflare();
    const r = await setupSendingDomain({ domain: "notes.example.com", token: "secret-token", fetchImpl: f.fetchImpl });
    expect(r.status).toBe("ready");
    expect(f.calls.some((c) => c.includes('"name":"notes.example.com"'))).toBe(true);
  });

  test("is idempotent: a second run creates nothing", async () => {
    const f = fakeCloudflare();
    await setupSendingDomain({ domain: "example.com", token: "secret-token", fetchImpl: f.fetchImpl });
    const before = f.calls.filter((c) => c.startsWith("POST")).length;
    const again = await setupSendingDomain({ domain: "example.com", token: "secret-token", fetchImpl: f.fetchImpl });
    expect(again.status).toBe("ready");
    expect(f.calls.filter((c) => c.startsWith("POST")).length).toBe(before);
  });

  test("records that already exist are left alone", async () => {
    const f = fakeCloudflare({ existingSub: true, dnsPresent: true });
    await setupSendingDomain({ domain: "example.com", token: "secret-token", fetchImpl: f.fetchImpl });
    expect(f.records.filter((x: any) => x.type === "TXT")).toHaveLength(1);
    expect(f.records.filter((x: any) => x.type === "MX")).toHaveLength(1);
  });

  test("no token: unchecked, nothing called", async () => {
    const f = fakeCloudflare();
    const r = await setupSendingDomain({ domain: "example.com", token: undefined, fetchImpl: f.fetchImpl });
    expect(r.status).toBe("unchecked");
    expect(f.calls).toEqual([]);
  });

  test("a token without the permission is unchecked, and the token is never in the result", async () => {
    const r = await setupSendingDomain({ domain: "example.com", token: "secret-token", fetchImpl: fakeCloudflare({ deny: true }).fetchImpl });
    expect(r.status).toBe("unchecked");
    expect(JSON.stringify(r)).not.toContain("secret-token");
  });

  test("a domain that is not on the account fails with a plain reason", async () => {
    const r = await setupSendingDomain({ domain: "other.org", token: "secret-token", fetchImpl: fakeCloudflare().fetchImpl });
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("not on this Cloudflare account");
  });

  test("a network error is a failure, not a crash", async () => {
    const r = await setupSendingDomain({ domain: "example.com", token: "secret-token", fetchImpl: async () => { throw new Error("offline secret-token"); } });
    expect(r.status).toBe("failed");
    expect(r.detail).not.toContain("secret-token");
  });
});
