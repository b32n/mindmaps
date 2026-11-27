// The installer's Cloudflare Turnstile decisions, as plain functions: whether to
// protect sign-up with it, which site key goes into wrangler.local.toml, and what
// an existing install already has. Kept apart from install.mjs (which talks to
// Cloudflare) so they can be tested without an account. See docs/SIGNUP.md.
//
// Only the SITE key ever lands in a file. The secret goes to `wrangler secret put`
// and is never printed, logged or written.

export const SECRET_NAME = "TURNSTILE_SECRET_KEY";

// Cloudflare's keys are letters, digits, "_" and "-" (real ones start 0x4; the
// published test keys are 1x000...AA). Anything else cannot be one, and would
// otherwise reach a TOML file.
const SITE_KEY = /^[0-9A-Za-z_-]{8,64}$/;

/** Validates a `--turnstile-site-key` value; returns the key. */
export function parseSiteKey(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("--"))
    throw new Error("--turnstile-site-key needs a value: the site key of a Turnstile widget (the secret goes in TURNSTILE_SECRET_KEY).");
  const key = value.trim();
  if (!SITE_KEY.test(key)) throw new Error(`--turnstile-site-key "${value}" is not a Turnstile site key.`);
  return key;
}

/** The TURNSTILE_SITE_KEY an existing wrangler.local.toml sets, or null. */
export function turnstileInToml(toml) {
  const key = toml.match(/^TURNSTILE_SITE_KEY\s*=\s*"([^"]*)"/m)?.[1];
  return key ? { siteKey: key } : null;
}

/** The name the installer gives the widget it makes, so a re-run can find it. */
export const widgetName = (host) => `mindmaps (${host})`;

/**
 * Which Turnstile setup to install, and why.
 *
 *   --no-turnstile                 none (and removed from an install that had it)
 *   --turnstile-site-key <key>     that widget; its secret comes from TURNSTILE_SECRET_KEY
 *   --turnstile                    make a widget for the domain (or find the one made before)
 *   re-run of an install that has  what it has, so an upgrade never changes the key
 *   it
 *   multitenant (the hosted        on: make a widget for the domain, without asking; with --yes too
 *   service's mode) with a domain
 *   personal / org                 asked, default no; --yes means no
 *   no domain                      nothing to make a widget for: off, with how to add it later
 *
 * `mode` is the mode being installed (null when left unset; an install with no mode is a
 * personal-style one for this purpose: only an explicit multitenant turns it on by default).
 * Returns `{ turnstile, source }`; turnstile is null (off) or `{ siteKey, host }`:
 * siteKey is null until the widget is made, host is what it is made for.
 */
export async function chooseTurnstile({ flag, siteKey, secretInEnv, domain, mode, existing, yes, ask }) {
  if (flag === "off") {
    if (siteKey !== undefined) throw new Error("--no-turnstile cannot be combined with --turnstile-site-key.");
    return { turnstile: null, source: "flag-off" };
  }
  if (siteKey !== undefined) {
    const key = parseSiteKey(siteKey);
    if (!secretInEnv)
      throw new Error(`--turnstile-site-key needs the widget's secret in the environment: ${SECRET_NAME}=<secret> npm run install:cloudflare -- --turnstile-site-key ${key}`);
    return { turnstile: { siteKey: key, host: domain ?? null }, source: "site-key" };
  }
  if (existing) return { turnstile: { siteKey: existing.siteKey, host: domain ?? null }, source: "existing" };

  if (flag === "on") {
    if (!domain) throw new Error("--turnstile needs --domain: the widget is made for your hostname. Or make one in the dashboard and pass --turnstile-site-key.");
    return { turnstile: { siteKey: null, host: domain }, source: "flag" };
  }
  if (!domain) return { turnstile: null, source: "no-domain" };
  // The hosted service's mode: the sign-up check is on by default, as it takes the traffic.
  if (mode === "multitenant") return { turnstile: { siteKey: null, host: domain }, source: "default" };
  if (yes) return { turnstile: null, source: "default-off" };
  const answer = (
    await ask(
      "Protect sign-up with Cloudflare Turnstile (a bot check)? It makes a widget for your domain in your Cloudflare account. (y/n)",
      "n",
    )
  ).trim().toLowerCase();
  if (["y", "yes"].includes(answer)) return { turnstile: { siteKey: null, host: domain }, source: "prompt" };
  if (["n", "no", ""].includes(answer)) return { turnstile: null, source: "declined" };
  throw new Error(`Answer "y" or "n" (you said "${answer}").`);
}

/** What the operator does when the installer could not finish by itself. Never contains a secret. */
export function turnstileNextSteps(host) {
  return [
    `Cloudflare dashboard → Turnstile → Add widget → hostname ${host ?? "<your hostname>"} → Managed. Copy the site key and the secret.`,
    `Then re-run with the site key, giving the secret in the environment (not on the command line): ${SECRET_NAME}=<secret> npm run install:cloudflare -- --turnstile-site-key <site key>`,
    `Or let the installer make the widget: create an API token with "Account: Turnstile: Edit", then re-run with CLOUDFLARE_API_TOKEN=<token> npm run install:cloudflare -- --turnstile`,
  ];
}
