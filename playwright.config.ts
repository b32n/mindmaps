import { defineConfig, devices } from "@playwright/test";

import { CLOSED_PORT, MAIN_PORT as PORT, MODE_CASES, googleWorker, mindboxWorker, modeWorkers, originWorker } from "./e2e/support/hosts";

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
    // One Worker per MINDMAPS_MODE setting (see e2e/support/hosts.ts). The
    // invalid one answers 500 to everything, so readiness is the port, not a URL.
    ...MODE_CASES.map((name) => ({
      command: "node e2e/support/serve.mjs",
      env: {
        E2E_PORT: String(modeWorkers[name].port),
        E2E_STATE_DIR: `.e2e-state-mode-${name}`,
        E2E_VARS: JSON.stringify({ MINDMAPS_MODE: modeWorkers[name].value }),
      },
      port: modeWorkers[name].port,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    })),
    // Google sign-in configured with Google faked (wrangler.test-google.toml).
    {
      command: "node e2e/support/serve.mjs",
      env: {
        E2E_PORT: String(googleWorker.port),
        E2E_STATE_DIR: ".e2e-state-google",
        E2E_CONFIG: "wrangler.test-google.toml",
      },
      url: `${googleWorker.baseURL}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
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
    // Google sign-in, against the Worker with Google faked.
    {
      name: "google",
      testDir: "./e2e/google",
      testMatch: /.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: googleWorker.baseURL },
    },
    // The installer's script and helpers; no browser, no Worker.
    { name: "installer", testDir: "./e2e/installer", testMatch: /.*\.spec\.ts/ },
    // Add engines here when the suite is ready for them:
    //   { name: "firefox", use: { ...devices["Desktop Firefox"] }, dependencies: ["setup"] },
    //   { name: "webkit",  use: { ...devices["Desktop Safari"] },  dependencies: ["setup"] },
  ],
});
