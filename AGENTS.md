# Instructions for AI agents

## Installing mindmaps for a user

Goal: deploy this repo to the **user's own** Cloudflare account. Do this:

1. Check `node -v` is 20+. If not, tell the user to install it from nodejs.org.
2. `npm install`
3. `npm run install:cloudflare -- --yes --json`
   - It runs `wrangler login`, which opens a browser. **Tell the user to approve
     it**; you cannot. Wait for it to finish.
   - Progress goes to stderr; the last stdout line is JSON:
     `{ ok, url, mcp, next }`.
4. If it fails on R2, the user must enable R2 once in the Cloudflare dashboard
   (it wants a card on file; the free tier is enough). Then re-run step 3.
5. Tell the user: open `url`, create an account (the first account is the owner).
6. Connect yourself: `claude mcp add --transport http mindmaps <mcp>` (Codex:
   `codex mcp add mindmaps --url <mcp>`). The first call opens a browser for the
   user to approve.
7. Offer to add the memory instructions from README.md → *Make it use the memory
   without being asked* to the user's `CLAUDE.md` / `AGENTS.md`.

Ask before: using a custom domain (`--domain`), or enabling open sign-up
(`ALLOW_SIGNUPS`). Never print or commit `.dev.vars`, `.install.json` or
`wrangler.local.toml`.

## Working on this repo

- One Worker at the repo root (`wrangler.toml`): API and MCP in `worker/`, the
  React app in `web/`. `npm run dev` + `npm run dev:web`.
- `npm run typecheck` before finishing. Migrations: `worker/migrations/`, numbered,
  idempotent.
- Read DESIGN.md and MCP.md before changing the data model or tools.
