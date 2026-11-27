/**
 * A window for the e2e suite onto where password hashing happens, so a spec can
 * show that a rate-limited request never reached it. Off unless HASH_PROBE is
 * "1", which only the test configs set: `noteHash` then does nothing and
 * `GET /api/_probe/hash` answers 404, as `/api/_mail` does without the capture
 * transport. Never set it on a real install.
 *
 * It records only who a hash was spent for (an email address a test made up),
 * in memory, capped.
 */

export interface ProbeEnv {
  HASH_PROBE?: string;
}

const seen: string[] = [];
const CAP = 5000;

export const probeOn = (env: ProbeEnv) => env.HASH_PROBE === "1";

/** Call just before a password hash is computed. */
export function noteHash(env: ProbeEnv, who: string) {
  if (!probeOn(env)) return;
  seen.push(who.toLowerCase());
  if (seen.length > CAP) seen.splice(0, seen.length - CAP);
}

export const hashCount = (who: string) => seen.filter((s) => s === who.toLowerCase()).length;
