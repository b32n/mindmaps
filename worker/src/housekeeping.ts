/**
 * Keeping the two technical tables from 0030 from growing for ever. Run from the
 * cron handler in index.ts; docs/SIGNUP.md has the policy in operator terms.
 *
 *   rate_limits   a fixed-window counter keyed by a hash. Once its window has
 *                 passed it is marked status 'expired' (with expired_at), and a
 *                 later hit revives it. A row that has been expired for
 *                 RATE_RETENTION_MS is deleted. THAT IS THE ONE HARD DELETE HERE:
 *                 the row holds a hash of "<limit>:<address or client address>"
 *                 and a count, no account data, and nothing else refers to it;
 *                 the hash of an address is also personal data, so keeping it
 *                 for ever is the worse choice. Flagged for review in the PR.
 *   email_tokens  marked status 'expired' once past expires_at. Never deleted:
 *                 the row names an address and is the audit trail of the links
 *                 sent to it.
 *
 * Bounded per run (BATCH rows per statement): a backlog is cleared over several
 * runs instead of in one long write.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long an expired rate-limit row is kept before it is removed. */
export const RATE_RETENTION_MS = 7 * DAY;
/** The longest window in emailauth.ts's LIMITS, assumed for rows that do not record theirs. */
const DEFAULT_WINDOW_MS = HOUR;
/** The shortest, so the sweep can use the index to skip rows that cannot be over yet. */
const SHORTEST_WINDOW_MS = 15 * MIN;
const BATCH = 500;
/** The cron runs every minute; this work is due every ten. */
export const HOUSEKEEPING_EVERY_MIN = 10;

export const housekeepingDue = (scheduledTime: number) =>
  new Date(scheduledTime).getUTCMinutes() % HOUSEKEEPING_EVERY_MIN === 0;

export interface Swept {
  rateExpired: number;
  rateRemoved: number;
  tokensExpired: number;
}

export async function sweepTechnical(db: D1Database, at = Date.now()): Promise<Swept> {
  const changes = (r: D1Result) => r.meta?.changes ?? 0;

  const rateExpired = changes(
    await db
      .prepare(
        `UPDATE rate_limits SET status = 'expired', expired_at = ?1, updated_at = ?1
          WHERE key IN (SELECT key FROM rate_limits
                         WHERE status = 'active' AND window_start <= ?2
                           AND window_start + COALESCE(window_ms, ?3) <= ?1
                         LIMIT ?4)`,
      )
      .bind(at, at - SHORTEST_WINDOW_MS, DEFAULT_WINDOW_MS, BATCH)
      .run(),
  );

  const rateRemoved = changes(
    await db
      .prepare(
        `DELETE FROM rate_limits
          WHERE key IN (SELECT key FROM rate_limits
                         WHERE status = 'expired' AND expired_at <= ?1
                         LIMIT ?2)`,
      )
      .bind(at - RATE_RETENTION_MS, BATCH)
      .run(),
  );

  const tokensExpired = changes(
    await db
      .prepare(
        `UPDATE email_tokens SET status = 'expired', updated_at = ?1
          WHERE id IN (SELECT id FROM email_tokens WHERE status = 'active' AND expires_at <= ?1 LIMIT ?2)`,
      )
      .bind(at, BATCH)
      .run(),
  );

  return { rateExpired, rateRemoved, tokensExpired };
}
