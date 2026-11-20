/**
 * The deployment mode: what kind of instance this Worker is.
 *
 *   personal      one person (or a few people they choose) on their own install
 *   org           a team or company's own install
 *   multitenant   the hosted service, many unrelated customers on one instance
 *
 * Set by the `MINDMAPS_MODE` var. Unset or empty means `multitenant`, which is
 * exactly how every install behaved before the setting existed, so nothing that
 * is already deployed changes. See docs/MODES.md.
 *
 * Anything else is a configuration mistake, and is refused rather than guessed
 * at: a typo such as `personnal` must not quietly leave an install running as
 * the most permissive mode. `readMode` throws `InvalidModeError`; the Worker
 * answers every request with a 500 that says so (see `modeFailure`).
 */

export const MODES = ["personal", "org", "multitenant"] as const;
export type Mode = (typeof MODES)[number];

/** What an install with no `MINDMAPS_MODE` is. */
export const DEFAULT_MODE: Mode = "multitenant";

export interface ModeEnv {
  MINDMAPS_MODE?: string;
}

export class InvalidModeError extends Error {
  constructor(readonly value: string) {
    super(
      `MINDMAPS_MODE is "${value}", which is not a mode. Use one of: ${MODES.join(", ")} ` +
        `(or leave it unset for ${DEFAULT_MODE}). See docs/MODES.md.`,
    );
    this.name = "InvalidModeError";
  }
}

export const isMode = (v: unknown): v is Mode => (MODES as readonly unknown[]).includes(v);

/** The mode this instance runs in. Unset or blank is `multitenant`; anything else unknown throws. */
export function readMode(env: ModeEnv): Mode {
  const raw = env.MINDMAPS_MODE;
  if (raw === undefined || raw === null) return DEFAULT_MODE;
  const v = String(raw).trim();
  if (v === "") return DEFAULT_MODE;
  if (!isMode(v)) throw new InvalidModeError(v);
  return v;
}

/**
 * Why `MINDMAPS_MODE` is unusable, or null when it is fine.
 *
 * The Worker answers every request with a 500 carrying this message while it is
 * set. Failing closed is the safe choice: the API, the MCP endpoint and the
 * OAuth endpoints all stop, the response names the variable and the allowed
 * values, and the fix is one edit and a deploy. Static files are served by the
 * assets layer without reaching the Worker, so the page still loads and its
 * sign-in form shows this message.
 */
export function modeProblem(env: ModeEnv): string | null {
  try {
    readMode(env);
    return null;
  } catch (err) {
    if (err instanceof InvalidModeError) return err.message;
    throw err;
  }
}
