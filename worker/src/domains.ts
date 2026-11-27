/**
 * Verified domains: an organisation proves it controls a domain, and only then
 * may a policy or an SSO sign-in rest on it.
 *
 * The proof is a DNS TXT record. Adding a domain issues a random token; the
 * organisation publishes `_mindmaps-verify.<domain>  TXT  mindmaps-verify=<token>`
 * and presses Verify, which asks a resolver over DNS-over-HTTPS (Cloudflare's JSON
 * API, `DOH_ENDPOINT` to point it elsewhere, which is how the specs run) and
 * looks for exactly that value.
 *
 * Many organisations may *claim* a domain; one may *hold* it. The database says
 * so (a partial unique index on verified rows), so two verifying at the same
 * instant cannot both win. A domain is never deleted: removing it sets a status.
 *
 * A failed lookup (the resolver down, SERVFAIL) is not an answer about the
 * domain and is reported as one: 502, nothing changes. "No such record" is the
 * answer, and is a 422.
 */

import type { Refusal } from "./organisation";

export interface DomainEnv {
  DB: D1Database;
  /** Where DNS-over-HTTPS questions go. Default: Cloudflare's. http is accepted for loopback only. */
  DOH_ENDPOINT?: string;
}

export const DEFAULT_DOH = "https://cloudflare-dns.com/dns-query";
export const RECORD_PREFIX = "_mindmaps-verify.";
export const VALUE_PREFIX = "mindmaps-verify=";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A domain as stored: lowercase, no trailing dot, at least two labels, each a
 * plain hostname label. Anything else (a URL, an address, an IP, a path, an
 * underscore) is null. Internationalised names are accepted only in their
 * punycode form (`xn--...`), which is what DNS holds.
 */
export function normaliseDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253) return null;
  const labels = d.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL.test(l))) return null;
  // the last label must not be all digits: that is an IPv4 address, not a name
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null;
  return d;
}

export const recordFor = (domain: string, token: string) => ({
  type: "TXT" as const,
  name: `${RECORD_PREFIX}${domain}`,
  value: `${VALUE_PREFIX}${token}`,
});

export function newToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class DnsError extends Error {}

const isLoopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";

/** A DoH answer's TXT `data`: one or more quoted strings, joined, as a resolver presents a long record. */
export function txtText(data: string): string {
  if (!data.startsWith('"')) return data;
  let out = "";
  for (const m of data.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out += m[1]!.replace(/\\(.)/g, "$1");
  return out;
}

/** The TXT values published at `name`. Throws `DnsError` when the lookup itself fails. */
export async function lookupTxt(env: DomainEnv, name: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const base = new URL(env.DOH_ENDPOINT || DEFAULT_DOH);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopback(base.hostname))) throw new DnsError("resolver address is not https");
  base.searchParams.set("name", name);
  base.searchParams.set("type", "TXT");
  let body: { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
  try {
    const res = await fetcher(base.toString(), { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new DnsError(`resolver answered ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw err instanceof DnsError ? err : new DnsError(String((err as Error)?.message ?? err));
  }
  // 0 = NOERROR, 3 = NXDOMAIN: both are answers. Anything else is a failed lookup.
  if (body.Status === 3) return [];
  if (body.Status !== 0) throw new DnsError(`resolver status ${body.Status}`);
  return (body.Answer ?? []).filter((a) => a.type === 16 && typeof a.data === "string").map((a) => txtText(a.data!));
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

export interface DomainRow {
  id: string;
  domain: string;
  status: "pending" | "verified";
  /** What to publish. Null once verified: it has done its job. */
  record: ReturnType<typeof recordFor> | null;
  verified_at: number | null;
  created_at: number;
}

interface Stored {
  id: string;
  workspace_id: string;
  domain: string;
  token: string;
  status: "pending" | "verified" | "removed";
  verified_at: number | null;
  created_at: number;
}

const present = (r: Stored): DomainRow => ({
  id: r.id,
  domain: r.domain,
  status: r.status === "verified" ? "verified" : "pending",
  record: r.status === "verified" ? null : recordFor(r.domain, r.token),
  verified_at: r.verified_at,
  created_at: r.created_at,
});

const refuse = (status: Refusal["status"] | 422 | 502, code: string, error: string) => ({ ok: false as const, status, code, error });
export type Failure = ReturnType<typeof refuse>;

export async function domainsOf(db: D1Database, workspaceId: string): Promise<DomainRow[]> {
  const rows = await db
    .prepare(`SELECT * FROM org_domains WHERE workspace_id = ? AND status <> 'removed' ORDER BY created_at, rowid`)
    .bind(workspaceId)
    .all<Stored>();
  return (rows.results ?? []).map(present);
}

/** The domains this organisation holds, verified. */
export async function verifiedDomains(db: D1Database, workspaceId: string): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT domain FROM org_domains WHERE workspace_id = ? AND status = 'verified'`)
    .bind(workspaceId)
    .all<{ domain: string }>();
  return (rows.results ?? []).map((r) => r.domain);
}

export const isUniqueViolation = (err: unknown) => /UNIQUE constraint/i.test(String((err as Error)?.message ?? err));

export async function addDomain(
  db: D1Database,
  workspaceId: string,
  actorId: string,
  raw: unknown,
): Promise<{ ok: true; domain: DomainRow } | Failure> {
  const domain = normaliseDomain(raw);
  if (!domain) return refuse(400, "invalid_domain", "That does not look like a domain name. Use something like example.com.");

  const held = await db.prepare(`SELECT workspace_id FROM org_domains WHERE domain = ? AND status = 'verified'`).bind(domain).first<{ workspace_id: string }>();
  if (held) {
    return held.workspace_id === workspaceId
      ? refuse(409, "domain_exists", "This organisation already has that domain.")
      : refuse(409, "domain_taken", "Another organisation has already verified that domain.");
  }
  const mine = await db
    .prepare(`SELECT 1 AS x FROM org_domains WHERE workspace_id = ? AND domain = ? AND status <> 'removed'`)
    .bind(workspaceId, domain)
    .first();
  if (mine) return refuse(409, "domain_exists", "This organisation already has that domain.");

  const at = Date.now();
  const row: Stored = { id: crypto.randomUUID(), workspace_id: workspaceId, domain, token: newToken(), status: "pending", verified_at: null, created_at: at };
  try {
    await db
      .prepare(
        `INSERT INTO org_domains (id, workspace_id, domain, token, status, created_by, created_at, updated_at)
         VALUES (?1,?2,?3,?4,'pending',?5,?6,?6)`,
      )
      .bind(row.id, workspaceId, domain, row.token, actorId, at)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) return refuse(409, "domain_exists", "This organisation already has that domain.");
    throw err;
  }
  return { ok: true, domain: present(row) };
}

async function load(db: D1Database, workspaceId: string, id: string) {
  return db
    .prepare(`SELECT * FROM org_domains WHERE id = ? AND workspace_id = ? AND status <> 'removed'`)
    .bind(id, workspaceId)
    .first<Stored>();
}

export async function verifyDomain(
  env: DomainEnv,
  workspaceId: string,
  id: string,
  fetcher?: typeof fetch,
): Promise<{ ok: true; domain: DomainRow } | Failure> {
  const row = await load(env.DB, workspaceId, id);
  if (!row) return refuse(404, "not_found", "not found");
  if (row.status === "verified") return { ok: true, domain: present(row) };

  const taken = refuse(409, "domain_taken", "Another organisation has already verified that domain.");
  const other = await env.DB
    .prepare(`SELECT 1 AS x FROM org_domains WHERE domain = ? AND status = 'verified'`)
    .bind(row.domain)
    .first();
  if (other) return taken;

  const want = recordFor(row.domain, row.token);
  let values: string[];
  try {
    values = await lookupTxt(env, want.name, fetcher);
  } catch (err) {
    console.error("domain lookup failed", row.domain, (err as Error).message);
    return refuse(502, "dns_lookup_failed", "Could not look up the DNS record just now. Nothing was changed; try again in a moment.");
  }
  if (!values.includes(want.value))
    return refuse(
      422,
      "dns_record_not_found",
      `No TXT record named ${want.name} with the value ${want.value} was found. DNS can take a few minutes to update; publish it, then verify again.`,
    );

  const at = Date.now();
  try {
    const res = await env.DB
      .prepare(`UPDATE org_domains SET status = 'verified', verified_at = ?2, updated_at = ?2 WHERE id = ?1 AND status = 'pending'`)
      .bind(row.id, at)
      .run();
    if ((res.meta?.changes ?? 0) < 1) {
      const now = await load(env.DB, workspaceId, id);
      return now?.status === "verified" ? { ok: true, domain: present(now) } : refuse(404, "not_found", "not found");
    }
  } catch (err) {
    // The unique index decided: someone verified it between our check and our write.
    if (isUniqueViolation(err)) return taken;
    throw err;
  }
  return { ok: true, domain: present({ ...row, status: "verified", verified_at: at }) };
}

export async function removeDomain(db: D1Database, workspaceId: string, id: string): Promise<boolean> {
  const at = Date.now();
  const res = await db
    .prepare(`UPDATE org_domains SET status = 'removed', removed_at = ?3, updated_at = ?3 WHERE id = ?1 AND workspace_id = ?2 AND status <> 'removed'`)
    .bind(id, workspaceId, at)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** The organisation holding this domain verified, if any. */
export async function holderOf(db: D1Database, domain: string): Promise<string | null> {
  const row = await db.prepare(`SELECT workspace_id FROM org_domains WHERE domain = ? AND status = 'verified'`).bind(domain).first<{ workspace_id: string }>();
  return row?.workspace_id ?? null;
}
