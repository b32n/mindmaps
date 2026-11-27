// A stand-in for Google's token and tokeninfo endpoints, for the email specs
// (wrangler.test-mail.toml points the Worker at it). The "authorization code"
// is the identity claims themselves, base64url JSON, so a spec decides who
// Google says is signing in. Nothing here is reachable outside the test run.
import { createServer } from "node:http";

const port = Number(process.env.E2E_FAKE_GOOGLE_PORT ?? 8799);
const decode = (v) => JSON.parse(Buffer.from(v, "base64url").toString("utf8"));

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      const code = new URLSearchParams(raw).get("code");
      return send(200, { id_token: code });
    }
    if (url.pathname === "/tokeninfo") return send(200, decode(url.searchParams.get("id_token")));
    send(200, { ok: true });
  } catch {
    send(400, { error: "bad request" });
  }
}).listen(port, "127.0.0.1");
