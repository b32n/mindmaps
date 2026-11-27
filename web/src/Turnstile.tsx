import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/**
 * The Cloudflare Turnstile widget, shown only where the instance has a site key
 * (`/api/auth/me` says so). It hands the page a one-use token; the Worker checks
 * it with Siteverify, so nothing here is trusted. docs/SIGNUP.md.
 *
 * The script is loaded on first use, from Cloudflare, only on instances that turned
 * the check on.
 */

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

function load(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("no turnstile")));
    s.onerror = () => {
      loading = null; // a blocked script may load next time
      reject(new Error("The security check could not load."));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface TurnstileHandle {
  /** Ask for a fresh token: each one works once, so call this after any attempt that used it. */
  reset: () => void;
}

export const Turnstile = forwardRef<
  TurnstileHandle,
  { siteKey: string; action: string; onToken: (token: string | null) => void }
>(function Turnstile({ siteKey, action, onToken }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | undefined>(undefined);
  const api = useRef<TurnstileApi | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;

  useImperativeHandle(ref, () => ({
    reset: () => {
      cb.current(null);
      if (api.current && widget.current !== undefined) api.current.reset(widget.current);
    },
  }));

  useEffect(() => {
    let gone = false;
    load().then(
      (t) => {
        if (gone || !box.current) return;
        api.current = t;
        widget.current = t.render(box.current, {
          sitekey: siteKey,
          action,
          callback: (token: string) => cb.current(token),
          "expired-callback": () => cb.current(null),
          "error-callback": () => cb.current(null),
        });
      },
      () => {},
    );
    return () => {
      gone = true;
      if (api.current && widget.current !== undefined) api.current.remove(widget.current);
      widget.current = undefined;
    };
  }, [siteKey, action]);

  return <div ref={box} className="turnstile" data-testid="turnstile" />;
});
