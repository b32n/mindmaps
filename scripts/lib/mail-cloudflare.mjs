// Onboarding a sending domain to Cloudflare Email Sending through the REST API,
// as far as the platform allows. `fetchImpl` is injected so the steps can be
// tested against a fake Cloudflare. It never throws and never returns the token.
//
//   1. find the zone that holds the domain (Zone: Read)
//   2. enable Email Sending on it as a sending subdomain (Email Sending: Edit)
//   3. make sure the DNS records Cloudflare lists for it exist (DNS: Edit)
//
// Result: { status, steps, detail } where status is
//   "ready"      Email Sending is enabled and every listed record exists
//   "unchecked"  could not talk to the API (no token, or it lacks a permission);
//                the dashboard route is the way
//   "failed"     the API answered and refused or something is missing
// docs/EMAIL.md describes what the operator does for each.

const API = "https://api.cloudflare.com/client/v4";

export async function setupSendingDomain({ domain, token, fetchImpl = fetch }) {
  const steps = [];
  if (!token) return { status: "unchecked", steps, detail: "no Cloudflare API token available" };

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
  const why = (r) => r.json?.errors?.map((e) => e.message).join("; ") || `HTTP ${r.status}`;

  try {
    // 1. the zone: the domain itself, then each parent in turn
    let zone = null;
    const labels = domain.split(".");
    for (let i = 0; i < labels.length - 1 && !zone; i++) {
      const candidate = labels.slice(i).join(".");
      const r = await call("GET", `/zones?name=${encodeURIComponent(candidate)}`);
      if (denied(r)) return { status: "unchecked", steps, detail: `the token cannot read zones (${why(r)})` };
      if (!r.ok) return { status: "failed", steps, detail: `looking up ${candidate}: ${why(r)}` };
      zone = r.json?.result?.[0]?.id ?? null;
    }
    if (!zone) return { status: "failed", steps, detail: `${domain} is not on this Cloudflare account (add the domain to Cloudflare first)` };
    steps.push("found the zone");

    // 2. the sending subdomain
    const list = await call("GET", `/zones/${zone}/email/sending/subdomains`);
    if (denied(list)) return { status: "unchecked", steps, detail: `the token cannot manage Email Sending (${why(list)})` };
    if (!list.ok) return { status: "failed", steps, detail: `listing sending domains: ${why(list)}` };
    let sub = (list.json?.result ?? []).find((s) => s.name === domain);
    if (sub) steps.push("email sending already on for this domain");
    else {
      const made = await call("POST", `/zones/${zone}/email/sending/subdomains`, { name: domain });
      if (denied(made)) return { status: "unchecked", steps, detail: `the token cannot enable Email Sending (${why(made)})` };
      if (!made.ok) return { status: "failed", steps, detail: `enabling Email Sending: ${why(made)}` };
      sub = made.json?.result;
      steps.push("enabled email sending");
    }
    if (sub?.enabled === false) {
      const on = await call("PATCH", `/zones/${zone}/email/sending/subdomains/${sub.tag}`, { enabled: true });
      if (!on.ok) return { status: "failed", steps, detail: `switching Email Sending on: ${why(on)}` };
    }

    // 3. DNS: add what is listed and missing; leave what is there
    const dns = await call("GET", `/zones/${zone}/email/sending/subdomains/${sub?.tag ?? ""}/dns`);
    const wanted = Array.isArray(dns.json?.result) ? dns.json.result : dns.json?.result?.records;
    if (!dns.ok || !Array.isArray(wanted))
      return { status: "unchecked", steps, detail: "could not read the DNS records Email Sending needs; check them in the dashboard" };
    let added = 0;
    for (const rec of wanted) {
      if (!rec?.type || !rec?.name || rec.content == null) continue;
      const have = await call("GET", `/zones/${zone}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`);
      if (denied(have)) return { status: "unchecked", steps, detail: `the token cannot edit DNS (${why(have)})` };
      const norm = (v) => String(v).replace(/^"|"$/g, "").trim().toLowerCase();
      if ((have.json?.result ?? []).some((x) => norm(x.content) === norm(rec.content))) continue;
      const put = await call("POST", `/zones/${zone}/dns_records`, {
        type: rec.type, name: rec.name, content: rec.content, ttl: rec.ttl ?? 1,
        ...(rec.priority != null ? { priority: rec.priority } : {}),
      });
      if (!put.ok) return { status: "failed", steps, detail: `adding ${rec.type} ${rec.name}: ${why(put)}` };
      added++;
    }
    steps.push(added ? `added ${added} DNS record${added === 1 ? "" : "s"}` : "DNS records already in place");
    return { status: "ready", steps, detail: "" };
  } catch (err) {
    return { status: "failed", steps, detail: `unexpected: ${String(err?.message ?? err).replace(token, "***")}` };
  }
}
