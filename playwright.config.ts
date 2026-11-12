import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8788);
const BASE_URL = `http://127.0.0.1:${PORT}`;
// The second Worker: same app, sign-up closed (wrangler.test-closed.toml).
const CLOSED_PORT = Number(process.env.E2E_CLOSED_PORT ?? 8789);
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
    // Add engines here when the suite is ready for them:
    //   { name: "firefox", use: { ...devices["Desktop Firefox"] }, dependencies: ["setup"] },
    //   { name: "webkit",  use: { ...devices["Desktop Safari"] },  dependencies: ["setup"] },
  ],
});
