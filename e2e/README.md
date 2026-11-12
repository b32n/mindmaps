# End-to-end tests

Playwright drives the real app in a real browser against the real Worker. No
mocks: the Worker runs under `wrangler dev` with local D1 and R2, and the web
app is the production build.

## Run it

```sh
npm ci
npm run build          # the Worker serves web/dist; rebuild after web/ changes
npm run e2e:install    # once: Chromium (+ system libraries; may need sudo)
npm run test:e2e       # headless; opens nothing
npm run test:e2e:ui    # Playwright's UI mode
npm run test:e2e:report
```

Playwright starts the Worker itself (`e2e/support/serve.mjs`) and waits for
`/api/auth/me`. Locally it reuses a server already on the port, so for fast
reruns start one in another terminal with `npm run e2e:serve`. Its database is
wiped each time *that script* starts, not between test runs, which is fine:
tests never rely on an empty database (see Isolation).

Anything Playwright accepts works: `npx playwright test smoke --headed`,
`--debug`, `--repeat-each=10`, `--project=chromium`, `--project=closed-signup`.
`E2E_PORT` / `E2E_CLOSED_PORT` move the two Workers if 8788 / 8789 are taken.

## How the test runtime works

- `wrangler.test.toml` is the test-only Worker config. It serves `web/dist`,
  binds local D1 (the real `worker/migrations`) and local R2 (`IMAGES`,
  `ARTEFACTS`), and sets `ALLOW_SIGNUPS = "true"`. It has placeholder ids
  because local mode never contacts Cloudflare. It is not referenced by
  `wrangler.toml`, the installer or the deploy script.
- It omits the `[ai]` and `[[vectorize]]` bindings (they need a Cloudflare
  login even locally) and the cron trigger. The Worker treats AI and Vectorize
  as optional, so **recall uses keyword search in tests**; semantic ranking is
  not covered here.
- State lives in `.e2e-state/` (gitignored), deleted and re-migrated every time
  `serve.mjs` starts. Port is `8788` (`E2E_PORT` to change).

## Auth and isolation

There is **no test-only code path in the Worker**: no seed endpoint, no auth
bypass. Tests register real users through the real sign-up API (or form).

- `e2e/fixtures.ts` exports `test` with an `account` fixture: a unique user
  (random email, policy-compliant password) registered through
  `POST /api/auth/register` on the test's browser context, so `page` and
  `request` are already signed in. Use it for anything that needs a user:

  ```ts
  import { test, expect } from "../fixtures";
  test("...", async ({ page, account }) => { await page.goto("/app"); });
  ```
- Each test therefore owns its data (every account gets its own personal
  workspace and starter mindmap) and tests run fully parallel.
- The `setup` project registers the instance owner (the first account on an
  empty database) and saves its session to `e2e/.auth/owner.json`. A spec that
  needs the owner opts in with `test.use({ storageState: OWNER_STATE })` (from
  `e2e/support/state.ts`).
- Tests that need *sign-up closed* (owner-first behaviour) cannot share this
  server, because it runs with `ALLOW_SIGNUPS=true`. They run against a second
  Worker, see "The sign-up-closed instance" below.
- Never assert on global lists or counts across users; scope to your own user.

## The sign-up-closed instance

The Worker's real default is closed: the first account on an empty database is
the owner, after that sign-up needs a live invite for the address
(`signupAllowed` in `worker/src/index.ts`). That cannot be tested on the main
test Worker, so there is a second one:

| | main | closed |
|---|---|---|
| config | `wrangler.test.toml` | `wrangler.test-closed.toml` (same, without `ALLOW_SIGNUPS`) |
| port | 8788 (`E2E_PORT`) | 8789 (`E2E_CLOSED_PORT`) |
| state dir | `.e2e-state/` | `.e2e-state-closed/` |
| reused if running | locally, yes | never (it must start empty) |
| Playwright projects | `setup`, `chromium` | `closed-setup`, `closed-signup` |
| specs | `e2e/tests/**` | `e2e/closed-signup/` |

`playwright.config.ts` lists both in `webServer`, so every run starts both; the
closed one is idle unless a closed-signup spec runs. `e2e/support/serve.mjs` takes
`E2E_PORT`, `E2E_STATE_DIR` and `E2E_CONFIG`, which is all that differs.

`closed-setup` signs the owner up through the form (the first account) and saves
its session and credentials under `e2e/.auth/`. "First account on an empty
database" can only be observed once per server start, so on a repeat
(`--repeat-each`) or a retry that one step is *skipped*, not failed; every other
closed spec works on any database state (a stranger is refused, an invited
address gets in).

## Layout

```
e2e/
  fixtures.ts            test, expect, `account`, `existing`, `makePerson`
  support/
    api.ts               the app's HTTP API: arrange state, read back what the server stored
    board.ts             Board page object: cards, drag, links, viewport, saved-state reads
    rail.ts              the left rail: create / open / settings dialog for mindmaps
    trash.ts             the Trash dialog
    auth.ts              fill the sign-in / sign-up forms
    files.ts             deliver a pasted or dropped image to the page
    users.ts state.ts    unique users; paths of saved sessions
    serve.mjs            starts a local Worker (D1 + R2) for Playwright
  setup/                 registers the instance owner on the main Worker
  closed-signup/         the second Worker's setup and specs
  tests/
    auth/                landing, sign-up, password policy, sign-in, sign-out, sessions, routes
    mindmaps/            create, rename, labels, pin, reorder, delete, switching, starter map
    cards/               create (all ways), edit, markdown rendering, checklists, delete, undo/redo
    links/               handle drags, link picker, cross-mindmap stubs, labels, flip/remove/re-attach
    layout/              drag, selection, pan/zoom + home view, images, resize, ink
    search/              Recall (keyword path)
    trash/               restore, purge, empty, the shared-mindmap bug
    settings/ workspaces/ artefacts/   dialogs and lists (basics)
```

`Board` (support/board.ts) separates what the browser *shows* (`locator`s,
`box()`) from what the server *stored* (`saved()`, `savedNode()`). Persistence
assertions read the second, so they hold without reloading and without waiting
on time. `Board.drag()` uses a real mouse with intermediate moves, because React
Flow only starts a drag on movement; assert the saved position, not pixels.

## What is covered

Everything the UI exposes in these areas, on Chromium:

- **Auth**: landing and brain pages; sign-up through the form, live password
  rules (one test per rule) and the server's policy; duplicate and malformed
  emails; sign-in, wrong password, unknown user (same message); redirects for
  protected routes and back to the page you were turned away from, `?next=`
  never leaving the origin; sign-out (and that the token dies server-side);
  session cookie flags and persistence; sign-up closed / owner-first / invites on
  the second Worker.
- **Mindmaps**: starter map, create, rename, description, labels, pin, drag to
  reorder, delete (two-step), empty states, switching, URL and Back/Forward.
- **Cards and notes**: create by button, `C`/`N`, double-click, image paste/drop;
  title and document editing (typing, markdown shortcuts, slash menu, paste);
  open/close/focus/open-at-bottom and the `?card=` URL; markdown rendering
  (headings, emphasis, lists, quotes, code, tables, links, images), checklist
  toggling and progress; delete; undo/redo; the dock's other kinds (create only).
- **Links**: handle-to-handle, the link picker (new card, existing card, either
  direction, filters), cross-mindmap stubs, labels, flip, remove, re-attach, undo.
- **Layout**: drag and persist, selection, multi-select, pan/zoom persistence,
  home view, image resize, pen / eraser.
- **Search**: Recall's keyword path.
- **Trash**: card and mindmap restore, purge, empty, ownership.
- **Basics only**: settings dialog, workspace menu, the mindmap share dialog,
  the Artefacts list, the research-thread section (no thread is started).

Known product bugs are written as `test.fixme` with expected-vs-actual in a
comment above the test; un-`fixme` one when its fix lands.

## What is deliberately not covered

- **Semantic recall.** The test Worker has no Workers AI / Vectorize, so only
  the keyword ranking runs. Meaning-based ranking, the reranker and the
  embedding sweep are not exercised.
- **Sharing in depth** (invites, roles, removal, public links, the `/v/:token`
  viewer, workspace membership rules), and **artefacts and files** (the sheet,
  document, deck, page editors, uploads, downloads): a later PR.
- **MCP, the OAuth flow and "Connected apps"**: a later PR.
- **Visual regression, accessibility audits, Firefox and WebKit**: a later PR.
- Things the UI does not have: forgot-password, changing a password, deleting an
  account, card colours or kinds beyond card/note, copy/paste or duplicate of
  cards, auto-arrange or direction toggles (relayout is MCP-only), resizing
  cards (only images and ink resize), a visible "restore" for a deleted-by-others
  item.

## Reading failures

CI uploads `playwright-report` and `test-results` for every run. Traces,
screenshots and videos are kept only for failures.

```sh
npx playwright show-report                      # after downloading playwright-report/
npx playwright show-trace test-results/<test>/trace.zip
```

The trace has a DOM snapshot, network calls and console for each step. Worker
logs appear in the run output prefixed `[WebServer]`.

## Adding a test

1. Put `*.spec.ts` in the matching folder of `e2e/tests/` (or add one), importing
   `test`/`expect` from `../../fixtures`. Need the sign-up-closed Worker instead?
   Put it in `e2e/closed-signup/`.
2. Locate by role, label or visible text first. If the UI has no accessible
   handle, add a `data-testid` to the smallest element that needs one.
3. Arrange with the API helpers (`support/api.ts`: a fresh board, a card with a
   markdown body, an edge) and drive the UI only for the behaviour under test.
   `Board.create(page)` makes an empty mindmap and opens it.
4. Wait on observable state, never on time: web-first `expect(...)` assertions,
   `expect.poll`, `board.settled()` after a glide, or `page.waitForResponse` for a
   save (register it *before* the action). No `waitForTimeout`.
5. Found a bug? Don't fix it in the test PR: write the correct behaviour as
   `test.fixme(...)` and describe expected vs actual above it.
6. Run it with `--repeat-each=10` before sending it.
7. `npm run typecheck:e2e` checks this folder; CI runs it.

## CI

`.github/workflows/ci.yml`: `typecheck`, `build` and `e2e` run on every pull
request; `ci-ok` aggregates them and is the single required check on `main`.
`e2e` is a matrix of shards (`--shard=i/n`); each shard has its own two Workers
and databases. Add a shard by raising the denominator in the matrix list.
