import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOSTED_HOST,
  // @ts-expect-error plain .mjs without types
} from "../../scripts/lib/install-config.mjs";
import {
  deployPlan,
  // @ts-expect-error plain .mjs without types
} from "../../scripts/lib/deploy-plan.mjs";

// `npm run deploy` goes through scripts/deploy.mjs. Its decision (which config,
// which mode for production) is tested as a function, and the real script is
// run with --dry-run, which prints the wrangler commands and runs nothing.

const repo = fileURLToPath(new URL("../..", import.meta.url));
const local = (vars: string) => `name = "mindmaps"\n${vars}`;
const hosted = local(`[vars]\nPUBLIC_ORIGIN = "https://${HOSTED_HOST}"\nMINDMAPS_MODE = "multitenant"\n`);
const hostedNoMode = local(`[vars]\nPUBLIC_ORIGIN = "https://${HOSTED_HOST}"\n`);
const selfHosted = (mode: string) => local(`[vars]\nPUBLIC_ORIGIN = "https://notes.example.com"\nMINDMAPS_MODE = "${mode}"\n`);

test.describe("deployPlan (the decision)", () => {
  test("no local config: plain wrangler, nothing forced", () => {
    const p = deployPlan(null);
    expect(p.config).toBeNull();
    expect(p.migrate).toEqual(["d1", "migrations", "apply", "DB", "--remote"]);
    expect(p.deploy).toEqual(["deploy"]);
    expect(p.hosted).toBe(false);
  });

  test("a local config is passed to both migrate and deploy with --config", () => {
    const p = deployPlan(selfHosted("org"), "/x/wrangler.local.toml");
    expect(p.migrate.slice(0, 2)).toEqual(["--config", "/x/wrangler.local.toml"]);
    expect(p.deploy.slice(0, 2)).toEqual(["--config", "/x/wrangler.local.toml"]);
    expect(p.migrate).toContain("migrations");
    expect(p.deploy).toContain("deploy");
  });

  test("a non-hosted install keeps its own mode: no --var, any mode", () => {
    for (const mode of ["personal", "org", "multitenant"]) {
      const p = deployPlan(selfHosted(mode), "w.toml");
      expect(p.deploy, mode).not.toContain("--var");
      expect(p.hosted, mode).toBe(false);
    }
    expect(deployPlan(local("name = 'x'\n"), "w.toml").deploy).not.toContain("--var");
  });

  test("the hosted config deploys with MINDMAPS_MODE forced to multitenant", () => {
    for (const toml of [hosted, hostedNoMode]) {
      const p = deployPlan(toml, "w.toml");
      expect(p.hosted).toBe(true);
      expect(p.deploy).toContain("--var");
      expect(p.deploy[p.deploy.indexOf("--var") + 1]).toBe("MINDMAPS_MODE:multitenant");
      expect(p.migrate).not.toContain("--var");
    }
  });

  test("hosted by route only is hosted too", () => {
    const p = deployPlan(local(`[[routes]]\npattern = "${HOSTED_HOST}"\ncustom_domain = true\n`), "w.toml");
    expect(p.deploy).toContain("MINDMAPS_MODE:multitenant");
  });

  test("a hosted config that says personal or org is refused", () => {
    for (const mode of ["personal", "org"])
      expect(() => deployPlan(local(`[vars]\nPUBLIC_ORIGIN = "https://${HOSTED_HOST}"\nMINDMAPS_MODE = "${mode}"\n`), "w.toml")).toThrow(/multitenant/);
  });
});

test.describe("scripts/deploy.mjs --dry-run", () => {
  let root: string;
  test.beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mindmaps-deploy-"));
    mkdirSync(join(root, "scripts"));
    cpSync(join(repo, "scripts/deploy.mjs"), join(root, "scripts/deploy.mjs"));
    cpSync(join(repo, "scripts/lib"), join(root, "scripts/lib"), { recursive: true });
  });
  test.afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = () => {
    const r = spawnSync("node", [join(root, "scripts/deploy.mjs"), "--dry-run"], { encoding: "utf8" });
    let plan: any = null;
    try {
      plan = JSON.parse(r.stdout);
    } catch {}
    return { status: r.status, stderr: r.stderr, plan };
  };

  test("without wrangler.local.toml it uses the committed config", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.plan.deploy).toEqual(["deploy"]);
  });

  test("with wrangler.local.toml it passes --config", () => {
    writeFileSync(join(root, "wrangler.local.toml"), selfHosted("org"));
    const r = run();
    expect(r.plan.deploy[0]).toBe("--config");
    expect(r.plan.deploy[1]).toBe(join(root, "wrangler.local.toml"));
    expect(r.plan.deploy).not.toContain("--var");
  });

  test("hosted forces multitenant", () => {
    writeFileSync(join(root, "wrangler.local.toml"), hostedNoMode);
    expect(run().plan.deploy).toContain("MINDMAPS_MODE:multitenant");
  });

  test("hosted with personal exits 1 and runs nothing", () => {
    writeFileSync(join(root, "wrangler.local.toml"), local(`[vars]\nPUBLIC_ORIGIN = "https://${HOSTED_HOST}"\nMINDMAPS_MODE = "personal"\n`));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.plan).toBeNull();
    expect(r.stderr).toContain("multitenant");
  });
});

test.describe("package.json", () => {
  test("deploy goes through scripts/deploy.mjs, not a bare wrangler deploy", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    expect(pkg.scripts.deploy).toContain("scripts/deploy.mjs");
    expect(pkg.scripts.deploy).not.toMatch(/wrangler deploy/);
  });
});
