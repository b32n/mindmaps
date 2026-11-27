// A stand-in for Cloudflare's Turnstile Siteverify, for the turnstile specs
// (wrangler.test-turnstile.toml points TURNSTILE_VERIFY_URL at it). Nothing here
// is reachable outside the test run, and the real endpoint is never called.
//
// POST /siteverify takes the JSON (or form) the Worker sends and answers as
// Cloudflare does:
//   - the secret must be the one the test Worker is configured with
//   - a token starting "pass" succeeds, ONCE: a second use is `timeout-or-duplicate`
//   - a token starting "outage" makes the endpoint answer 500
//   - anything else fails with `invalid-input-response`
// GET /calls?response=<token> returns what was sent for that token, so a spec can
// check the remote address and the idempotency key. GET /reset forgets everything.
import { createServer } from "node:http";

const port = Number(process.env.E2E_FAKE_TURNSTILE_PORT ?? 8800);
const SECRET = "e2e-turnstile-secret";
const calls = [];
const spent = new Set();

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/siteverify" && req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      const type = req.headers["content-type"] ?? "";
      const f = type.includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ response: f.response, remoteip: f.remoteip ?? null, idempotency_key: f.idempotency_key ?? null, secretOk: f.secret === SECRET });
      if (f.secret !== SECRET) return send(200, { success: false, "error-codes": ["invalid-input-secret"] });
      if (String(f.response).startsWith("outage")) return send(500, { error: "down" });
      if (String(f.response).startsWith("pass")) {
        if (spent.has(f.response)) return send(200, { success: false, "error-codes": ["timeout-or-duplicate"] });
        spent.add(f.response);
        return send(200, { success: true, challenge_ts: new Date().toISOString(), hostname: "localhost", "error-codes": [], action: "", cdata: "" });
      }
      return send(200, { success: false, "error-codes": ["invalid-input-response"] });
    }
    if (url.pathname === "/calls") return send(200, calls.filter((c) => c.response === url.searchParams.get("response")));
    if (url.pathname === "/reset") {
      calls.length = 0;
      spent.clear();
    }
    send(200, { ok: true });
  } catch {
    send(400, { error: "bad request" });
  }
}).listen(port, "127.0.0.1");
