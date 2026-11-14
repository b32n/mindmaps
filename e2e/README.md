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
`--debug`, `--repeat-each=10`, `--project=chromium`.

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
  server, because it runs with `ALLOW_SIGNUPS=true`. When those tests arrive
  they get their own Worker: a second `webServer` entry with its own port,
  `E2E_STATE_DIR` and a config without the var. The same pattern gives
  one-database-per-worker if parallelism ever needs it.
- Never assert on global lists or counts across users; scope to your own user.

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

1. Put `*.spec.ts` in `e2e/tests/`, importing `test`/`expect` from
   `../fixtures`.
2. Locate by role, label or visible text first. If the UI has no accessible
   handle, add a `data-testid` to the smallest element that needs one.
3. Wait on observable state, never on time: web-first `expect(...)` assertions,
   `expect.poll`, or `page.waitForResponse` for a save. No `waitForTimeout`.
4. Run it with `--repeat-each=10` before sending it.
5. `npm run typecheck:e2e` checks this folder; CI runs it.

## CI

`.github/workflows/ci.yml`: `typecheck`, `build` and `e2e` run on every pull
request; `ci-ok` aggregates them and is the single required check on `main`.
