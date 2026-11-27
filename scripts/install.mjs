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
//                          (the hosted service's host is always multitenant; docs/MODES.md)
//   --mindbox-domain <h>   optional: serve HTML artefacts from a second hostname (extra isolation)
//   --mode <mode>          personal | org (asked if omitted; --yes picks personal on a first
//                          install, and a re-run keeps the mode it has). multitenant is the
//                          hosted-service mode: accepted here, never offered. See docs/MODES.md
//   --mail-domain <host>   send email (confirm address, reset password) from this domain, which must
//                          be on your Cloudflare account. Default: the --domain. See docs/EMAIL.md
//   --mail-from <address>  the sender address (default: mindmaps@<mail domain>)
//   --no-email             do not set up email (and remove it from an install that has it)
//   --mail-skip-check      write the email config without confirming the domain is onboarded
//                          (for a domain you onboarded in the dashboard)
//   --turnstile            protect sign-up with Cloudflare Turnstile: makes a widget for your --domain in
//                          your account (the default for the hosted service's multitenant mode; asked
//                          for personal and org, where --yes means no). See docs/SIGNUP.md
//   --turnstile-site-key <key>  use a widget you made in the dashboard; its secret is read from the
//                          TURNSTILE_SECRET_KEY environment variable (never from the command line)
//   --no-turnstile         no Turnstile (and removed from an install that has it)
//   --no-search            skip the meaning-based search index
//   --dry-run              work out the choices and print the config; touch nothing, sign in nowhere
//   --json                 print one JSON object at the end (url, mcp, next steps)

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { chooseMail, mailInToml, mailNextSteps } from "./lib/mail-config.mjs";
import { setupSendingDomain } from "./lib/mail-cloudflare.mjs";
import { SECRET_NAME as TURNSTILE_SECRET, chooseTurnstile, turnstileInToml, turnstileNextSteps } from "./lib/turnstile-config.mjs";
import { setupTurnstileWidget } from "./lib/turnstile-cloudflare.mjs";
import { HOSTED_HOST, MODES, assertHostedMode, chooseMode, isHostedHost, localToml, modeInToml, parseMode, tomlIsHosted } from "./lib/install-config.mjs";

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
const DRY = flag("dry-run");

// --- output -----------------------------------------------------------------
const say = (m = "") => (JSON_OUT || DRY ? console.error(m) : console.log(m));
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
const existingToml = existsSync(LOCAL) ? readFileSync(LOCAL, "utf8") : null;
// Refuse a bad --mode before anything is created or signed in to, and for the
// hosted service anything but multitenant.
if (flag("mode"))
  try {
    parseMode(opt("mode"));
    if (opt("domain") ? isHostedHost(opt("domain")) : existingToml && tomlIsHosted(existingToml)) assertHostedMode(opt("mode"));
  } catch (e) {
    die(e.message);
  }
if (!DRY && !existsSync(WR)) die("Run `npm install` first, then re-run this.");

say("mindmaps → your Cloudflare account");

// --- 1. sign in -------------------------------------------------------------
let accountIds = [];
if (!DRY) {
  step("Signing in to Cloudflare");
  let who = wrangler(["whoami"], { config: false });
  if (!/You are logged in|Account ID/i.test(who.out) || /not authenticated/i.test(who.out)) {
    say("A browser tab will open. Sign in (or create a free account) and click Allow.");
    if (!wrangler(["login"], { inherit: true, config: false }).ok) die("Cloudflare sign-in didn't finish. Run it again.");
    who = wrangler(["whoami"], { config: false });
  }
  accountIds = [...new Set([...who.out.matchAll(/\b([0-9a-f]{32})\b/g)].map((m) => m[1]))];
  if (accountIds.length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID)
    die(
      `This login has several Cloudflare accounts:\n  ${accountIds.join("\n  ")}\nPick one: CLOUDFLARE_ACCOUNT_ID=<id> npm run install:cloudflare`,
    );
  say("  signed in");
}

// --- 2. choices -------------------------------------------------------------
const name = opt("name") ?? (await ask("Name for your Worker?", "mindmaps"));
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) die("Worker name: lowercase letters, numbers and dashes only.");

let domain = opt("domain");
// A re-run of the hosted install without --domain keeps its host, so the config
// written still says where it is served from (and so still pins itself).
if (domain === undefined && existingToml && tomlIsHosted(existingToml)) domain = HOSTED_HOST;
if (domain === undefined && !YES) {
  const a = await ask("Use your own domain (e.g. notes.example.com)? Press Enter to skip and use a free *.workers.dev address.", "");
  domain = a || undefined;
}
const mindbox = opt("mindbox-domain");
if (mindbox && !domain) die("--mindbox-domain needs --domain too.");
if (mindbox && mindbox === domain) die("The mindbox must be a DIFFERENT hostname from the app. See INSTALL.md.");

let chosen;
try {
  chosen = await chooseMode({
    flag: flag("mode") ? opt("mode") : undefined,
    yes: YES,
    hosted: domain ? isHostedHost(domain) : false,
    existing: existingToml ? { mode: modeInToml(existingToml) } : null,
    ask,
  });
} catch (e) {
  die(e.message);
}
const mode = chosen.mode;
if (chosen.source === "hosted") say(`  ${HOSTED_HOST} is the hosted service: mode multitenant`);
if (chosen.source === "existing")
  say(
    mode
      ? `  keeping mode ${mode} (change it with --mode ${MODES.join("|")})`
      : "  this install has no MINDMAPS_MODE set, so it runs as multitenant, as before (set one with --mode personal|org)",
  );

let chosenMail;
try {
  chosenMail = await chooseMail({
    from: flag("mail-from") ? (opt("mail-from") ?? "") : undefined,
    domain: flag("mail-domain") ? (opt("mail-domain") ?? "") : undefined,
    noEmail: flag("no-email"),
    appDomain: domain,
    existing: existingToml ? mailInToml(existingToml) : null,
    yes: YES,
    ask,
  });
} catch (e) {
  die(e.message);
}
let mail = chosenMail.mail;
if (mail) say(`  email: ${mail.from} (${chosenMail.source})`);
else if (chosenMail.source === "no-domain")
  say("  email: skipped. It needs a domain of your own; add one later with --mail-domain <domain> (docs/EMAIL.md)");
else if (chosenMail.source === "flag-off") say("  email: off (--no-email)");

let chosenTs;
try {
  if (flag("turnstile") && flag("no-turnstile")) throw new Error("--turnstile cannot be combined with --no-turnstile.");
  chosenTs = await chooseTurnstile({
    flag: flag("no-turnstile") ? "off" : flag("turnstile") ? "on" : undefined,
    siteKey: flag("turnstile-site-key") ? (opt("turnstile-site-key") ?? "") : undefined,
    secretInEnv: !!process.env[TURNSTILE_SECRET]?.trim(),
    domain,
    mode,
    existing: existingToml ? turnstileInToml(existingToml) : null,
    yes: YES,
    ask,
  });
} catch (e) {
  die(e.message);
}
let turnstile = chosenTs.turnstile;
if (turnstile) say(`  turnstile: on (${chosenTs.source})`);
else if (chosenTs.source === "no-domain") say("  turnstile: skipped. It needs a hostname; add it later with --turnstile --domain <host> (docs/SIGNUP.md)");
else if (chosenTs.source === "flag-off") say("  turnstile: off (--no-turnstile)");

if (DRY) {
  const config = localToml(readFileSync(join(ROOT, "wrangler.toml"), "utf8"), {
    name, dbId: "<database-id>", search: !flag("no-search"), domain, mindbox, mode, mail,
    turnstile: turnstile ? turnstile.siteKey ?? "<turnstile-site-key>" : undefined,
  });
  console.log(JSON.stringify({ dryRun: true, name, domain: domain ?? null, mindbox: mindbox ?? null, mode: mode ?? null, source: chosen.source, mail: mail ?? null, mailSource: chosenMail.source, turnstile: turnstile ?? null, turnstileSource: chosenTs.source, config }));
  process.exit(0);
}

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

/** The API token for REST calls: CLOUDFLARE_API_TOKEN, else the one `wrangler login` holds. Never printed. */
function apiToken() {
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const t = wrangler(["auth", "token"], { config: false });
    const candidate = t.out.trim();
    if (t.ok && /^[\w-]{20,}$/.test(candidate)) token = candidate;
  }
  return token;
}

// Email (optional). Onboard the sending domain through the API where the token
// allows it. The config only turns email on once the domain is known to be ready:
// with verification on and no mail arriving, invited people could not join.
let mailReport = { enabled: false, next: [] };
if (mail) {
  step(`Setting up email for ${mail.domain}`);
  const reuse = chosenMail.source === "existing" && flag("mail-skip-check");
  const token = apiToken();
  const r = flag("mail-skip-check") || reuse ? { status: "skipped", steps: [], detail: "" } : await setupSendingDomain({ domain: mail.domain, token });
  for (const s of r.steps) say(`  ${s}`);
  const next = mailNextSteps(mail.domain, mail.from);
  if (r.status === "ready" || r.status === "skipped") {
    say(r.status === "ready" ? "  email ready (DNS records can take a few minutes to verify)" : "  email config written without checking (--mail-skip-check)");
    mailReport = { enabled: true, status: r.status, domain: mail.domain, from: mail.from, next: [] };
  } else if (chosenMail.source === "existing") {
    // An upgrade must not switch off email that was already working just because this run cannot re-check it.
    say(`  email kept as it was (could not re-check: ${r.detail})`);
    mailReport = { enabled: true, status: "kept", domain: mail.domain, from: mail.from, next: [] };
  } else {
    // A first try that could not finish leaves email off.
    say(`  email not switched on: ${r.detail}`);
    for (const n of next) say(`    - ${n}`);
    mailReport = { enabled: false, status: r.status, domain: mail.domain, from: mail.from, detail: r.detail, next };
    mail = null;
  }
}

// Turnstile (optional). The site key goes into the config; the secret is held in
// memory until the Worker exists and is then handed to `wrangler secret put`.
// Never printed, logged or written to a file.
let turnstileSecret = process.env[TURNSTILE_SECRET]?.trim() || null;
let tsReport = { enabled: false, next: [] };
if (turnstile && chosenTs.source === "existing") tsReport = { enabled: true, status: "kept", siteKey: turnstile.siteKey, next: [] };
else if (turnstile && turnstile.siteKey) tsReport = { enabled: true, status: "site-key", siteKey: turnstile.siteKey, next: [] };
else if (turnstile) {
  step(`Setting up Turnstile for ${turnstile.host}`);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (accountIds.length === 1 ? accountIds[0] : undefined);
  const r = await setupTurnstileWidget({ accountId, host: turnstile.host, token: apiToken() });
  for (const s of r.steps) say(`  ${s}`);
  if (r.siteKey && r.secret) {
    turnstile = { ...turnstile, siteKey: r.siteKey };
    turnstileSecret = r.secret;
    tsReport = { enabled: true, status: r.status, siteKey: r.siteKey, next: [] };
  } else {
    // A first try that could not finish leaves Turnstile off, like email.
    const next = turnstileNextSteps(turnstile.host);
    say(`  turnstile not switched on: ${r.detail}`);
    for (const n of next) say(`    - ${n}`);
    tsReport = { enabled: false, status: r.status, detail: r.detail, next };
    turnstile = null;
  }
}

// --- 4. config --------------------------------------------------------------
step("Writing wrangler.local.toml (your IDs, never committed)");
const toml = localToml(readFileSync(join(ROOT, "wrangler.toml"), "utf8"), { name, dbId, search, domain, mindbox, mode, mail, turnstile: turnstile?.siteKey });
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

// The Turnstile secret, now that the Worker exists. Without it the check stays off
// (the Worker needs the key AND the secret), so a failure here is safe, not open.
if (turnstile && chosenTs.source !== "existing" && turnstileSecret) {
  step("Storing the Turnstile secret");
  const put = spawnSync(WR, ["--config", LOCAL, "secret", "put", TURNSTILE_SECRET], {
    cwd: ROOT,
    input: turnstileSecret,
    encoding: "utf8",
  });
  turnstileSecret = null;
  if (put.status === 0) say("  stored");
  else {
    // Say nothing of wrangler's output: it is not ours to repeat, and a secret must never be in a log.
    const next = [`Set the secret yourself: npx wrangler secret put ${TURNSTILE_SECRET} (Dashboard → Turnstile → your widget → rotate secret, for a value).`];
    say(`  couldn't store the secret, so the check is off until you do. ${next[0]}`);
    tsReport = { ...tsReport, enabled: false, status: "secret-failed", next };
  }
}

// --- 6. done ----------------------------------------------------------------
const mcp = url ? `${url}/mcp` : "<your-url>/mcp";
writeFileSync(join(ROOT, ".install.json"), JSON.stringify({ name, url, domain, mindbox, search, mode, mail: mail ?? undefined, turnstile: turnstile ? { siteKey: turnstile.siteKey } : undefined, dbId }, null, 2));

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: true, url, mcp, search, mode: mode ?? "multitenant", htmlArtefacts: true, email: mailReport, turnstile: tsReport, next: [
    ...mailReport.next,
    ...tsReport.next,
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

${mail ? `  Email         sent from ${mail.from}` : "  Email         off (docs/EMAIL.md says how to turn it on)"}
  Turnstile     ${tsReport.enabled ? "on for sign-up" : "off (docs/SIGNUP.md says how to turn it on)"}
${mailReport.next.length ? "\nEmail is not on yet. To finish it:\n" + mailReport.next.map((n) => `  - ${n}`).join("\n") + "\n" : ""}${tsReport.next.length ? "\nTurnstile is not on yet. To finish it:\n" + tsReport.next.map((n) => `  - ${n}`).join("\n") + "\n" : ""}
Update later:  git pull && npm install && npm run install:cloudflare
`);
}
