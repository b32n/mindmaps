/**
 * Cloudflare Turnstile on the unauthenticated write paths (sign-up, forgot
 * password, resend verification). docs/SIGNUP.md is the operator-facing account.
 *
 * Optional, and on only when BOTH are set:
 *
 *   TURNSTILE_SITE_KEY     public; the web app renders the widget with it
 *   TURNSTILE_SECRET_KEY   a Worker secret (`wrangler secret put`); never sent anywhere but Siteverify
 *
 * With either missing every check passes and nothing about the endpoints changes.
 * The client's word is never taken: the token it sends is verified server-side
 * with Siteverify, along with the client's address, and a request without one is
 * refused. If Siteverify cannot be reached the request is refused too (503): an
 * outage of the check must not turn into an open door.
 */

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileEnv {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Siteverify's address; only the e2e suite points this elsewhere (a local stub) */
  TURNSTILE_VERIFY_URL?: string;
}

export const turnstileEnabled = (env: TurnstileEnv) =>
  !!(env.TURNSTILE_SITE_KEY ?? "").trim() && !!(env.TURNSTILE_SECRET_KEY ?? "").trim();

/** What the web app is told: the site key when the check is on, else null. Never the secret. */
export const turnstileSiteKey = (env: TurnstileEnv) => (turnstileEnabled(env) ? env.TURNSTILE_SITE_KEY!.trim() : null);

export type TurnstileResult =
  | { ok: true }
  | { ok: false; status: 400 | 503; code: string; error: string };

const refuse = (status: 400 | 503, code: string, error: string): TurnstileResult => ({ ok: false, status, code, error });

/** Cloudflare's tokens are at most 2048 characters. */
const MAX_TOKEN = 2048;

/** Siteverify is retried once, with the same idempotency key, when it cannot be reached. */
export async function verifyTurnstile(
  env: TurnstileEnv,
  token: unknown,
  ip: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  if (!turnstileEnabled(env)) return { ok: true };
  if (typeof token !== "string" || !token.trim() || token.length > MAX_TOKEN)
    return refuse(400, "turnstile_required", "Complete the security check and try again.");

  const idempotencyKey = crypto.randomUUID();
  const body = JSON.stringify({
    secret: env.TURNSTILE_SECRET_KEY!.trim(),
    response: token,
    ...(ip ? { remoteip: ip } : {}),
    idempotency_key: idempotencyKey,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(env.TURNSTILE_VERIFY_URL || SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.status >= 500) continue;
      const out = (await res.json().catch(() => null)) as { success?: boolean; "error-codes"?: string[] } | null;
      if (out?.success === true) return { ok: true };
      if (out && out.success === false) {
        // Log why (timeout-or-duplicate, invalid-input-response...), never the token or the secret.
        console.warn("turnstile refused", (out["error-codes"] ?? []).join(","));
        return refuse(400, "turnstile_failed", "The security check failed or expired. Try again.");
      }
    } catch (err) {
      console.error("turnstile verify failed", (err as Error)?.name ?? "error");
    }
  }
  return refuse(503, "turnstile_unavailable", "Couldn't reach the security check. Try again in a moment.");
}
