/**
 * Share an artefact, two ways, in the order people actually want them.
 *
 * Naming a person comes first because it is the common case and the safer one:
 * they sign in, they can be removed, and access is attached to them rather than
 * to whoever the URL reached. A public link is second, under its own heading,
 * because "anyone with this URL" is a different promise and should never be
 * reached by accident when someone meant "share with Ana".
 *
 * The view count sits with the link because it is the first thing anyone asks
 * after sending one, and because a link nobody has opened is one you can revoke
 * without a conversation.
 */

import { useCallback, useEffect, useState } from "react";
import { api, type Share } from "./api";
import { MembersPanel } from "./MembersPanel";

function ago(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ShareMenu({ nodeId }: { nodeId: string }) {
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .shares(nodeId)
      .then(setShares)
      .catch((e) => setError((e as Error).message));
  }, [nodeId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Escape closes, and a click anywhere else closes. A share panel left open
  // over a document is a panel in the way.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".share-wrap")) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.createShare(nodeId);
      setShares((xs) => [s, ...(xs ?? [])]);
      await copy(s.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      // Clipboard access can be refused; the input below is selectable, so
      // there is still a way to get the link.
    }
  };

  const revoke = async (token: string) => {
    setShares((xs) => (xs ?? []).filter((s) => s.token !== token));
    try {
      await api.revokeShare(token);
    } catch (e) {
      setError((e as Error).message);
      load();
    }
  };

  return (
    <span className="share-wrap">
      <button
        className={`page-code-toggle${open ? " on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Share
      </button>

      {open && (
        <div className="share-pop">
          <div className="share-section">
            <h4 className="share-heading">People</h4>
            <MembersPanel kind="artefacts" id={nodeId} />
          </div>

          <div className="share-sep" />

          <div className="share-section">
            <h4 className="share-heading">
              Public link
              <span className="share-sub">Anyone with the URL can read it, without an account.</span>
            </h4>
          </div>

          {error && <p className="trash-error">{error}</p>}

          {shares === null ? (
            <p className="share-msg">Loading…</p>
          ) : shares.length === 0 ? (
            <>
              <p className="share-msg">No link yet.</p>
              <button className="btn btn-primary" onClick={() => void create()} disabled={busy}>
                Create link
              </button>
            </>
          ) : (
            <>
              <ul className="share-list">
                {shares.map((s) => {
                  const expired = s.expires_at !== null && s.expires_at < Date.now();
                  return (
                    <li key={s.token} className="share-row">
                      <input className="share-url" readOnly value={s.url} onFocus={(e) => e.target.select()} />
                      <button className="btn btn-small" onClick={() => void copy(s.url)}>
                        {copied === s.url ? "Copied" : "Copy"}
                      </button>
                      <button
                        className="btn btn-small btn-quiet"
                        onClick={() => void revoke(s.token)}
                        title="Revoke this link"
                      >
                        Revoke
                      </button>
                      <span className="share-meta">
                        {expired
                          ? "expired"
                          : s.views === 0
                            ? "not opened yet"
                            : `${s.views} view${s.views === 1 ? "" : "s"}, last ${ago(s.last_seen_at ?? s.created_at)}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <button className="btn btn-small" onClick={() => void create()} disabled={busy}>
                Create another link
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}
