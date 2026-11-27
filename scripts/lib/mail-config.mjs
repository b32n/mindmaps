// The installer's email decisions, as plain functions: which sending domain and
// from address, what goes into wrangler.local.toml, and what an existing install
// already has. Kept apart from install.mjs (which talks to Cloudflare) so they
// can be tested without an account. See docs/EMAIL.md.

export const DEFAULT_LOCAL_PART = "mindmaps";
export const DEFAULT_FROM_NAME = "mindmaps";

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS = /^[^@\s<>"]+@([^@\s<>"]+)$/;

/** The bare lowercase hostname in `value`, or null when it is not one. */
export function parseMailDomain(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("--"))
    throw new Error("--mail-domain needs a value: the domain mail is sent from, e.g. example.com.");
  const host = value.trim().toLowerCase();
  if (!HOST.test(host)) throw new Error(`--mail-domain "${value}" is not a domain name.`);
  return host;
}

/** Validates a `--mail-from` value; returns `{ address, domain }`. */
export function parseMailFrom(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("--"))
    throw new Error("--mail-from needs a value: the address mail comes from, e.g. mindmaps@example.com.");
  const address = value.trim().toLowerCase();
  const m = address.match(ADDRESS);
  if (!m || !HOST.test(m[1])) throw new Error(`--mail-from "${value}" is not an email address.`);
  return { address, domain: m[1] };
}

const within = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** The MAIL_* an existing wrangler.local.toml sets, or null when it sets no sender. */
export function mailInToml(toml) {
  const get = (k) => toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1] || null;
  const from = get("MAIL_FROM");
  if (!from) return null;
  return { from, fromName: get("MAIL_FROM_NAME") ?? DEFAULT_FROM_NAME, domain: get("MAIL_DOMAIN") ?? from.split("@")[1] };
}

/**
 * Which email setup to install, and why.
 *
 *   --no-email                  none (and removed from an install that had it)
 *   --mail-from / --mail-domain that, validated; the other is derived (the from
 *                               address is mindmaps@<domain>, the domain is the from's)
 *   re-run of an install that   what it has, so an upgrade never changes the sender
 *   has email
 *   --yes, with a --domain      mindmaps@<that domain>
 *   --yes, no domain            none: email needs a domain of your own (workers.dev
 *                               cannot send), and the installer says how to add one
 *   interactive                 asks for the domain (default: the app's), then the address
 *
 * Returns `{ mail, source }`; mail is null (none) or `{ from, fromName, domain }`.
 */
export async function chooseMail({ from, domain, noEmail, appDomain, existing, yes, ask }) {
  if (noEmail) {
    if (from !== undefined || domain !== undefined) throw new Error("--no-email cannot be combined with --mail-from or --mail-domain.");
    return { mail: null, source: "flag-off" };
  }
  if (from !== undefined || domain !== undefined) {
    const f = from !== undefined ? parseMailFrom(from) : null;
    const d = domain !== undefined ? parseMailDomain(domain) : f.domain;
    if (f && !within(f.domain, d)) throw new Error(`--mail-from ${f.address} is not on --mail-domain ${d}.`);
    return { mail: { from: f ? f.address : `${DEFAULT_LOCAL_PART}@${d}`, fromName: existing?.fromName ?? DEFAULT_FROM_NAME, domain: d }, source: "flag" };
  }
  if (existing) return { mail: existing, source: "existing" };

  if (yes) {
    if (!appDomain) return { mail: null, source: "no-domain" };
    return { mail: { from: `${DEFAULT_LOCAL_PART}@${appDomain}`, fromName: DEFAULT_FROM_NAME, domain: appDomain }, source: "default" };
  }
  const answer = (
    await ask(
      "Send email (confirm your address, reset a password)? It needs a domain on your Cloudflare account.\nSending domain (Enter to skip)",
      appDomain ?? "",
    )
  ).trim().toLowerCase();
  if (!answer || answer === "none" || answer === "no") return { mail: null, source: "declined" };
  const d = parseMailDomain(answer);
  const fromAnswer = (await ask("Send from", `${DEFAULT_LOCAL_PART}@${d}`)).trim().toLowerCase();
  const f = parseMailFrom(fromAnswer);
  if (!within(f.domain, d)) throw new Error(`${f.address} is not on ${d}.`);
  return { mail: { from: f.address, fromName: DEFAULT_FROM_NAME, domain: d }, source: "prompt" };
}

/** The `[[send_email]]` binding, for the routes-and-bindings part of the config. */
export const SEND_EMAIL_BLOCK = `[[send_email]]\nname = "EMAIL"`;

/** The [vars] lines for a mail setup. */
export function mailVars(mail) {
  return [`MAIL_FROM = "${mail.from}"`, `MAIL_FROM_NAME = "${mail.fromName.replace(/["\\]/g, "")}"`, `MAIL_DOMAIN = "${mail.domain}"`];
}

/** What the operator has to do when the installer could not finish by itself. */
export function mailNextSteps(domain, from) {
  return [
    `Cloudflare dashboard → Compute → Email Service → Email Sending → Onboard Domain → choose ${domain} (it adds the DNS records for you).`,
    `Or let the installer do it: create an API token with "Email Sending: Edit", "Zone: Read" and "DNS: Edit" on that zone, then re-run with CLOUDFLARE_API_TOKEN=<token> npm run install:cloudflare -- --mail-domain ${domain}.`,
    `Wait for the DNS records to verify (usually minutes), then re-run: npm run install:cloudflare -- --mail-from ${from} --mail-skip-check`,
  ];
}
