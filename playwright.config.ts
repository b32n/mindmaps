import { defineConfig, devices } from "@playwright/test";

import { CLOSED_PORT, DOH_ENDPOINT, DOH_PORT, FAKE_GOOGLE_PORT, FAKE_TURNSTILE_PORT, IDP_PORT, MAIN_PORT as PORT, MODE_CASES, legalHostedWorker, legalOrgWorker, mailWorker, mindboxWorker, modeWorkers, originWorker, turnstileWorker } from "./e2e/support/hosts";

const BASE_URL = `http://127.0.0.1:${PORT}`;
// The second Worker: same app, sign-up closed (wrangler.test-closed.toml).
const CLOSED_URL = `http://127.0.0.1:${CLOSED_PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e/tests",
  outputDir: "./test-results",
  // Every test registers its own user, so tests share no state and can run in
  // parallel against the one Worker.
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  // One Worker (workerd + SQLite) serves nearly every test (a second serves only
  // the sign-up-closed specs); two runners are enough to exercise isolation
  // without starving it on a 2-vCPU CI machine.
  workers: CI ? 2 : undefined,
  reporter: CI
    ? [
        ["list"],
        ["html", { outputFolder: "playwright-report", open: "never" }],
        ["github"],
        ["junit", { outputFile: "test-results/junit.xml" }],
      ]
    : [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "node e2e/support/serve.mjs",
      // Every Worker the SSO specs use is told where the mock DNS resolver is.
      env: { E2E_VARS: JSON.stringify({ DOH_ENDPOINT }) },
      url: `${BASE_URL}/api/auth/me`,
      // Locally, keep a server you started yourself (`npm run e2e:serve`) for
      // fast reruns. On CI always start a fresh one.
      reuseExistingServer: !CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Sign-up closed: the Worker's real default. It must start on an empty
      // database (the first account is the owner), so it is never reused and
      // keeps its state in its own dir.
      command: "node e2e/support/serve.mjs",
      env: {
        E2E_PORT: String(CLOSED_PORT),
        E2E_STATE_DIR: ".e2e-state-closed",
        E2E_CONFIG: "wrangler.test-closed.toml",
      },
      url: `${CLOSED_URL}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Third and fourth Workers: origins configured (wrangler.test-origins.toml
      // plus --var). They listen on every loopback address, so the hosts named
      // in their configuration (localhost, 127.0.0.2) reach them too.
      command: "node e2e/support/serve.mjs",
      env: {
        E2E_PORT: String(originWorker.port),
        E2E_STATE_DIR: ".e2e-state-origin",
        E2E_CONFIG: "wrangler.test-origins.toml",
        E2E_IP: "0.0.0.0",
        E2E_VARS: JSON.stringify({ PUBLIC_ORIGIN: originWorker.publicOrigin }),
      },
      url: `${originWorker.baseURL}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node e2e/support/serve.mjs",
      env: {
        E2E_PORT: String(mindboxWorker.port),
        E2E_STATE_DIR: ".e2e-state-mindbox",
        E2E_CONFIG: "wrangler.test-origins.toml",
        E2E_IP: "0.0.0.0",
        E2E_VARS: JSON.stringify({
          PUBLIC_ORIGIN: mindboxWorker.publicOrigin,
          APP_ORIGIN: mindboxWorker.publicOrigin,
          MINDBOX_ORIGIN: mindboxWorker.mindboxOrigin,
        }),
      },
      url: `${mindboxWorker.baseURL}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // The OIDC identity provider and DNS-over-HTTPS resolver the SSO specs
      // talk to (e2e/support/mock-services.mjs). Nothing leaves the machine.
      command: "node e2e/support/mock-services.mjs",
      env: { E2E_IDP_PORT: String(IDP_PORT), E2E_DOH_PORT: String(DOH_PORT) },
      port: IDP_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    // Outbound email on (captured, never sent), with a fake Google beside it.
    {
      command: "node e2e/support/serve.mjs",
      env: {
        E2E_PORT: String(mailWorker.port),
        E2E_STATE_DIR: ".e2e-state-mail",
        E2E_CONFIG: "wrangler.test-mail.toml",
        E2E_VARS: JSON.stringify(mailWorker.vars),
      },
      url: `${mailWorker.baseURL}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node e2e/support/fake-google.mjs",
      env: { E2E_FAKE_GOOGLE_PORT: String(FAKE_GOOGLE_PORT) },
      port: FAKE_GOOGLE_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    // Mail captured and the sign-up check on, with a local stand-in for Siteverify beside it.
    {
      command: "node e2e/support/serve.mjs",
      env: {
        E2E_PORT: String(turnstileWorker.port),
        E2E_STATE_DIR: ".e2e-state-turnstile",
        E2E_CONFIG: "wrangler.test-turnstile.toml",
        E2E_VARS: JSON.stringify(turnstileWorker.vars),
      },
      url: `${turnstileWorker.baseURL}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node e2e/support/fake-turnstile.mjs",
      env: { E2E_FAKE_TURNSTILE_PORT: String(FAKE_TURNSTILE_PORT) },
      port: FAKE_TURNSTILE_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    // One Worker per MINDMAPS_MODE setting (see e2e/support/hosts.ts). The
    // invalid one answers 500 to everything, so readiness is the port, not a URL.
    ...MODE_CASES.map((name) => ({
      command: "node e2e/support/serve.mjs",
      env: {
        E2E_PORT: String(modeWorkers[name].port),
        E2E_STATE_DIR: `.e2e-state-mode-${name}`,
        E2E_VARS: JSON.stringify({ MINDMAPS_MODE: modeWorkers[name].value, DOH_ENDPOINT }),
      },
      port: modeWorkers[name].port,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    })),
    // Workers with the operator's own settings, for /privacy, /terms and security.txt.
    ...[
      { name: "legal-org", worker: legalOrgWorker },
      { name: "legal-hosted", worker: legalHostedWorker },
    ].map(({ name, worker }) => ({
      command: "node e2e/support/serve.mjs",
      env: {
        E2E_PORT: String(worker.port),
        E2E_STATE_DIR: `.e2e-state-${name}`,
        E2E_VARS: JSON.stringify(worker.vars),
      },
      port: worker.port,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    })),
  ],
  projects: [
    { name: "setup", testDir: "./e2e/setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
    // Specs that need sign-up CLOSED run against the second Worker. The setup
    // step registers its owner (the first account on its empty database).
    {
      name: "closed-setup",
      testDir: "./e2e/closed-signup",
      testMatch: /.*\.setup\.ts/,
      use: { baseURL: CLOSED_URL },
    },
    {
      name: "closed-signup",
      testDir: "./e2e/closed-signup",
      testMatch: /.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: CLOSED_URL },
      dependencies: ["closed-setup"],
    },
    // Specs about the URLs the Worker hands out, against the Workers whose
    // origins are configured. (The same checks run on the main Worker, the
    // unconfigured default, from e2e/tests/mcp.) Users register through the real
    // sign-up API, and sign-up is open here, so no setup project is needed.
    {
      name: "origin",
      testDir: "./e2e/origins",
      testMatch: /public-origin\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: originWorker.baseURL },
    },
    {
      name: "mindbox",
      testDir: "./e2e/origins",
      testMatch: /mindbox-origin\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: mindboxWorker.baseURL },
    },
    // Specs about MINDMAPS_MODE: each runs against the Workers above, picking
    // the one it needs by address (the main Worker leaves the var unset).
    {
      name: "modes",
      testDir: "./e2e/modes",
      testMatch: /.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    // Email verification, password reset and sign-in limits, against the email
    // Worker (the "email not configured" cases run on the main one).
    {
      name: "email",
      testDir: "./e2e/email",
      testMatch: /.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: mailWorker.baseURL },
    },
    // The sign-up check (Cloudflare Turnstile), against the Worker that has it on.
    {
      name: "turnstile",
      testDir: "./e2e/turnstile",
      testMatch: /.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: turnstileWorker.baseURL },
    },
    // The installer's script and helpers; no browser, no Worker.
    { name: "installer", testDir: "./e2e/installer", testMatch: /.*\.spec\.ts/ },
    // Add engines here when the suite is ready for them:
    //   { name: "firefox", use: { ...devices["Desktop Firefox"] }, dependencies: ["setup"] },
    //   { name: "webkit",  use: { ...devices["Desktop Safari"] },  dependencies: ["setup"] },
  ],
});
