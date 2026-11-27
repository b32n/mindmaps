// Where the Workers listen and what the two origin-configured ones are told
// their public addresses are. Shared by playwright.config.ts and the specs, so
// the expectation and the configuration cannot drift apart.
//
// Every Worker is reached at 127.0.0.1. The configured origins name other hosts
// that loop back to the same Worker (`localhost`, `127.0.0.2`), so a URL built
// from the request's own address is told apart from one built from the
// configuration, and each URL can still be opened.

const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

export const MAIN_PORT = port("E2E_PORT", 8788);
export const CLOSED_PORT = port("E2E_CLOSED_PORT", 8789);
/** PUBLIC_ORIGIN set. */
export const ORIGIN_PORT = port("E2E_ORIGIN_PORT", 8790);
/** PUBLIC_ORIGIN, APP_ORIGIN and MINDBOX_ORIGIN set. */
export const MINDBOX_PORT = port("E2E_MINDBOX_PORT", 8791);

export const originWorker = {
  port: ORIGIN_PORT,
  /** How the tests reach it. */
  baseURL: `http://127.0.0.1:${ORIGIN_PORT}`,
  publicOrigin: `http://localhost:${ORIGIN_PORT}`,
};

export const mindboxWorker = {
  port: MINDBOX_PORT,
  baseURL: `http://127.0.0.1:${MINDBOX_PORT}`,
  publicOrigin: `http://localhost:${MINDBOX_PORT}`,
  mindboxOrigin: `http://127.0.0.2:${MINDBOX_PORT}`,
};

/**
 * The mock services the SSO specs use (e2e/support/mock-services.mjs): an OIDC
 * identity provider, and a DNS-over-HTTPS resolver the Workers ask when a domain
 * is verified. One process, two ports, right after the four Workers above.
 * `E2E_IDP_PORT` and `E2E_DOH_PORT` move them.
 */
export const IDP_PORT = port("E2E_IDP_PORT", MAIN_PORT + 4);
export const DOH_PORT = port("E2E_DOH_PORT", MAIN_PORT + 5);
export const IDP_ORIGIN = `http://127.0.0.1:${IDP_PORT}`;
export const DOH_ENDPOINT = `http://127.0.0.1:${DOH_PORT}/dns-query`;

/**
 * One Worker per way of setting MINDMAPS_MODE, beyond the main one (which leaves
 * it unset). They sit on the ports after the mock services and run the same
 * wrangler.test.toml (sign-up open) with the var passed through E2E_VARS.
 * `E2E_MODE_PORT` moves the first of them.
 */
const MODE_PORT_BASE = port("E2E_MODE_PORT", MAIN_PORT + 6);

export const MODE_CASES = ["personal", "org", "multitenant", "empty", "invalid"] as const;
export type ModeCase = (typeof MODE_CASES)[number];

const modeValue: Record<ModeCase, string> = {
  personal: "personal",
  org: "org",
  multitenant: "multitenant",
  empty: "",
  invalid: "personnal",
};

export const modeWorkers = Object.fromEntries(
  MODE_CASES.map((name, i) => [
    name,
    {
      name,
      port: MODE_PORT_BASE + i,
      baseURL: `http://127.0.0.1:${MODE_PORT_BASE + i}`,
      /** the MINDMAPS_MODE the Worker is started with */
      value: modeValue[name],
    },
  ]),
) as Record<ModeCase, { name: ModeCase; port: number; baseURL: string; value: string }>;

/**
 * One more Worker, started and stopped by e2e/modes/switch.spec.ts rather than
 * by Playwright: the same database run under one MINDMAPS_MODE after another.
 * It sits right after the mode Workers above; `inspector` is what serve.mjs
 * derives (port + 1000).
 */
const SWITCH_PORT = MODE_PORT_BASE + MODE_CASES.length;
export const switchWorker = {
  port: SWITCH_PORT,
  baseURL: `http://127.0.0.1:${SWITCH_PORT}`,
  stateDir: ".e2e-state-mode-switch",
};

/**
 * The email Worker (wrangler.test-mail.toml): outbound mail on, captured rather
 * than sent, and Google sign-in pointed at a fake Google on the next port. They
 * sit after the mode Workers, one port clear of them (the slot right after the mode
 * Workers is the one the mode switch Worker takes); `E2E_MAIL_PORT` and `E2E_FAKE_GOOGLE_PORT` move them.
 */
export const MAIL_PORT = port("E2E_MAIL_PORT", MODE_PORT_BASE + MODE_CASES.length + 1);
export const FAKE_GOOGLE_PORT = port("E2E_FAKE_GOOGLE_PORT", MAIL_PORT + 1);

export const mailWorker = {
  port: MAIL_PORT,
  baseURL: `http://127.0.0.1:${MAIL_PORT}`,
  vars: {
    GOOGLE_TOKEN_URL: `http://127.0.0.1:${FAKE_GOOGLE_PORT}/token`,
    GOOGLE_TOKENINFO_URL: `http://127.0.0.1:${FAKE_GOOGLE_PORT}/tokeninfo`,
  },
};

/**
 * The Turnstile Worker (wrangler.test-turnstile.toml): outbound mail captured and
 * the sign-up check on, with a local stand-in for Siteverify beside it. After the
 * email Worker and the fake Google; `E2E_TURNSTILE_PORT` and
 * `E2E_FAKE_TURNSTILE_PORT` move them.
 */
export const TURNSTILE_PORT = port("E2E_TURNSTILE_PORT", FAKE_GOOGLE_PORT + 1);
export const FAKE_TURNSTILE_PORT = port("E2E_FAKE_TURNSTILE_PORT", TURNSTILE_PORT + 1);

export const turnstileWorker = {
  port: TURNSTILE_PORT,
  baseURL: `http://127.0.0.1:${TURNSTILE_PORT}`,
  /** the stand-in for Siteverify */
  verifyURL: `http://127.0.0.1:${FAKE_TURNSTILE_PORT}`,
  siteKey: "e2e-turnstile-site",
  vars: { TURNSTILE_VERIFY_URL: `http://127.0.0.1:${FAKE_TURNSTILE_PORT}/siteverify` },
};
