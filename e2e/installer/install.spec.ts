import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODE, MODES, PROMPTED_MODES, chooseMode, localToml, modeInToml, parseMode,
  // @ts-expect-error plain .mjs without types
} from "../../scripts/lib/install-config.mjs";

// The installer's mode handling. `--dry-run` runs the real script through the
// same argument handling and config generation as a real install, but signs in
// nowhere and creates nothing, so no Cloudflare account is needed. The script
// runs from a throwaway copy of the repo's files so an install of your own in
// the checkout (wrangler.local.toml) cannot change the result.

const repo = fileURLToPath(new URL("../..", import.meta.url));

let root: string;
test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mindmaps-install-"));
  mkdirSync(join(root, "scripts"));
  cpSync(join(repo, "scripts/install.mjs"), join(root, "scripts/install.mjs"));
  cpSync(join(repo, "scripts/lib"), join(root, "scripts/lib"), { recursive: true });
  cpSync(join(repo, "wrangler.toml"), join(root, "wrangler.toml"));
});
test.afterEach(() => rmSync(root, { recursive: true, force: true }));

function install(...args: string[]) {
  const r = spawnSync("node", [join(root, "scripts/install.mjs"), "--dry-run", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let plan: any = null;
  try {
    plan = JSON.parse(r.stdout);
  } catch {
    /* a refusal prints no plan */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, plan };
}

const varsOf = (toml: string) => toml.match(/^\[vars\]\n((?:.+\n?)*)/m)?.[1] ?? "";

test.describe("--mode", () => {
  for (const mode of MODES) {
    test(`--mode ${mode} is written to the config's [vars]`, () => {
      const r = install("--yes", "--mode", mode);
      expect(r.status).toBe(0);
      expect(r.plan.mode).toBe(mode);
      expect(r.plan.source).toBe("flag");
      expect(r.plan.config).toContain("[vars]");
      expect(varsOf(r.plan.config)).toContain(`MINDMAPS_MODE = "${mode}"`);
    });
  }

  test("an invalid --mode is rejected before anything happens", () => {
    for (const bad of ["personnal", "Personal", "team", "multi-tenant", ""]) {
      const r = install("--yes", "--mode", bad);
      expect(r.status, bad).toBe(1);
      expect(r.plan, bad).toBeNull();
      expect(r.stderr, bad).toContain("personal, org, multitenant");
    }
  });

  test("--mode with no value, or followed by another flag, is rejected", () => {
    for (const args of [["--mode"], ["--mode", "--yes"]]) {
      const r = install(...args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("--mode needs a value");
    }
  });

  test("it is rejected even without --dry-run, before any sign-in", () => {
    const r = spawnSync("node", [join(root, "scripts/install.mjs"), "--yes", "--mode", "nope"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--mode "nope" is not a mode');
    expect(r.stderr).not.toContain("Signing in");
  });
});

test.describe("defaults", () => {
  test("--yes without --mode installs personal", () => {
    const r = install("--yes");
    expect(r.status).toBe(0);
    expect(r.plan.mode).toBe("personal");
    expect(r.plan.source).toBe("default");
    expect(varsOf(r.plan.config)).toContain('MINDMAPS_MODE = "personal"');
  });

  test("no terminal (as in CI or an agent) behaves like --yes", () => {
    expect(install().plan.mode).toBe("personal");
  });

  test("a domain and a mode share the one [vars] table", () => {
    const r = install("--yes", "--mode", "org", "--domain", "notes.example.com", "--mindbox-domain", "box.example.com");
    expect(r.status).toBe(0);
    expect(r.plan.config.match(/^\[vars\]/gm)).toHaveLength(1);
    const vars = varsOf(r.plan.config);
    for (const line of [
      'PUBLIC_ORIGIN = "https://notes.example.com"',
      'MINDBOX_ORIGIN = "https://box.example.com"',
      'MINDMAPS_MODE = "org"',
    ])
      expect(vars).toContain(line);
  });

  test("the committed wrangler.toml sets no mode itself (unset is multitenant)", () => {
    const committed = readFileSync(join(repo, "wrangler.toml"), "utf8");
    expect(committed).not.toMatch(/^\s*MINDMAPS_MODE\s*=/m);
    expect(committed).not.toMatch(/^\[vars\]/m);
    expect(committed).toContain("MINDMAPS_MODE");
  });
});

test.describe("re-running on an existing install", () => {
  const local = (extra = "") => `name = "mindmaps"\n${extra}`;

  test("keeps the mode it has, even under --yes", () => {
    writeFileSync(join(root, "wrangler.local.toml"), local('[vars]\nMINDMAPS_MODE = "org"\n'));
    const r = install("--yes");
    expect(r.plan.mode).toBe("org");
    expect(r.plan.source).toBe("existing");
    expect(r.stderr).toContain("keeping mode org");
  });

  test("an install from before modes stays unset, so it stays multitenant", () => {
    writeFileSync(join(root, "wrangler.local.toml"), local());
    const r = install("--yes");
    expect(r.plan.mode).toBeNull();
    expect(r.plan.config).not.toMatch(/^MINDMAPS_MODE\s*=/m);
    expect(r.stderr).toContain("multitenant, as before");
  });

  test("--mode changes it", () => {
    writeFileSync(join(root, "wrangler.local.toml"), local('[vars]\nMINDMAPS_MODE = "org"\n'));
    const r = install("--yes", "--mode", "personal");
    expect(r.plan.mode).toBe("personal");
    expect(r.plan.source).toBe("flag");
  });

  test("nothing is written by a dry run", () => {
    install("--yes");
    expect(existsSync(join(root, "wrangler.local.toml"))).toBe(false);
    expect(existsSync(join(root, ".install.json"))).toBe(false);
  });
});

test.describe("chooseMode (the prompt)", () => {
  const asking = (answer: string) => {
    const seen: { q: string; dflt: string }[] = [];
    const ask = async (q: string, dflt: string) => (seen.push({ q, dflt }), answer || dflt);
    return { ask, seen };
  };

  test("asks personal or org, explains each in a line, defaults to personal, never offers multitenant", async () => {
    const { ask, seen } = asking("");
    const r = await chooseMode({ yes: false, existing: null, ask });
    expect(r).toEqual({ mode: "personal", source: "prompt" });
    expect(seen).toHaveLength(1);
    expect(seen[0].dflt).toBe("personal");
    expect(seen[0].q).toMatch(/personal\s+just you/);
    expect(seen[0].q).toMatch(/org\s+a team or company/);
    expect(seen[0].q).not.toMatch(/multitenant|multi-tenant|hosted/i);
    expect(PROMPTED_MODES).toEqual(["personal", "org"]);
  });

  test("takes org, in any case", async () => {
    expect((await chooseMode({ yes: false, existing: null, ask: asking(" ORG ").ask })).mode).toBe("org");
  });

  test("refuses multitenant and anything else typed at the prompt", async () => {
    for (const a of ["multitenant", "team", "1"])
      await expect(chooseMode({ yes: false, existing: null, ask: asking(a).ask }), a).rejects.toThrow(/"personal" or "org"/);
  });

  test("does not ask when --mode, --yes or an existing install decides", async () => {
    const { ask, seen } = asking("org");
    expect(await chooseMode({ flag: "multitenant", yes: false, existing: null, ask })).toEqual({ mode: "multitenant", source: "flag" });
    expect(await chooseMode({ yes: true, existing: null, ask })).toEqual({ mode: DEFAULT_MODE, source: "default" });
    expect(await chooseMode({ yes: false, existing: { mode: "org" }, ask })).toEqual({ mode: "org", source: "existing" });
    expect(seen).toHaveLength(0);
  });

  test("an invalid flag throws", async () => {
    await expect(chooseMode({ flag: "x", yes: true, existing: null, ask: asking("").ask })).rejects.toThrow(/not a mode/);
  });
});

test.describe("helpers", () => {
  test("parseMode", () => {
    for (const m of MODES) expect(parseMode(m)).toBe(m);
    for (const bad of [undefined, "", "--yes", "Org", "x"]) expect(() => parseMode(bad as string)).toThrow();
  });

  test("modeInToml reads what localToml wrote, and nothing from a comment", () => {
    const base = readFileSync(join(repo, "wrangler.toml"), "utf8");
    for (const mode of MODES)
      expect(modeInToml(localToml(base, { name: "x", dbId: "id", search: true, mode }))).toBe(mode);
    expect(modeInToml(localToml(base, { name: "x", dbId: "id", search: true }))).toBeNull();
  });

  test("localToml merges into an existing [vars] table instead of adding a second", () => {
    const out = localToml('name = "mindmaps"\n[vars]\nA = "1"\n', { name: "n", dbId: "id", search: true, mode: "org" });
    expect(out.match(/^\[vars\]/gm)).toHaveLength(1);
    expect(out).toContain('MINDMAPS_MODE = "org"');
    expect(out).toContain('A = "1"');
  });
});
