/**
 * What the Worker says about who runs it and how to report a problem.
 *
 *   - `/.well-known/security.txt` (RFC 9116)
 *   - `/api/legal`, the public facts the /privacy and /terms pages need that the
 *     browser cannot know for itself: the mode, and who the operator is.
 *
 * Everything an operator can set is optional and shown as given. Nothing here
 * invents a value: an unset operator name or contact stays null, and the pages
 * fall back to neutral wording.
 */

import { readMode, type Mode, type ModeEnv } from "./mode";

export interface LegalEnv extends ModeEnv {
  /** Where vulnerability reports go. A URI (`https:` or `mailto:`), or a bare email address. */
  SECURITY_CONTACT?: string;
  /** Who runs this instance, as shown on /privacy and /terms. */
  OPERATOR_NAME?: string;
  /** How to reach them: an email address or an `https:` URL. */
  OPERATOR_CONTACT?: string;
}

/** Where the project takes private vulnerability reports. */
export const DEFAULT_SECURITY_CONTACT = "https://github.com/b32n/mindmaps/security/advisories/new";
export const SECURITY_POLICY_URL = "https://github.com/b32n/mindmaps/blob/main/SECURITY.md";

/**
 * How far out `Expires` is set. RFC 9116 wants it under a year and warns that a
 * stale one makes the file untrustworthy, so it is computed on every request and
 * can never lapse.
 */
export const SECURITY_TXT_VALID_DAYS = 360;

const MAX_FIELD = 200;
const EMAIL = /^[^@\s:/<>]+@[^@\s:/<>]+\.[^@\s:/<>]+$/;

/** One line, trimmed, bounded; null when nothing is left. Stops a var from injecting extra security.txt fields. */
const oneLine = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  return s && s.length <= MAX_FIELD ? s : null;
};

/**
 * A contact as a security.txt URI, or null if it is not usable. A bare email
 * becomes `mailto:`; `https:`, `mailto:` and `tel:` pass; anything else (a bare
 * word, `javascript:`, `http:`) is refused rather than published.
 */
export function securityContactUri(raw: unknown): string | null {
  const s = oneLine(raw);
  if (!s || /\s/.test(s)) return null;
  if (EMAIL.test(s)) return `mailto:${s}`;
  if (/^mailto:/i.test(s)) return EMAIL.test(s.slice(7).split("?")[0]) ? s : null;
  if (/^tel:\+?[0-9-]+$/i.test(s)) return s;
  if (/^https:\/\/[^/]+/i.test(s)) {
    try {
      new URL(s);
      return s;
    } catch {
      return null;
    }
  }
  return null;
}

/** The effective Contact for this instance: the override if it is usable, else the project's advisory form. */
export const securityContactOf = (env: LegalEnv): string =>
  securityContactUri(env.SECURITY_CONTACT) ?? DEFAULT_SECURITY_CONTACT;

/** The security.txt body. `at` is injectable so tests can pin the clock. */
export function securityTxt(origin: string, env: LegalEnv, at: Date = new Date()): string {
  const expires = new Date(at.getTime() + SECURITY_TXT_VALID_DAYS * 86_400_000);
  return (
    [
      `Contact: ${securityContactOf(env)}`,
      `Expires: ${expires.toISOString()}`,
      "Preferred-Languages: en",
      `Policy: ${SECURITY_POLICY_URL}`,
      `Canonical: ${origin}/.well-known/security.txt`,
    ].join("\n") + "\n"
  );
}

export function securityTxtResponse(req: Request, env: LegalEnv): Response {
  const origin = new URL(req.url).origin;
  return new Response(req.method === "HEAD" ? null : securityTxt(origin, env), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Short, so a changed override or an approaching Expires is not held for long.
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}

export interface Operator {
  name: string | null;
  /** an email address or https URL, as the operator wrote it */
  contact: string | null;
}

export const operatorOf = (env: LegalEnv): Operator => {
  const contact = oneLine(env.OPERATOR_CONTACT);
  return {
    name: oneLine(env.OPERATOR_NAME),
    contact: contact && (EMAIL.test(contact) || /^https:\/\/[^\s]+$/i.test(contact)) ? contact : null,
  };
};

export interface LegalInfo {
  mode: Mode;
  operator: Operator;
}

export const legalInfo = (env: LegalEnv): LegalInfo => ({ mode: readMode(env), operator: operatorOf(env) });
