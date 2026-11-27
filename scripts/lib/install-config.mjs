// The installer's decisions, as plain functions: which mode, and what goes into
// wrangler.local.toml. Kept apart from install.mjs (which talks to Cloudflare)
// so they can be tested without an account. See docs/MODES.md.

import { SEND_EMAIL_BLOCK, mailVars } from "./mail-config.mjs";

/** Every value the Worker accepts for MINDMAPS_MODE (worker/src/mode.ts). */
export const MODES = ["personal", "org", "multitenant"];
/** What the interactive prompt offers. multitenant is the hosted-service mode: `--mode multitenant` only. */
export const PROMPTED_MODES = ["personal", "org"];
/** What `--yes` picks on a first install. */
export const DEFAULT_MODE = "personal";

/**
 * The hostname of the hosted service. An install served from it is pinned to
 * multitenant: the installer refuses anything else for it, and `npm run deploy`
 * forces it (scripts/deploy.mjs). See docs/MODES.md.
 */
export const HOSTED_HOST = "mindmaps.b32n.io";

export const MODE_HELP = {
  personal: "just you, plus the people you invite one by one",
  org: "a team or company running its own instance",
};

/** Validates a `--mode` value; throws an Error whose message is fit to show. */
export function parseMode(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("--"))
    throw new Error(`--mode needs a value: ${MODES.join(", ")}.`);
  if (!MODES.includes(value))
    throw new Error(`--mode "${value}" is not a mode. Use one of: ${MODES.join(", ")}.`);
  return value;
}

/** The MINDMAPS_MODE an existing wrangler.local.toml sets: a mode, or null when it sets none. */
export function modeInToml(toml) {
  return toml.match(/^MINDMAPS_MODE\s*=\s*"([^"]*)"/m)?.[1] || null;
}

/** The bare lowercase hostname in `value` (a host, or a URL with or without a scheme, port or path). */
function hostOf(value) {
  return String(value).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0].replace(/:\d+$/, "").toLowerCase();
}

/** Whether `host` (or a URL) is the hosted service's hostname. */
export function isHostedHost(host) {
  return !!host && hostOf(host) === HOSTED_HOST;
}

/** The hostnames a wrangler.local.toml serves from: its PUBLIC_ORIGIN / APP_ORIGIN and [[routes]] patterns. */
export function hostsInToml(toml) {
  const hosts = [];
  for (const m of toml.matchAll(/^(?:PUBLIC_ORIGIN|APP_ORIGIN|pattern)\s*=\s*"([^"]*)"/gm)) hosts.push(hostOf(m[1]));
  return hosts;
}

/** Whether a wrangler.local.toml is the hosted service's. */
export function tomlIsHosted(toml) {
  return hostsInToml(toml).includes(HOSTED_HOST);
}

/** Throws unless `flag` is absent or multitenant: the hosted service takes no other mode. */
export function assertHostedMode(flag) {
  if (flag !== undefined && parseMode(flag) !== "multitenant")
    throw new Error(`${HOSTED_HOST} is the hosted service and is always multitenant; --mode ${flag} is not allowed for it.`);
}

/**
 * Which mode to install, and why.
 *
 *   the hosted host                  multitenant, always; any other --mode is refused
 *   --mode given                     that, validated
 *   re-run of an existing install    what it already has, so an upgrade never changes the
 *                                    mode; an install from before modes existed stays unset
 *                                    (the Worker treats that as multitenant, as before)
 *   --yes (or no terminal)           personal
 *   interactive                      asks "personal or org?"
 *
 * `hosted` is true for the hosted service's hostname. `existing` is null for a first install, else `{ mode }` with mode null when unset.
 * Returns `{ mode, source }`; mode null means leave MINDMAPS_MODE out of the config.
 */
export async function chooseMode({ flag, yes, existing, hosted, ask }) {
  if (hosted) {
    assertHostedMode(flag);
    return { mode: "multitenant", source: "hosted" };
  }
  if (flag !== undefined) return { mode: parseMode(flag), source: "flag" };
  if (existing) return { mode: existing.mode, source: "existing" };
  if (yes) return { mode: DEFAULT_MODE, source: "default" };
  const lines = PROMPTED_MODES.map((m) => `  ${m.padEnd(9)} ${MODE_HELP[m]}`).join("\n");
  const answer = (await ask(`Is this install personal or org?\n${lines}\nChoose`, DEFAULT_MODE)).trim().toLowerCase();
  if (!PROMPTED_MODES.includes(answer)) throw new Error(`Answer "personal" or "org" (you said "${answer}").`);
  return { mode: answer, source: "prompt" };
}

/**
 * wrangler.local.toml: the committed wrangler.toml with this install's IDs,
 * optional pieces and [vars] filled in.
 */
export function localToml(template, { name, dbId, search, domain, mindbox, mode, mail, turnstile }) {
  // The committed wrangler.toml carries a default MINDMAPS_MODE (for the Deploy
  // button). This install's choice replaces it: drop it, then write ours, or
  // none when the choice is to leave it unset.
  let toml = template.replace(/^MINDMAPS_MODE\s*=.*\r?\n?/gm, "");
  toml = toml.replace(/^name = ".*"$/m, `name = "${name}"`);
  toml = toml.replace(/^(database_name = "mindmaps")$/m, `$1\ndatabase_id = "${dbId}"`);
  if (!search) toml = toml.replace(/\[\[vectorize\]\][^\[]*/m, "").replace(/\[ai\][^\[]*/m, "");

  const vars = [];
  if (domain) {
    const routes = [`[[routes]]\npattern = "${domain}"\ncustom_domain = true`];
    if (mindbox) routes.push(`[[routes]]\npattern = "${mindbox}"\ncustom_domain = true`);
    toml = toml.replace(/^(compatibility_date = ".*")$/m, `$1\n\n${routes.join("\n\n")}`);
    vars.push(`PUBLIC_ORIGIN = "https://${domain}"`, `APP_ORIGIN = "https://${domain}"`, `ALLOWED_ORIGIN = "https://${domain}"`);
    if (mindbox) vars.push(`MINDBOX_ORIGIN = "https://${mindbox}"`);
  }
  if (mode) vars.push(`MINDMAPS_MODE = "${mode}"`);
  if (mail) {
    // Outbound email (docs/EMAIL.md): the send binding, and who mail comes from.
    toml = toml.replace(/^(compatibility_date = ".*")$/m, `$1\n\n${SEND_EMAIL_BLOCK}`);
    vars.push(...mailVars(mail));
  }

  // The Turnstile SITE key (public). The secret is a Worker secret and never in this file.
  if (turnstile) vars.push(`TURNSTILE_SITE_KEY = "${turnstile}"`);

  if (vars.length) {
    // One [vars] table only: a second one is a TOML error.
    if (/^\[vars\]/m.test(toml)) toml = toml.replace(/^\[vars\]\s*$/m, `[vars]\n${vars.join("\n")}`);
    else toml += `\n[vars]\n${vars.join("\n")}\n`;
  }
  return toml;
}
