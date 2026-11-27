/**
 * Everything on /privacy and /terms that needs a decision from a person, and
 * the numbers the text quotes, in one place.
 *
 * ## Placeholders
 *
 * These are choices a lawyer or the project owner has to make: they are not
 * guessed, and until they are made the pages show them as a visible, highlighted
 * `[... to be decided]` marker rather than a plausible-sounding value. To settle
 * one, set its `value`; the marker disappears everywhere it is used. They matter
 * on the hosted service only (multitenant mode). On a self-hosted instance the
 * pages hand these choices to the operator instead (see Legal.tsx).
 *
 * ## Retention
 *
 * The windows below are the ones in the Worker. e2e/tests/legal/legal-unit.spec.ts
 * checks them against it, so the text cannot quietly drift from the code.
 */

export interface PlaceholderSpec {
  /** shown in the marker */
  label: string;
  /** the decided text; null until someone decides */
  value: string | null;
}

export const PLACEHOLDERS = {
  effectiveDate: { label: "Effective date", value: null },
  legalEntity: { label: "Legal entity that operates the hosted service", value: null },
  privacyContact: { label: "Contact for privacy and data requests", value: null },
  governingLaw: { label: "Governing law", value: null },
  jurisdiction: { label: "Courts with jurisdiction", value: null },
  liabilityCap: { label: "Limit of liability", value: null },
  minimumAge: { label: "Minimum age", value: null },
  backupWindow: { label: "How long Cloudflare backups of deleted data can persist", value: null },
} as const satisfies Record<string, PlaceholderSpec>;

export type PlaceholderKey = keyof typeof PLACEHOLDERS;

/** Kebab-case id used in `data-placeholder`, so tests and reviewers can find each marker. */
export const placeholderId = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Placeholders still waiting for a decision. */
export const undecided = (): PlaceholderKey[] =>
  (Object.keys(PLACEHOLDERS) as PlaceholderKey[]).filter((k) => PLACEHOLDERS[k].value === null);

export const REPO_URL = "https://github.com/b32n/mindmaps";
export const SECURITY_URL = `${REPO_URL}/blob/main/SECURITY.md`;
export const HOSTED_URL = "https://mindmaps.b32n.io";

export const RETENTION = {
  /** deleted cards, mindmaps and files stay restorable this long (worker/src/r2trash.ts) */
  trashDays: 7,
  /** a browser sign-in (worker/src/auth.ts) */
  sessionDays: 30,
  /** an MCP access token, and the refresh token that renews it (worker/src/oauth.ts) */
  accessTokenDays: 30,
  refreshTokenDays: 180,
} as const;
