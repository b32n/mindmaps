// Entry point for wrangler.test-google.toml: the real Worker, with Google's
// token and tokeninfo endpoints answered locally. The Worker's code is untouched;
// only outbound fetches to oauth2.googleapis.com are intercepted.
//
// The authorization `code` the callback receives is read as the identity:
//   code = base64url(JSON {sub, email, name})
// and it travels on to tokeninfo as the id_token, which returns the claims.
import worker from "../../worker/src/index";

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin === "https://oauth2.googleapis.com") {
    if (url.pathname === "/token") {
      const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
      return Response.json({ id_token: code });
    }
    if (url.pathname === "/tokeninfo") {
      const who = JSON.parse(atob(url.searchParams.get("id_token")!.replace(/-/g, "+").replace(/_/g, "/")));
      return Response.json({ aud: "e2e-google-client", email_verified: "true", ...who });
    }
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

export default worker;
