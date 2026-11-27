/**
 * Encrypting a client secret at rest.
 *
 * An organisation's OIDC client secret is stored in D1, so anyone who can read
 * the database (a backup, a support export, a leaked query) could read it. It is
 * therefore stored encrypted with AES-256-GCM, and never returned by any route.
 *
 * The key comes from `SSO_SECRET_KEY` (a Worker secret, `wrangler secret put
 * SSO_SECRET_KEY`) when set. Otherwise one is generated on first use and kept in
 * `instance_secrets`, the way the mindbox's signing key is, so there is nothing
 * to configure. Be clear about what that second case is worth: the key then sits
 * in the same database as the ciphertext, so it protects a secret from being
 * read out of logs, column dumps and partial exports, but not from someone who
 * can read the whole database. Setting the Worker secret is what separates the
 * two. docs/SSO.md says so.
 *
 * The ciphertext is bound to the workspace it belongs to (as additional
 * authenticated data), so one organisation's value cannot be copied into
 * another's row and decrypted there.
 *
 * Format: `v1.<iv>.<ciphertext>`, both base64url.
 */

export interface SecretsEnv {
  DB: D1Database;
  SSO_SECRET_KEY?: string;
}

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => {
  let s = "";
  for (const x of new Uint8Array(b instanceof Uint8Array ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

let cached: string | undefined;

/** The key material: the Worker secret, else the instance's generated one. */
export async function ssoKeyMaterial(env: SecretsEnv): Promise<string> {
  if (env.SSO_SECRET_KEY) return env.SSO_SECRET_KEY;
  if (cached) return cached;
  const fresh = b64(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(`INSERT OR IGNORE INTO instance_secrets (name, value) VALUES ('sso', ?)`).bind(fresh).run();
  const row = await env.DB.prepare(`SELECT value FROM instance_secrets WHERE name = 'sso'`).first<{ value: string }>();
  return (cached = row!.value);
}

async function aesKey(material: string): Promise<CryptoKey> {
  // Any string is accepted as the secret; hashing it gives the 256 bits AES wants.
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`mindmaps-sso-secret-v1:${material}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(material: string, aad: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(material), enc.encode(plain));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

/** The plaintext, or null if the value is not ours, was tampered with, or is for another `aad`. */
export async function decryptSecret(material: string, aad: string, stored: string): Promise<string | null> {
  const [v, iv, ct] = stored.split(".");
  if (v !== "v1" || !iv || !ct) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(aad) },
      await aesKey(material),
      unb64(ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
