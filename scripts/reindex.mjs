/**
 * Re-embed every card on one account.
 *
 *   node scripts/reindex.mjs                        # prompts for email + password
 *   MINDMAPS_EMAIL=... MINDMAPS_PASSWORD=... node scripts/reindex.mjs
 *   MINDMAPS_URL=http://localhost:8787 node scripts/reindex.mjs
 *
 * Needed after the move to passage-level chunking and bge-m3: cards written
 * before either are unfindable by *meaning* until this has run over them. They
 * remain findable by wording throughout, so this is a quality repair, not an
 * outage.
 *
 * The server does one page per request because each card is a Workers AI call,
 * and a few hundred of those in a single request meets the subrequest ceiling
 * and a CPU timeout at once. This just pumps the cursor.
 *
 * Safe to re-run and safe to interrupt: indexing is idempotent by chunk id, and
 * a resumed run re-covers at most one page.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, readFileSync } from "node:fs";

const URL_ = process.env.MINDMAPS_URL ?? (existsSync(".install.json") ? JSON.parse(readFileSync(".install.json", "utf8")).url : undefined);
if (!URL_) {
  console.error("Set MINDMAPS_URL to your deployment, e.g. MINDMAPS_URL=https://mindmaps.you.workers.dev");
  process.exit(1);
}
const BASE = URL_.replace(/\/$/, "");
const PAGE = Number(process.env.MINDMAPS_PAGE ?? 25);

/** Read a secret without echoing it. */
async function secret(prompt) {
  stdout.write(prompt);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  let out = "";
  for await (const chunk of stdin) {
    const s = chunk.toString();
    if (s === "\r" || s === "\n") break;
    if (s === "") {
      stdin.setRawMode?.(wasRaw ?? false);
      stdout.write("\n");
      process.exit(130);
    }
    if (s === "") out = out.slice(0, -1);
    else out += s;
  }
  stdin.setRawMode?.(wasRaw ?? false);
  stdout.write("\n");
  return out;
}

async function main() {
  let email = process.env.MINDMAPS_EMAIL;
  let password = process.env.MINDMAPS_PASSWORD;

  if (!email) {
    const rl = createInterface({ input: stdin, output: stdout });
    email = await rl.question(`Email for ${BASE}: `);
    rl.close();
  }
  if (!password) password = await secret("Password: ");

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  if (!login.ok) {
    const body = await login.text().catch(() => "");
    console.error(`Sign-in failed (${login.status}). ${body.slice(0, 200)}`);
    process.exit(1);
  }

  // The cookie is HttpOnly; fetch exposes it on the response headers only.
  const setCookie = login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie")];
  const session = setCookie
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("wb_session="));
  if (!session) {
    console.error("Signed in, but no session cookie came back — cannot continue.");
    process.exit(1);
  }

  console.log(`Signed in to ${BASE}. Reindexing ${PAGE} cards per request.\n`);

  // Resume where a failed run stopped, using the cursor it printed.
  let after = process.env.MINDMAPS_AFTER ?? null;
  let total = 0;
  let pages = 0;
  const started = Date.now();

  for (;;) {
    const res = await fetch(`${BASE}/api/reindex`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ limit: PAGE, ...(after ? { after } : {}) }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`\nPage ${pages + 1} failed (${res.status}). ${body.slice(0, 300)}`);
      console.error(
        after
          ? `Resume with:  MINDMAPS_AFTER=${after} node scripts/reindex.mjs`
          : "Nothing was indexed; re-run to start over.",
      );
      process.exit(1);
    }

    const page = await res.json();
    total += page.count ?? 0;
    pages += 1;
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    stdout.write(`\r  ${total} cards · ${pages} page${pages === 1 ? "" : "s"} · ${secs}s`);

    if (page.done) break;
    after = page.next;
    if (!after) break;
  }

  console.log(`\n\nDone. ${total} cards re-embedded.`);
  console.log("Cards with neither title nor prose are skipped — they are nothing to index.");
}

main().catch((err) => {
  console.error("\n" + (err?.stack ?? String(err)));
  process.exit(1);
});
