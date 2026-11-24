#!/usr/bin/env node
// `npm run deploy`: apply the database migrations, then deploy the Worker.
//
// It uses wrangler.local.toml (your IDs, domain and mode) when that file exists,
// as `npm run install:cloudflare` does; the committed wrangler.toml carries no
// IDs and defaults to personal. For the hosted service's host the mode is forced
// to multitenant. Build first: `npm run deploy` does. --dry-run prints the
// wrangler commands and runs nothing.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deployPlan } from "./lib/deploy-plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = join(ROOT, "wrangler.local.toml");
const DRY = process.argv.includes("--dry-run");

let plan;
try {
  plan = deployPlan(existsSync(LOCAL) ? readFileSync(LOCAL, "utf8") : null, LOCAL);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}

if (DRY) {
  console.log(JSON.stringify(plan));
  process.exit(0);
}

const WR = join(ROOT, "node_modules", ".bin", "wrangler");
for (const args of [plan.migrate, plan.deploy]) {
  const r = spawnSync(WR, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
