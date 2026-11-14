import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * A private Worker for the one thing the shared one cannot do: show what
 * happens to a trash entry that is past its seven days.
 *
 * There is no API to make an entry old, and editing the shared database under
 * a running Worker breaks every other test. So this starts its own (own port,
 * own state dir), lets a test make its entries, stops it, backdates the rows
 * with `wrangler d1 execute` while nothing else has the database open, and
 * starts it again on the same state.
 */
const root = new URL("../..", import.meta.url).pathname;
const port = Number(process.env.E2E_PORT ?? 8788) + 2;
const stateDir = ".e2e-state-expiry";
const wrangler = `${root}node_modules/.bin/wrangler`;
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

export class ExpiryWorker {
  private proc: ChildProcess | null = null;
  readonly url = `http://127.0.0.1:${port}`;

  /** Empty database, migrations applied, Worker listening. */
  async start(fresh = true) {
    if (fresh) {
      spawnSync("rm", ["-rf", `${root}${stateDir}`]);
      const m = spawnSync(
        wrangler,
        ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir, "-c", "wrangler.test.toml"],
        { cwd: root, env, encoding: "utf8" },
      );
      if (m.status !== 0) throw new Error(`migrations failed: ${m.stderr}`);
    }
    this.proc = spawn(
      wrangler,
      ["dev", "-c", "wrangler.test.toml", "--persist-to", stateDir, "--ip", "127.0.0.1", "--port", String(port),
        "--show-interactive-dev-session=false"],
      { cwd: root, env, stdio: "ignore" },
    );
    for (let i = 0; i < 240; i++) {
      try {
        if ((await fetch(`${this.url}/api/auth/me`)).status < 500) return;
      } catch {
        /* not up yet */
      }
      await sleep(500);
    }
    throw new Error("expiry Worker did not start");
  }

  async stop() {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    const closed = new Promise((r) => p.once("exit", r));
    p.kill("SIGTERM");
    await Promise.race([closed, sleep(10_000)]);
    // workerd is a child of wrangler; make sure nothing keeps the port or the database
    spawnSync("pkill", ["-f", `--port ${port}`]);
    await sleep(500);
  }

  /** Backdate trash entries by `days`, with the Worker stopped, then bring it back. */
  async age(ids: string[], days: number) {
    await this.stop();
    const at = Date.now() - days * 24 * 60 * 60 * 1000;
    const list = ids.map((id) => `'${id.replace(/[^A-Za-z0-9-]/g, "")}'`).join(",");
    const r = spawnSync(
      wrangler,
      ["d1", "execute", "DB", "--local", "--persist-to", stateDir, "-c", "wrangler.test.toml",
        "--command", `UPDATE trash SET deleted_at = ${at} WHERE id IN (${list})`],
      { cwd: root, env, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`could not age trash: ${r.stderr}`);
    await this.start(false);
  }

  client(): Promise<APIRequestContext> {
    return pwRequest.newContext({ baseURL: this.url });
  }
}
