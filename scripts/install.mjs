#!/usr/bin/env node
// Install mindmaps into YOUR Cloudflare account.
//
//   npm install && npm run install:cloudflare
//
// What it does, in order: signs you in to Cloudflare (a browser tab), creates
// the database and storage in your account, builds the app, writes
// wrangler.local.toml (your IDs; gitignored), migrates, deploys, and prints how
// to connect your AI agent. Safe to re-run: every step checks before it creates,
// and re-running is also how you upgrade after `git pull`.
//
// Flags, for agents and CI (anything not given is asked, unless --yes):
//   --yes                  accept defaults, never prompt
//   --name <worker>        Worker name (default: mindmaps)
//   --domain <host>        serve from your own domain (must be on this Cloudflare account)
//   --mindbox-domain <h>   optional: serve HTML artefacts from a second hostname (extra isolation)
//   --no-search            skip the meaning-based search index
//   --json                 print one JSON object at the end (url, mcp, next steps)

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = join(ROOT, "wrangler.local.toml");

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const YES = flag("yes") || !process.stdin.isTTY;
const JSON_OUT = flag("json");

// --- output -----------------------------------------------------------------
const say = (m = "") => (JSON_OUT ? console.error(m) : console.log(m));
const step = (m) => say(`\n▸ ${m}`);
const die = (m) => {
  console.error(`\n✗ ${m}`);
  process.exit(1);
};

// --- shell ------------------------------------------------------------------
const WR = join(ROOT, "node_modules", ".bin", "wrangler");
/** run wrangler; capture output unless `inherit` */
function wrangler(args, { inherit = false, config = true } = {}) {
  const full = config && existsSync(LOCAL) ? ["--config", LOCAL, ...args] : args;
  const r = spawnSync(WR, full, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: inherit ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: inherit ? process.env.CI : "1" },
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: JSON_OUT ? ["ignore", 2, 2] : "inherit" });
  if (r.status !== 0) die(`\`${cmd} ${args.join(" ")}\` failed.`);
};

async function ask(q, dflt) {
  if (YES) return dflt;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q}${dflt ? ` [${dflt}]` : ""} `)).trim();
  rl.close();
  return a || dflt;
}

// --- 0. prerequisites -------------------------------------------------------
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) die(`Node 20 or newer is required (you have ${process.versions.node}). Get it at https://nodejs.org`);
if (!existsSync(WR)) die("Run `npm install` first, then re-run this.");

say("mindmaps → your Cloudflare account");

// --- 1. sign in -------------------------------------------------------------
step("Signing in to Cloudflare");
let who = wrangler(["whoami"], { config: false });
if (!/You are logged in|Account ID/i.test(who.out) || /not authenticated/i.test(who.out)) {
  say("A browser tab will open. Sign in (or create a free account) and click Allow.");
  if (!wrangler(["login"], { inherit: true, config: false }).ok) die("Cloudflare sign-in didn't finish. Run it again.");
  who = wrangler(["whoami"], { config: false });
}
const accountIds = [...new Set([...who.out.matchAll(/\b([0-9a-f]{32})\b/g)].map((m) => m[1]))];
if (accountIds.length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID)
  die(
    `This login has several Cloudflare accounts:\n  ${accountIds.join("\n  ")}\nPick one: CLOUDFLARE_ACCOUNT_ID=<id> npm run install:cloudflare`,
  );
say("  signed in");

// --- 2. choices -------------------------------------------------------------
const name = opt("name") ?? (await ask("Name for your Worker?", "mindmaps"));
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) die("Worker name: lowercase letters, numbers and dashes only.");

let domain = opt("domain");
if (domain === undefined && !YES) {
  const a = await ask("Use your own domain (e.g. notes.example.com)? Press Enter to skip and use a free *.workers.dev address.", "");
  domain = a || undefined;
}
const mindbox = opt("mindbox-domain");
if (mindbox && !domain) die("--mindbox-domain needs --domain too.");
if (mindbox && mindbox === domain) die("The mindbox must be a DIFFERENT hostname from the app. See INSTALL.md.");

// --- 3. resources -----------------------------------------------------------
step("Creating your database and storage");

// D1
let dbId;
const listed = wrangler(["d1", "list", "--json"], { config: false });
try {
  dbId = JSON.parse(listed.out.slice(listed.out.indexOf("[")))?.find((d) => d.name === "mindmaps")?.uuid;
} catch {}
if (!dbId) {
  const c = wrangler(["d1", "create", "mindmaps"], { config: false });
  dbId = c.out.match(/database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/)?.[1];
  if (!dbId) die(`Couldn't create the database:\n${c.out}`);
  say("  database created");
} else say("  database already there");

// R2
const bucket = wrangler(["r2", "bucket", "create", "mindmaps-images"], { config: false });
if (!bucket.ok && !/already exists|10004/i.test(bucket.out)) {
  if (/10042|enable R2|R2 is not/i.test(bucket.out))
    die(
      "Cloudflare needs R2 switched on once for your account (free tier, but it asks for a card on file).\n" +
        "  1. Open https://dash.cloudflare.com/?to=/:account/r2/overview\n  2. Click \"Purchase R2 Plan\" / enable R2\n  3. Re-run this installer.",
    );
  die(`Couldn't create storage:\n${bucket.out}`);
}
say("  storage ready");

// Vectorize (optional)
let search = !flag("no-search");
if (search) {
  const v = wrangler(["vectorize", "create", "mindmaps-chunks", "--dimensions=1024", "--metric=cosine"], { config: false });
  if (v.ok || /already exists|vectorize\.index_already_exists|3002/i.test(v.out)) say("  search index ready");
  else {
    search = false;
    say("  couldn't create the search index; continuing without it (recall falls back to keyword search)");
  }
}

// --- 4. config --------------------------------------------------------------
step("Writing wrangler.local.toml (your IDs, never committed)");
let toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
toml = toml.replace(/^name = ".*"$/m, `name = "${name}"`);
toml = toml.replace(/^(database_name = "mindmaps")$/m, `$1\ndatabase_id = "${dbId}"`);
if (!search) toml = toml.replace(/\[\[vectorize\]\][^\[]*/m, "").replace(/\[ai\][^\[]*/m, "");
if (domain) {
  const routes = [`[[routes]]\npattern = "${domain}"\ncustom_domain = true`];
  if (mindbox) routes.push(`[[routes]]\npattern = "${mindbox}"\ncustom_domain = true`);
  toml = toml.replace(/^(compatibility_date = ".*")$/m, `$1\n\n${routes.join("\n\n")}`);
  toml += `\n[vars]\nPUBLIC_ORIGIN = "https://${domain}"\nAPP_ORIGIN = "https://${domain}"\nALLOWED_ORIGIN = "https://${domain}"\n`;
  if (mindbox) toml += `MINDBOX_ORIGIN = "https://${mindbox}"\n`;
}
writeFileSync(LOCAL, toml);

// --- 5. build, migrate, deploy ---------------------------------------------
step("Building the app");
sh("npm", ["--prefix", "web", "ci"]);
sh("npm", ["--prefix", "web", "run", "build"]);

step("Setting up the database tables");
const mig = wrangler(["d1", "migrations", "apply", "DB", "--remote"], { inherit: true });
if (!mig.ok) die("Database migration failed (see above).");

step("Deploying");
const dep = wrangler(["deploy"], { config: true });
say(dep.out);
if (!dep.ok) die("Deploy failed (see above).");
const url = domain
  ? `https://${domain}`
  : dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];

if (mindbox) {
  step("Hardening HTML artefacts with their own hostname");
  const put = spawnSync(WR, ["--config", LOCAL, "secret", "put", "MINDBOX_SECRET"], {
    cwd: ROOT,
    input: randomBytes(32).toString("base64url"),
    encoding: "utf8",
  });
  if (put.status !== 0) say("  couldn't set MINDBOX_SECRET; one will be generated automatically");
}

// --- 6. done ----------------------------------------------------------------
const mcp = url ? `${url}/mcp` : "<your-url>/mcp";
writeFileSync(join(ROOT, ".install.json"), JSON.stringify({ name, url, domain, mindbox, search, dbId }, null, 2));

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: true, url, mcp, search, htmlArtefacts: true, next: [
    `Open ${url} and create your account (the first account is yours).`,
    `claude mcp add --transport http mindmaps ${mcp}`,
  ] }));
} else {
  console.log(`
✓ mindmaps is live

  Your app      ${url ?? "(see the URL printed above)"}
  MCP endpoint  ${mcp}

Next
  1. Open your app and create your account.
  2. Connect your agent:
       claude mcp add --transport http mindmaps ${mcp}
       codex  mcp add mindmaps --url ${mcp}
     (Cursor and others: see README.md → Connect an agent.)
  3. Your data lives in YOUR Cloudflare account. Nothing is sent to anyone else.

Update later:  git pull && npm install && npm run install:cloudflare
`);
}
