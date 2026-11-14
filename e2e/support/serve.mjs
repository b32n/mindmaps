// Starts the Worker the way the e2e suite needs it, in the foreground.
//
//   1. wipe the throwaway state dir, so every run starts on an empty database
//      (an empty DB is what makes the first sign-up the instance owner)
//   2. apply the real migrations to local D1
//   3. run `wrangler dev` on a fixed local port with wrangler.test.toml
//
// Environment: E2E_PORT, E2E_STATE_DIR and E2E_CONFIG choose the port, the state
// dir and the wrangler config, so a second instance (sign-up closed, see
// wrangler.test-closed.toml) can run beside the first.
//
// Playwright's `webServer` runs this and waits for HEALTH_URL. Nothing here
// talks to Cloudflare: local D1/R2 live under STATE_DIR, and the test config has
// no AI or Vectorize bindings (those would need a login).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const config = process.env.E2E_CONFIG ?? "wrangler.test.toml";
const stateDir = process.env.E2E_STATE_DIR ?? ".e2e-state";
const port = process.env.E2E_PORT ?? "8788";
const wrangler = resolve(root, "node_modules/.bin/wrangler");

if (!existsSync(resolve(root, "web/dist/index.html"))) {
  console.error("web/dist is missing. Run `npm run build` first.");
  process.exit(1);
}

rmSync(resolve(root, stateDir), { recursive: true, force: true });

const migrate = spawnSync(
  wrangler,
  ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir, "-c", config],
  { cwd: root, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const dev = spawn(
  wrangler,
  [
    "dev", "-c", config, "--persist-to", stateDir,
    "--ip", "127.0.0.1", "--port", port,
    "--show-interactive-dev-session=false",
  ],
  { cwd: root, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => dev.kill(sig));
dev.on("exit", (code) => process.exit(code ?? 0));
