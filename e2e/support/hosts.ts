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
