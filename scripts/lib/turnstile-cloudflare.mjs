// Making a Turnstile widget through the Cloudflare REST API, as far as the token
// allows. `fetchImpl` is injected so the steps can be tested against a fake
// Cloudflare. It never throws, and the secret it gets back is returned to the
// caller (to hand to `wrangler secret put`) and appears in no message.
//
//   1. look for a widget this installer made before for the host (by name)
//   2. if there is one, rotate its secret to get a usable one (secrets cannot be read back)
//   3. otherwise make one for the host
//
// Result: { status, steps, detail, siteKey?, secret? } where status is
//   "created"    a new widget; siteKey and secret are set
//   "reused"     the earlier widget, with a fresh secret; siteKey and secret are set
//   "unchecked"  could not talk to the API (no token, no account, or it lacks a permission)
//   "failed"     the API answered and refused
// docs/SIGNUP.md describes what the operator does for each.

import { widgetName } from "./turnstile-config.mjs";

const API = "https://api.cloudflare.com/client/v4";

export async function setupTurnstileWidget({ accountId, host, token, fetchImpl = fetch }) {
  const steps = [];
  if (!token) return { status: "unchecked", steps, detail: "no Cloudflare API token available" };
  if (!accountId) return { status: "unchecked", steps, detail: "could not tell which Cloudflare account to use" };

  const call = async (method, path, body) => {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    return { ok: res.ok && json?.success !== false, status: res.status, json };
  };
  const denied = (r) => r.status === 401 || r.status === 403;
  // Error messages only, never the body: it may hold the secret.
  const why = (r) => r.json?.errors?.map((e) => e.message).join("; ") || `HTTP ${r.status}`;
  const base = `/accounts/${encodeURIComponent(accountId)}/challenges/widgets`;
  const name = widgetName(host);

  try {
    let found = null;
    for (let page = 1; page <= 10 && !found; page++) {
      const r = await call("GET", `${base}?per_page=50&page=${page}`);
      if (denied(r)) return { status: "unchecked", steps, detail: `the token cannot manage Turnstile (${why(r)})` };
      if (!r.ok) return { status: "failed", steps, detail: `listing Turnstile widgets: ${why(r)}` };
      const list = Array.isArray(r.json?.result) ? r.json.result : [];
      found = list.find((w) => w?.name === name && w?.sitekey) ?? null;
      if (list.length < 50) break;
    }

    if (found) {
      const r = await call("POST", `${base}/${encodeURIComponent(found.sitekey)}/rotate_secret`, { invalidate_immediately: false });
      if (denied(r)) return { status: "unchecked", steps, detail: `the token cannot manage Turnstile (${why(r)})` };
      const secret = r.json?.result?.secret;
      if (!r.ok || !secret) return { status: "failed", steps, detail: `getting a secret for the existing widget: ${why(r)}` };
      steps.push("found the widget made earlier and issued it a new secret");
      return { status: "reused", steps, detail: "", siteKey: found.sitekey, secret };
    }

    const r = await call("POST", base, { name, domains: [host], mode: "managed", bot_fight_mode: false, region: "world" });
    if (denied(r)) return { status: "unchecked", steps, detail: `the token cannot create Turnstile widgets (${why(r)})` };
    const siteKey = r.json?.result?.sitekey;
    const secret = r.json?.result?.secret;
    if (!r.ok || !siteKey || !secret) return { status: "failed", steps, detail: `creating the widget: ${why(r)}` };
    steps.push(`created a Turnstile widget for ${host}`);
    return { status: "created", steps, detail: "", siteKey, secret };
  } catch (err) {
    return { status: "failed", steps, detail: `unexpected: ${String(err?.message ?? err).replace(token, "***")}` };
  }
}
