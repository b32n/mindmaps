import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8788);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e/tests",
  outputDir: "./test-results",
  // Every test registers its own user, so tests share no state and can run in
  // parallel against the one Worker.
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  // One Worker (workerd + SQLite) serves every test; two runners are enough to
  // exercise isolation without starving it on a 2-vCPU CI machine.
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
  webServer: {
    command: "node e2e/support/serve.mjs",
    url: `${BASE_URL}/api/auth/me`,
    // Locally, keep a server you started yourself (`npm run e2e:serve`) for
    // fast reruns. On CI always start a fresh one.
    reuseExistingServer: !CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    { name: "setup", testDir: "./e2e/setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
    // Add engines here when the suite is ready for them:
    //   { name: "firefox", use: { ...devices["Desktop Firefox"] }, dependencies: ["setup"] },
    //   { name: "webkit",  use: { ...devices["Desktop Safari"] },  dependencies: ["setup"] },
  ],
});
