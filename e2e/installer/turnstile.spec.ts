import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseTurnstile, parseSiteKey, turnstileInToml, turnstileNextSteps, widgetName,
  // @ts-expect-error plain .mjs without types
} from "../../scripts/lib/turnstile-config.mjs";
// @ts-expect-error plain .mjs without types
import { setupTurnstileWidget } from "../../scripts/lib/turnstile-cloudflare.mjs";
// @ts-expect-error plain .mjs without types
import { HOSTED_HOST, localToml } from "../../scripts/lib/install-config.mjs";

// The installer's Turnstile handling (docs/SIGNUP.md): flags and defaults through
// the real script's --dry-run, the pure decisions, the Cloudflare calls against a
// fake API, and the real script end to end with a stand-in wrangler, which shows
// where the secret goes (stdin of `wrangler secret put`) and where it never does.
// No Cloudflare account is needed.

const repo = fileURLToPath(new URL("../..", import.meta.url));
const SECRET = "s3cr3t-sentinel-turnstile-value";
const SITE = "0x4AAAAAAAtestsitekey";

let root: string;
test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mindmaps-install-ts-"));
  mkdirSync(join(root, "scripts"));
  cpSync(join(repo, "scripts/install.mjs"), join(root, "scripts/install.mjs"));
  cpSync(join(repo, "scripts/lib"), join(root, "scripts/lib"), { recursive: true });
  cpSync(join(repo, "wrangler.toml"), join(root, "wrangler.toml"));
});
test.afterEach(() => rmSync(root, { recursive: true, force: true }));

function install(env: Record<string, string> = {}, ...args: string[]) {
  const r = spawnSync("node", [join(root, "scripts/install.mjs"), "--dry-run", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TURNSTILE_SECRET_KEY: "", ...env },
  });
  let plan: any = null;
  try {
    plan = JSON.parse(r.stdout);
  } catch {
    /* a refusal prints no plan */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, plan };
}
const varsOf = (toml: string) => toml.match(/^\[vars\]\n((?:.+\n?)*)/m)?.[1] ?? "";
const count = (toml: string, re: RegExp) => (toml.match(re) ?? []).length;

test.describe("flags and defaults (dry run)", () => {
  test("the hosted service's mode makes a widget by default, even with --yes", () => {
    const r = install({}, "--yes", "--domain", HOSTED_HOST);
    expect(r.status).toBe(0);
    expect(r.plan.turnstileSource).toBe("default");
    expect(r.plan.turnstile).toEqual({ siteKey: null, host: HOSTED_HOST });
    // the key does not exist until the widget is made: a placeholder in the dry run
    expect(varsOf(r.plan.config)).toContain('TURNSTILE_SITE_KEY = "<turnstile-site-key>"');
  });

  test("--mode multitenant on another domain does too", () => {
    const r = install({}, "--yes", "--domain", "notes.example.com", "--mode", "multitenant");
    expect(r.plan.turnstileSource).toBe("default");
    expect(r.plan.turnstile.host).toBe("notes.example.com");
  });

  test("personal and org do not, with --yes", () => {
    for (const mode of ["personal", "org"]) {
      const r = install({}, "--yes", "--domain", "notes.example.com", "--mode", mode);
      expect(r.plan.turnstile, mode).toBeNull();
      expect(r.plan.turnstileSource, mode).toBe("default-off");
      expect(r.plan.config, mode).not.toContain("TURNSTILE");
    }
  });

  test("--turnstile turns it on for personal and org", () => {
    const r = install({}, "--yes", "--domain", "notes.example.com", "--mode", "org", "--turnstile");
    expect(r.status).toBe(0);
    expect(r.plan.turnstileSource).toBe("flag");
    expect(r.plan.turnstile).toEqual({ siteKey: null, host: "notes.example.com" });
  });

  test("--no-turnstile turns it off, even for the hosted service", () => {
    const r = install({}, "--yes", "--domain", HOSTED_HOST, "--no-turnstile");
    expect(r.plan.turnstile).toBeNull();
    expect(r.plan.turnstileSource).toBe("flag-off");
    expect(r.plan.config).not.toContain("TURNSTILE");
  });

  test("--turnstile-site-key uses that key, with the secret from the environment, and writes only the key", () => {
    const r = install({ TURNSTILE_SECRET_KEY: SECRET }, "--yes", "--mode", "org", "--turnstile-site-key", SITE);
    expect(r.status).toBe(0);
    expect(r.plan.turnstileSource).toBe("site-key");
    expect(r.plan.turnstile.siteKey).toBe(SITE);
    expect(varsOf(r.plan.config)).toContain(`TURNSTILE_SITE_KEY = "${SITE}"`);
    expect(count(r.plan.config, /^\[vars\]/gm)).toBe(1);
    // the secret is in no output and not in the config
    for (const out of [r.stdout, r.stderr, r.plan.config]) expect(out).not.toContain(SECRET);
    expect(r.plan.config).not.toContain("TURNSTILE_SECRET");
  });

  test("it shares the one [vars] table with the other settings", () => {
    const r = install({}, "--yes", "--domain", "notes.example.com", "--mail-from", "hi@notes.example.com", "--mode", "org", "--turnstile");
    expect(count(r.plan.config, /^\[vars\]/gm)).toBe(1);
    const v = varsOf(r.plan.config);
    for (const l of ['PUBLIC_ORIGIN = "https://notes.example.com"', 'MAIL_FROM = "hi@notes.example.com"', 'MINDMAPS_MODE = "org"', "TURNSTILE_SITE_KEY"]) expect(v).toContain(l);
  });

  test("with no domain there is nothing to make a widget for, and it says how to add one", () => {
    const r = install({}, "--yes", "--mode", "multitenant");
    expect(r.plan.turnstile).toBeNull();
    expect(r.plan.turnstileSource).toBe("no-domain");
    expect(r.stderr).toContain("--turnstile");
  });

  test("bad combinations are refused before anything happens", () => {
    for (const [env, args] of [
      [{}, ["--turnstile"]],
      [{}, ["--turnstile", "--no-turnstile", "--domain", "notes.example.com"]],
      [{}, ["--no-turnstile", "--turnstile-site-key", SITE]],
      [{}, ["--turnstile-site-key"]],
      [{}, ["--turnstile-site-key", "--yes"]],
      [{ TURNSTILE_SECRET_KEY: SECRET }, ["--turnstile-site-key", "not a key!"]],
      [{}, ["--turnstile-site-key", SITE]], // no secret in the environment
    ] as [Record<string, string>, string[]][]) {
      const r = install(env, "--yes", ...args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.plan, args.join(" ")).toBeNull();
      expect(r.stderr, args.join(" ")).not.toContain(SECRET);
    }
  });

  test("the missing-secret refusal tells how to give it, without a value", () => {
    const r = install({}, "--yes", "--turnstile-site-key", SITE);
    expect(r.stderr).toContain("TURNSTILE_SECRET_KEY=<secret>");
  });

  test("the committed wrangler.toml has no Turnstile setting", () => {
    expect(readFileSync(join(repo, "wrangler.toml"), "utf8")).not.toContain("TURNSTILE");
  });
});

test.describe("re-runs", () => {
  const first = () => install({ TURNSTILE_SECRET_KEY: SECRET }, "--yes", "--domain", "notes.example.com", "--mode", "org", "--turnstile-site-key", SITE).plan.config as string;

  test("a re-run with no Turnstile flags keeps the key the install has, and never asks for the secret again", () => {
    writeFileSync(join(root, "wrangler.local.toml"), first());
    const r = install({}, "--yes", "--domain", "notes.example.com");
    expect(r.status).toBe(0);
    expect(r.plan.turnstileSource).toBe("existing");
    expect(r.plan.turnstile.siteKey).toBe(SITE);
    expect(count(r.plan.config, /^TURNSTILE_SITE_KEY\s*=/gm)).toBe(1);
  });

  test("running it over its own output changes nothing and duplicates nothing", () => {
    writeFileSync(join(root, "wrangler.local.toml"), first());
    const again = install({}, "--yes", "--domain", "notes.example.com").plan.config as string;
    writeFileSync(join(root, "wrangler.local.toml"), again);
    const thrice = install({}, "--yes", "--domain", "notes.example.com").plan.config as string;
    expect(thrice).toBe(again);
  });

  test("--turnstile on a re-run keeps the key instead of making a second widget", () => {
    writeFileSync(join(root, "wrangler.local.toml"), first());
    const r = install({}, "--yes", "--domain", "notes.example.com", "--turnstile");
    expect(r.plan.turnstileSource).toBe("existing");
    expect(r.plan.turnstile.siteKey).toBe(SITE);
  });

  test("--no-turnstile on a re-run removes it, and a later run does not bring it back", () => {
    writeFileSync(join(root, "wrangler.local.toml"), first());
    const off = install({}, "--yes", "--domain", "notes.example.com", "--no-turnstile").plan.config as string;
    expect(off).not.toContain("TURNSTILE");
    writeFileSync(join(root, "wrangler.local.toml"), off);
    expect(install({}, "--yes", "--domain", "notes.example.com").plan.turnstile).toBeNull();
  });

  test("a new --turnstile-site-key on a re-run replaces the old one", () => {
    writeFileSync(join(root, "wrangler.local.toml"), first());
    const r = install({ TURNSTILE_SECRET_KEY: SECRET }, "--yes", "--domain", "notes.example.com", "--turnstile-site-key", "0x4AAAAAAAnewsitekey");
    expect(r.plan.turnstile.siteKey).toBe("0x4AAAAAAAnewsitekey");
    expect(count(r.plan.config, /^TURNSTILE_SITE_KEY\s*=/gm)).toBe(1);
  });
});

test.describe("decisions", () => {
  test("parsing", () => {
    expect(parseSiteKey(` ${SITE} `)).toBe(SITE);
    expect(parseSiteKey("1x00000000000000000000AA")).toBe("1x00000000000000000000AA"); // Cloudflare's published test key
    for (const bad of ["", "--yes", "short", 'quote"key12345', "a b c d e f g h", undefined]) expect(() => parseSiteKey(bad as any)).toThrow();
  });

  test("prompting: asks for personal and org with a default of no; yes makes a widget", async () => {
    const asked: string[] = [];
    const yes = async (q: string, d: string) => (asked.push(`${q}|${d}`), "y");
    const out = await chooseTurnstile({ domain: "notes.example.com", mode: "org", yes: false, existing: null, ask: yes, secretInEnv: false });
    expect(out).toMatchObject({ source: "prompt", turnstile: { host: "notes.example.com", siteKey: null } });
    expect(asked[0].endsWith("|n")).toBe(true);
    expect((await chooseTurnstile({ domain: "d.example.com", mode: "personal", yes: false, existing: null, ask: async (_q: string, d: string) => d, secretInEnv: false })).source).toBe("declined");
    await expect(chooseTurnstile({ domain: "d.example.com", mode: "org", yes: false, existing: null, ask: async () => "maybe", secretInEnv: false })).rejects.toThrow(/y.*n/);
  });

  test("multitenant is not asked", async () => {
    const ask = async () => {
      throw new Error("asked");
    };
    expect((await chooseTurnstile({ domain: "d.example.com", mode: "multitenant", yes: false, existing: null, ask, secretInEnv: false })).source).toBe("default");
  });

  test("turnstileInToml reads back what localToml wrote", () => {
    const toml = localToml('compatibility_date = "2026-09-01"\n[vars]\n', { name: "m", dbId: "x", search: true, turnstile: SITE });
    expect(turnstileInToml(toml)).toEqual({ siteKey: SITE });
    expect(turnstileInToml("[vars]\n")).toBeNull();
  });

  test("the steps for an operator carry no secret and put the secret in the environment", () => {
    const steps = turnstileNextSteps("notes.example.com").join("\n");
    expect(steps).toContain("TURNSTILE_SECRET_KEY=<secret>");
    expect(steps).toContain("notes.example.com");
    expect(steps).toContain("Account: Turnstile: Edit");
  });
});

/** A small fake of the parts of the Cloudflare API the widget setup uses. */
function fakeCloudflare(opts: { deny?: boolean; existing?: { name: string; sitekey: string }[]; failCreate?: boolean } = {}) {
  const widgets = [...(opts.existing ?? [])];
  const calls: string[] = [];
  const reply = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code });
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push(key + (init.body ? ` ${init.body}` : ""));
    expect(init.headers.authorization).toBe("Bearer api-token-value");
    if (opts.deny) return reply(403, { success: false, errors: [{ message: "forbidden" }] });
    if (key === "GET /client/v4/accounts/acct1/challenges/widgets") return reply(200, { success: true, result: widgets });
    if (key === "POST /client/v4/accounts/acct1/challenges/widgets") {
      if (opts.failCreate) return reply(400, { success: false, errors: [{ message: `bad domain, secret was ${SECRET}` }], result: { secret: SECRET } });
      const b = JSON.parse(init.body);
      const w = { name: b.name, sitekey: "0x4AAAAAAAcreated", domains: b.domains };
      widgets.push(w);
      return reply(200, { success: true, result: { ...w, secret: SECRET } });
    }
    const m = key.match(/^POST \/client\/v4\/accounts\/acct1\/challenges\/widgets\/([^/]+)\/rotate_secret$/);
    if (m) return reply(200, { success: true, result: { sitekey: m[1], secret: SECRET } });
    return reply(404, { success: false, errors: [{ message: `no route ${key}` }] });
  };
  return { fetchImpl, calls, widgets };
}
const widget = (f: ReturnType<typeof fakeCloudflare>, extra = {}) =>
  setupTurnstileWidget({ accountId: "acct1", host: "notes.example.com", token: "api-token-value", fetchImpl: f.fetchImpl, ...extra });

test.describe("making the widget through the API", () => {
  test("creates a managed widget for the host, named so a re-run can find it, and returns key and secret", async () => {
    const f = fakeCloudflare();
    const r = await widget(f);
    expect(r).toMatchObject({ status: "created", siteKey: "0x4AAAAAAAcreated", secret: SECRET });
    const create = JSON.parse(f.calls.find((c) => c.startsWith("POST"))!.replace(/^POST \S+ /, ""));
    expect(create).toMatchObject({ name: widgetName("notes.example.com"), domains: ["notes.example.com"], mode: "managed" });
  });

  test("the secret is in no step or message", async () => {
    const f = fakeCloudflare();
    const r = await widget(f);
    expect(JSON.stringify({ steps: r.steps, detail: r.detail })).not.toContain(SECRET);
    expect(JSON.stringify({ steps: r.steps, detail: r.detail })).not.toContain("api-token-value");
  });

  test("a widget made earlier for the host is reused, with a rotated secret, not duplicated", async () => {
    const f = fakeCloudflare({ existing: [{ name: widgetName("notes.example.com"), sitekey: "0x4AAAAAAAearlier" }, { name: "other", sitekey: "0x4AAAAAAAother" }] });
    const r = await widget(f);
    expect(r).toMatchObject({ status: "reused", siteKey: "0x4AAAAAAAearlier", secret: SECRET });
    expect(f.widgets).toHaveLength(2);
    expect(f.calls.some((c) => c.includes("rotate_secret"))).toBe(true);
    expect(f.calls.filter((c) => c.startsWith("POST /client/v4/accounts/acct1/challenges/widgets "))).toHaveLength(0);
  });

  test("a second run after a first creates nothing more", async () => {
    const f = fakeCloudflare();
    await widget(f);
    await widget(f);
    expect(f.widgets).toHaveLength(1);
  });

  test("a token that is refused leaves it unchecked, with a reason", async () => {
    const r = await widget(fakeCloudflare({ deny: true }));
    expect(r.status).toBe("unchecked");
    expect(r.detail).toContain("cannot manage Turnstile");
    expect(r.secret).toBeUndefined();
  });

  test("no token, or no account, is unchecked without a call", async () => {
    const f = fakeCloudflare();
    expect((await widget(f, { token: undefined })).status).toBe("unchecked");
    expect((await widget(f, { accountId: undefined })).status).toBe("unchecked");
    expect(f.calls).toHaveLength(0);
  });

  test("a refusal carries Cloudflare's reason but never the body, which can hold the secret", async () => {
    const r = await widget(fakeCloudflare({ failCreate: true }));
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("creating the widget");
    expect(r.secret).toBeUndefined();
  });

  test("a network error is reported, not thrown, and does not carry the token", async () => {
    const r = await setupTurnstileWidget({
      accountId: "acct1", host: "h.example.com", token: "api-token-value",
      fetchImpl: async () => {
        throw new Error("connect failed for Bearer api-token-value");
      },
    });
    expect(r.status).toBe("failed");
    expect(r.detail).not.toContain("api-token-value");
  });
});

// The real script, not --dry-run, with a stand-in `wrangler` and `npm` that record what
// they are asked and given. Shows the secret reaches `wrangler secret put` on stdin, after
// the deploy, and appears nowhere else.
test.describe("the real run, with a stand-in wrangler", () => {
  function setup() {
    const bin = join(root, "fakebin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    const log = join(root, "fake.log");
    const wr = `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2).filter((x, i, all) => !(x === "--config" || all[i - 1] === "--config"));
const line = a.join(" ");
fs.appendFileSync(${JSON.stringify(log)}, "wrangler " + line + "\\n");
const out = (s) => process.stdout.write(s + "\\n");
if (line === "whoami") out("You are logged in. Account ID aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
else if (line.startsWith("d1 list")) out(JSON.stringify([{ name: "mindmaps", uuid: "11111111-1111-1111-1111-111111111111" }]));
else if (line.startsWith("deploy")) out("Deployed https://notes.example.com");
else if (line.startsWith("secret put")) {
  const name = a[2];
  const stdin = fs.readFileSync(0, "utf8");
  fs.appendFileSync(${JSON.stringify(log)}, "stdin-for " + name + " " + stdin + "\\n");
  if (process.env.FAKE_FAIL_SECRET && name === "TURNSTILE_SECRET_KEY") { process.stderr.write("boom " + stdin + "\\n"); process.exit(1); }
}
`;
    writeFileSync(join(root, "node_modules/.bin/wrangler"), wr);
    chmodSync(join(root, "node_modules/.bin/wrangler"), 0o755);
    writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "npm"), 0o755);
    return { bin, log };
  }
  const run = (extra: string[], env: Record<string, string> = {}) => {
    const { bin, log } = setup();
    const r = spawnSync("node", [join(root, "scripts/install.mjs"), "--yes", "--json", "--no-search", "--no-email", "--domain", "notes.example.com", "--mode", "org", ...extra], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TURNSTILE_SECRET_KEY: SECRET, CLOUDFLARE_API_TOKEN: "", ...env },
    });
    const lines = r.stdout.trim().split("\n");
    return { ...r, result: JSON.parse(lines[lines.length - 1]), log: readFileSync(log, "utf8") };
  };

  test("stores the secret with `wrangler secret put`, on stdin, after the deploy, and prints it nowhere", () => {
    const r = run(["--turnstile-site-key", SITE]);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ ok: true, turnstile: { enabled: true, status: "site-key", siteKey: SITE } });
    const calls = r.log.split("\n");
    expect(calls.findIndex((l) => l.startsWith("wrangler deploy"))).toBeGreaterThan(-1);
    const put = calls.findIndex((l) => l === "wrangler secret put TURNSTILE_SECRET_KEY");
    expect(put).toBeGreaterThan(calls.findIndex((l) => l.startsWith("wrangler deploy")));
    expect(calls[put + 1]).toBe(`stdin-for TURNSTILE_SECRET_KEY ${SECRET}`);
    // the secret is in no argument, no output, no file the installer wrote
    expect(calls.filter((l) => l.startsWith("wrangler ")).join("\n")).not.toContain(SECRET);
    for (const out of [r.stdout, r.stderr]) expect(out).not.toContain(SECRET);
    for (const f of ["wrangler.local.toml", ".install.json"]) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text, f).not.toContain(SECRET);
    }
    expect(readFileSync(join(root, "wrangler.local.toml"), "utf8")).toContain(`TURNSTILE_SITE_KEY = "${SITE}"`);
    expect(JSON.parse(readFileSync(join(root, ".install.json"), "utf8")).turnstile).toEqual({ siteKey: SITE });
  });

  test("a failed `secret put` leaves the check off, says so, and still does not print the secret", () => {
    const r = run(["--turnstile-site-key", SITE], { FAKE_FAIL_SECRET: "1" });
    expect(r.status).toBe(0);
    expect(r.result.turnstile).toMatchObject({ enabled: false, status: "secret-failed" });
    expect(r.result.turnstile.next[0]).toContain("wrangler secret put TURNSTILE_SECRET_KEY");
    for (const out of [r.stdout, r.stderr]) expect(out).not.toContain(SECRET);
  });

  test("no Turnstile, no secret put and no Turnstile in the config", () => {
    const r = run(["--no-turnstile"]);
    expect(r.result.turnstile.enabled).toBe(false);
    expect(r.log).not.toContain("TURNSTILE_SECRET_KEY");
    expect(existsSync(join(root, "wrangler.local.toml"))).toBe(true);
    expect(readFileSync(join(root, "wrangler.local.toml"), "utf8")).not.toContain("TURNSTILE");
  });

  test("a re-run that keeps its key does not store a secret again", () => {
    const first = run(["--turnstile-site-key", SITE]);
    const second = run([], { TURNSTILE_SECRET_KEY: "" });
    expect(second.result.turnstile).toMatchObject({ enabled: true, status: "kept", siteKey: SITE });
    // the log keeps both runs; the second adds no secret put of its own
    expect(second.log.slice(first.log.length)).not.toContain("secret put");
  });

  test("--turnstile with no API token says how to finish by hand, and installs without it", () => {
    const r = run(["--turnstile"], { TURNSTILE_SECRET_KEY: "" });
    expect(r.status).toBe(0);
    expect(r.result.turnstile).toMatchObject({ enabled: false });
    expect(r.result.turnstile.next.join("\n")).toContain("--turnstile-site-key");
    expect(r.log).not.toContain("secret put TURNSTILE_SECRET_KEY");
    expect(readFileSync(join(root, "wrangler.local.toml"), "utf8")).not.toContain("TURNSTILE");
  });
});
