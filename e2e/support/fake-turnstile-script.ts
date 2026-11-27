import type { Page } from "@playwright/test";

/**
 * Stand in for Cloudflare's widget script (https://challenges.cloudflare.com/turnstile/v0/api.js),
 * which the browser cannot reach in the suite. The page calls `turnstile.render` as it
 * would with the real one; the test decides when the visitor "solves" it with
 * `solve(page, token)`, which fires the widget's callback. `reset` forgets the token,
 * as the real widget does. Also records what the page asked for.
 */
export async function fakeWidgetScript(page: Page) {
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
        window.__ts = { renders: [], resets: 0, removed: 0, cb: null };
        window.turnstile = {
          render(el, o) {
            window.__ts.renders.push({ sitekey: o.sitekey, action: o.action });
            window.__ts.cb = o;
            el.setAttribute("data-fake-widget", o.action);
            return "w" + window.__ts.renders.length;
          },
          reset() { window.__ts.resets++; },
          remove() { window.__ts.removed++; },
        };`,
    }),
  );
}

/** The visitor solves the widget: the page receives `token`. */
export const solve = (page: Page, token: string) =>
  page.evaluate((t) => (window as any).__ts.cb.callback(t), token);

export const widgetState = (page: Page) => page.evaluate(() => (window as any).__ts ?? null);
