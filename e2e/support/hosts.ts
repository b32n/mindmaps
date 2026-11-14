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
