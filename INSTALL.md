# Installing mindmaps

mindmaps runs entirely in **your** Cloudflare account. The free plan is enough.
Nothing is sent to the author, and there is no account with us.

You need: a free [Cloudflare account](https://dash.cloudflare.com/sign-up), and
for the command-line routes, [Node.js](https://nodejs.org) 20 or newer.

One thing Cloudflare asks for once: **R2** (file storage) must be switched on in
your dashboard. It has a free allowance but wants a card on file. If the
installer stops with an R2 message, enable it at *Dashboard → R2*, then re-run.

## Three ways in

1. **Deploy button.** README → *Deploy to Cloudflare*. No terminal.
2. **Your agent.** Paste the prompt from the README. It follows [AGENTS.md](./AGENTS.md).
3. **Terminal.** `npm install && npm run install:cloudflare`.

After any of them: open the address, create your account (**the first account is
the owner**), then connect your agent with the command shown.

## Updating

```bash
git pull && npm install && npm run install:cloudflare
```

It is safe to re-run: every step checks before it creates. Your data is kept.
(Deploy-button installs update when you pull the upstream repo into your copy.)

## Personal or org

The installer asks whether this install is for **personal** use (you, plus the
people you invite) or an **org** (a team or company). It is stored as
`MINDMAPS_MODE` and can be changed later. For now it only records the choice;
see [docs/MODES.md](./docs/MODES.md) for what each mode means, how to set or
change it (also for Deploy-button installs), and what is not enforced yet.

```bash
npm run install:cloudflare -- --mode org       # or personal
```

## Who can sign up

Only the first account, after which sign-up is closed: anyone able to register
can spend your storage and AI allowance. To add people, invite them from a
workspace's share menu (an invite lets that address register). To open sign-up
to everyone:

```bash
npx wrangler secret put ALLOW_SIGNUPS      # enter: true
```

## Your own domain

Needs a domain whose DNS is on this Cloudflare account.

```bash
npm run install:cloudflare -- --domain notes.example.com
```

## HTML artefacts

Pages an agent writes in HTML work out of the box, on any install. Nothing to
configure: they are served with a `sandbox` header that gives the page no
cookies, no storage and no network, wherever it is opened.

Want a second wall behind that? Serve them from a different hostname than the
app (needs a domain on Cloudflare):

```bash
npm run install:cloudflare -- --domain notes.example.com --mindbox-domain box.example.com
```

## Non-interactive / agents

`npm run install:cloudflare -- --yes --json` never prompts and prints one JSON
object: `{ ok, url, mcp, search, htmlArtefacts, next }`. The only human step is
approving the Cloudflare login in a browser. Flags: `--name`, `--domain`,
`--mindbox-domain`, `--mode`, `--no-search`, `--dry-run`. Without `--mode`,
`--yes` installs `personal`.

## Where things live

| What | Where |
|---|---|
| Cards, links, accounts | D1 database `mindmaps` in your account |
| Images, files, sheets, docs | R2 bucket `mindmaps-images` in your account |
| Search index | Vectorize `mindmaps-chunks` (optional) |
| Your IDs | `wrangler.local.toml`, `.install.json` (gitignored) |

## Troubleshooting

- **"Cloudflare needs R2 switched on"**: see the top of this page.
- **Several accounts**: `CLOUDFLARE_ACCOUNT_ID=<id> npm run install:cloudflare`.
- **Search index couldn't be created**: the app still works, with keyword search.
  Re-run later.
- **Start over**: delete the Worker, D1 database and R2 bucket in the dashboard,
  remove `wrangler.local.toml`, and re-run.
