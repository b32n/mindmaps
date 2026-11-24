import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODE, HOSTED_HOST, MODES, PROMPTED_MODES, chooseMode, localToml, modeInToml, parseMode, tomlIsHosted,
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

const countModes = (toml: string) => (toml.match(/^MINDMAPS_MODE\s*=/gm) ?? []).length;
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

  test("the committed wrangler.toml defaults to personal as a real assignment (the Deploy button)", () => {
    const committed = readFileSync(join(repo, "wrangler.toml"), "utf8");
    expect(committed).toMatch(/^MINDMAPS_MODE\s*=\s*"personal"\s*$/m);
    expect(committed.match(/^\[vars\]/gm)).toHaveLength(1);
    expect(varsOf(committed)).toContain('MINDMAPS_MODE = "personal"');
    expect(countModes(committed)).toBe(1);
  });

  test("the e2e Worker configs leave the mode unset, so unset = multitenant stays tested", () => {
    for (const f of ["wrangler.test.toml", "wrangler.test-closed.toml", "wrangler.test-origins.toml"])
      expect(readFileSync(join(repo, f), "utf8"), f).not.toMatch(/^\s*MINDMAPS_MODE\s*=/m);
  });

  test("the generated config has exactly one MINDMAPS_MODE, the chosen one, never the template's personal", () => {
    for (const mode of MODES) {
      const r = install("--yes", "--mode", mode, "--domain", "notes.example.com");
      expect(countModes(r.plan.config), mode).toBe(1);
      expect(r.plan.config.match(/^\[vars\]/gm), mode).toHaveLength(1);
      expect(modeInToml(r.plan.config), mode).toBe(mode);
    }
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

  test("an org install keeps org and the template's personal does not leak in", () => {
    writeFileSync(join(root, "wrangler.local.toml"), local('[vars]\nMINDMAPS_MODE = "org"\n'));
    const r = install("--yes");
    expect(countModes(r.plan.config)).toBe(1);
    expect(modeInToml(r.plan.config)).toBe("org");
  });

  test("a pre-modes install that is not the hosted host omits the variable, not the template's personal", () => {
    writeFileSync(join(root, "wrangler.local.toml"), local('[vars]\nPUBLIC_ORIGIN = "https://notes.example.com"\n'));
    const r = install("--yes");
    expect(r.plan.mode).toBeNull();
    expect(r.plan.source).toBe("existing");
    expect(countModes(r.plan.config)).toBe(0);
    expect(modeInToml(r.plan.config)).toBeNull();
    expect(r.plan.config.match(/^\[vars\]/gm)?.length ?? 0).toBeLessThanOrEqual(1);
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

test.describe("the hosted service is pinned to multitenant", () => {
  const local = (extra: string) => `name = "mindmaps"\n${extra}`;
  const hostedExisting: [string, string][] = [
    ["PUBLIC_ORIGIN", `[vars]\nPUBLIC_ORIGIN = "https://${HOSTED_HOST}"\n`],
    ["APP_ORIGIN without a scheme", `[vars]\nAPP_ORIGIN = "${HOSTED_HOST}"\n`],
    ["a route", `[[routes]]\npattern = "${HOSTED_HOST}"\ncustom_domain = true\n`],
    ["an uppercase origin with a path", `[vars]\nAPP_ORIGIN = "https://${HOSTED_HOST.toUpperCase()}/"\n`],
  ];

  test("the hosted hostname is a single named constant", () => {
    expect(HOSTED_HOST).toBe("mindmaps.b32n.io");
  });

  test("--domain <hosted> writes multitenant even under --yes", () => {
    const r = install("--yes", "--domain", HOSTED_HOST);
    expect(r.status).toBe(0);
    expect(r.plan.mode).toBe("multitenant");
    expect(r.plan.source).toBe("hosted");
    expect(countModes(r.plan.config)).toBe(1);
    expect(varsOf(r.plan.config)).toContain('MINDMAPS_MODE = "multitenant"');
  });

  test("--mode multitenant is accepted for it", () => {
    const r = install("--yes", "--domain", HOSTED_HOST, "--mode", "multitenant");
    expect(r.status).toBe(0);
    expect(r.plan.mode).toBe("multitenant");
  });

  test("--mode personal or org for it is rejected before anything happens", () => {
    for (const mode of ["personal", "org"]) {
      const r = install("--yes", "--domain", HOSTED_HOST, "--mode", mode);
      expect(r.status, mode).toBe(1);
      expect(r.plan, mode).toBeNull();
      expect(r.stderr, mode).toContain(HOSTED_HOST);
      expect(r.stderr, mode).toContain("multitenant");
    }
  });

  test("the rejection comes before any sign-in, even without --dry-run", () => {
    const r = spawnSync("node", [join(root, "scripts/install.mjs"), "--yes", "--domain", HOSTED_HOST, "--mode", "org"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("multitenant");
    expect(r.stderr).not.toContain("Signing in");
    expect(existsSync(join(root, "wrangler.local.toml"))).toBe(false);
  });

  for (const [label, extra] of hostedExisting) {
    test(`an existing config whose ${label} is the host gets multitenant written, even with no mode set`, () => {
      writeFileSync(join(root, "wrangler.local.toml"), local(extra));
      const r = install("--yes");
      expect(r.status).toBe(0);
      expect(r.plan.mode).toBe("multitenant");
      expect(r.plan.source).toBe("hosted");
      expect(countModes(r.plan.config)).toBe(1);
      expect(modeInToml(r.plan.config)).toBe("multitenant");
      // the pin must survive the next run: the host is still in the config
      expect(tomlIsHosted(r.plan.config)).toBe(true);
    });
  }

  test("an existing hosted config with a stray personal/org mode is pulled back to multitenant", () => {
    writeFileSync(join(root, "wrangler.local.toml"), local(`[vars]\nPUBLIC_ORIGIN = "https://${HOSTED_HOST}"\nMINDMAPS_MODE = "personal"\n`));
    expect(install("--yes").plan.mode).toBe("multitenant");
  });

  test("--mode personal on an existing hosted config is rejected too", () => {
    writeFileSync(join(root, "wrangler.local.toml"), local(`[vars]\nPUBLIC_ORIGIN = "https://${HOSTED_HOST}"\n`));
    const r = install("--yes", "--mode", "personal");
    expect(r.status).toBe(1);
    expect(r.plan).toBeNull();
  });

  test("a different host is not hosted: --mode still overrides there", () => {
    for (const mode of MODES) {
      const r = install("--yes", "--domain", "notes.example.com", "--mode", mode);
      expect(r.status, mode).toBe(0);
      expect(r.plan.mode, mode).toBe(mode);
    }
    // a lookalike is not the hosted host
    expect(install("--yes", "--domain", `x${HOSTED_HOST}`, "--mode", "org").plan.mode).toBe("org");
    expect(install("--yes", "--domain", `${HOSTED_HOST}.example.com`, "--mode", "org").plan.mode).toBe("org");
  });

  test("tomlIsHosted", () => {
    for (const [, extra] of hostedExisting) expect(tomlIsHosted(local(extra))).toBe(true);
    expect(tomlIsHosted(local('[vars]\nPUBLIC_ORIGIN = "https://notes.example.com"\n'))).toBe(false);
    // a comment is not an assignment
    expect(tomlIsHosted(local(`# PUBLIC_ORIGIN = "https://${HOSTED_HOST}"\n`))).toBe(false);
    expect(tomlIsHosted(readFileSync(join(repo, "wrangler.toml"), "utf8"))).toBe(false);
  });

  test("chooseMode: hosted pins and never asks", async () => {
    const seen: string[] = [];
    const ask = async (q: string, d: string) => (seen.push(q), "org");
    expect(await chooseMode({ yes: false, hosted: true, existing: null, ask })).toEqual({ mode: "multitenant", source: "hosted" });
    expect(await chooseMode({ yes: true, hosted: true, existing: { mode: null }, ask })).toEqual({ mode: "multitenant", source: "hosted" });
    expect(await chooseMode({ flag: "multitenant", yes: true, hosted: true, existing: null, ask })).toEqual({ mode: "multitenant", source: "hosted" });
    await expect(chooseMode({ flag: "org", yes: true, hosted: true, existing: null, ask })).rejects.toThrow(/multitenant/);
    await expect(chooseMode({ flag: "personal", yes: false, hosted: true, existing: null, ask })).rejects.toThrow(HOSTED_HOST);
    expect(seen).toHaveLength(0);
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

  test("localToml without a mode strips the template's default and writes none", () => {
    const base = readFileSync(join(repo, "wrangler.toml"), "utf8");
    expect(modeInToml(base)).toBe("personal");
    for (const opts of [{}, { mode: undefined }, { mode: null }]) {
      const out = localToml(base, { name: "x", dbId: "id", search: true, ...opts });
      expect(countModes(out)).toBe(0);
      expect(modeInToml(out)).toBeNull();
      expect(out.match(/^\[vars\]/gm)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  test("localToml replaces the template's default with the chosen mode, once", () => {
    const base = readFileSync(join(repo, "wrangler.toml"), "utf8");
    for (const mode of MODES) {
      const out = localToml(base, { name: "x", dbId: "id", search: false, domain: "n.example.com", mode });
      expect(countModes(out)).toBe(1);
      expect(modeInToml(out)).toBe(mode);
      expect(out.match(/^\[vars\]/gm)).toHaveLength(1);
    }
  });

  test("localToml strips an assignment but keeps comments about it", () => {
    const out = localToml('name = "m"\n# MINDMAPS_MODE = "org" in a comment\n[vars]\nA = "1"\nMINDMAPS_MODE = "personal"\n', { name: "n", dbId: "id", search: true });
    expect(out).toContain('# MINDMAPS_MODE = "org" in a comment');
    expect(countModes(out)).toBe(0);
    expect(out).toContain('A = "1"');
  });

  test("localToml merges into an existing [vars] table instead of adding a second", () => {
    const out = localToml('name = "mindmaps"\n[vars]\nA = "1"\n', { name: "n", dbId: "id", search: true, mode: "org" });
    expect(out.match(/^\[vars\]/gm)).toHaveLength(1);
    expect(out).toContain('MINDMAPS_MODE = "org"');
    expect(out).toContain('A = "1"');
  });
});
