// A Worker of a spec's own, for what the shared ones cannot show: an empty
// database (the first account is special), a mode switched under existing data,
// or sign-up in its real default (closed).
//
// Each instance has its own port and state dir, so `--repeat-each` and parallel
// workers never share one. It is stopped by its own process group, never by a
// name pattern.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { request as pwRequest, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";

const root = new URL("../..", import.meta.url).pathname;
const wrangler = `${root}node_modules/.bin/wrangler`;
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => ok(port));
    });
  });
}

/**
 * A migrated, empty database per config, made once per test process and copied
 * for each Worker: applying the migrations through wrangler is most of what
 * starting one costs.
 */
const templates = new Map<string, string>();
function template(config: string): string {
  const have = templates.get(config);
  if (have) return have;
  const dir = `.e2e-state-private-tpl-${process.pid}-${config.replace(/\W/g, "")}`;
  spawnSync("rm", ["-rf", `${root}${dir}`]);
  const m = spawnSync(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", dir, "-c", config], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (m.status !== 0) throw new Error(`migrations failed: ${m.stderr}`);
  templates.set(config, dir);
  process.on("exit", () => spawnSync("rm", ["-rf", `${root}${dir}`]));
  return dir;
}

export interface PrivateWorkerOptions {
  /** MINDMAPS_MODE; omit to leave it unset. */
  mode?: string;
  /** "closed" is the Worker's real default: first account, then invitation only. */
  signup?: "open" | "closed";
}

export class PrivateWorker {
  private proc: ChildProcess | null = null;
  private port = 0;
  private readonly stateDir = `.e2e-state-private-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private readonly clients: APIRequestContext[] = [];
  private readonly contexts: BrowserContext[] = [];

  constructor(private opts: PrivateWorkerOptions = {}) {}

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  private get config() {
    return this.opts.signup === "open" ? "wrangler.test.toml" : "wrangler.test-closed.toml";
  }

  /** Migrated, empty, listening. */
  async start() {
    this.port = await freePort();
    spawnSync("rm", ["-rf", `${root}${this.stateDir}`]);
    const copied = spawnSync("cp", ["-r", `${root}${template(this.config)}`, `${root}${this.stateDir}`]);
    if (copied.status !== 0) throw new Error("could not copy the migrated database");
    await this.listen();
    return this;
  }

  /** Stop, change the mode, and start again on the same database. */
  async restart(mode: string | undefined) {
    await this.stop();
    this.opts = { ...this.opts, mode };
    await this.listen();
  }

  private async listen() {
    const vars = this.opts.mode === undefined ? [] : ["--var", `MINDMAPS_MODE:${this.opts.mode}`];
    for (let attempt = 0; attempt < 3; attempt++) {
      const inspector = await freePort();
      this.proc = spawn(
        wrangler,
        ["dev", "-c", this.config, "--persist-to", this.stateDir, "--ip", "127.0.0.1", "--port", String(this.port),
          "--inspector-port", String(inspector), "--show-interactive-dev-session=false", ...vars],
        { cwd: root, env, stdio: "ignore", detached: true },
      );
      for (let i = 0; i < 80; i++) {
        try {
          if ((await fetch(`${this.url}/api/auth/me`)).status < 500) return;
        } catch {
          /* not up yet */
        }
        await sleep(500);
      }
      await this.stop();
    }
    throw new Error("private Worker did not start");
  }

  async stop() {
    const p = this.proc;
    this.proc = null;
    if (!p?.pid) return;
    const closed = new Promise((r) => p.once("exit", r));
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    await Promise.race([closed, sleep(10_000)]);
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      /* gone */
    }
    await sleep(300);
  }

  /** An API client with its own cookie jar. */
  async client(): Promise<APIRequestContext> {
    const c = await pwRequest.newContext({ baseURL: this.url });
    this.clients.push(c);
    return c;
  }

  /** A browser context pointed at this Worker, optionally already signed in as `client`. */
  async context(browser: Browser, as?: APIRequestContext): Promise<BrowserContext> {
    const c = await browser.newContext({
      baseURL: this.url,
      ...(as ? { storageState: await as.storageState() } : {}),
    });
    this.contexts.push(c);
    return c;
  }

  async dispose() {
    await Promise.all(this.contexts.map((c) => c.close().catch(() => {})));
    await Promise.all(this.clients.map((c) => c.dispose().catch(() => {})));
    await this.stop();
    spawnSync("rm", ["-rf", `${root}${this.stateDir}`]);
  }
}
