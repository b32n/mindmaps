// What `npm run deploy` runs, as a plain function so it can be tested without
// Cloudflare. See docs/MODES.md.

import { HOSTED_HOST, modeInToml, tomlIsHosted } from "./install-config.mjs";

/**
 * The wrangler arguments for a deploy.
 *
 * `localToml` is the text of wrangler.local.toml, or null when there is none.
 *
 *   no local config      plain wrangler, the committed wrangler.toml
 *   a local config       --config <it>, so its database IDs, domain and mode apply
 *   ... for the hosted   MINDMAPS_MODE is forced to multitenant on the deploy, and
 *   service's host       a config that names another mode is refused: production
 *                        cannot be shipped as personal or org from here
 *
 * Any other install keeps the mode its own config sets.
 */
export function deployPlan(localToml, configPath = "wrangler.local.toml") {
  const config = localToml === null ? null : configPath;
  const base = config ? ["--config", config] : [];
  const hosted = localToml !== null && tomlIsHosted(localToml);
  const mode = localToml === null ? null : modeInToml(localToml);
  if (hosted && mode && mode !== "multitenant")
    throw new Error(
      `${HOSTED_HOST} is the hosted service and is always multitenant, but ${configPath} sets MINDMAPS_MODE to "${mode}". ` +
        "Fix it (npm run install:cloudflare -- --yes) before deploying.",
    );
  return {
    config,
    hosted,
    migrate: [...base, "d1", "migrations", "apply", "DB", "--remote"],
    deploy: [...base, "deploy", ...(hosted ? ["--var", "MINDMAPS_MODE:multitenant"] : [])],
  };
}
