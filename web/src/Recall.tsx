/**
 * Recall, for a person. ⌘K from anywhere.
 *
 * The agent has had this since the MCP server shipped; you had a list of
 * mindmaps and your own memory of where things were. Same endpoint, same
 * ranking, rendered as a list instead of markdown.
 *
 * Deliberately not a filter over loaded cards. It calls the server so it
 * searches everything you own, including mindmaps this board has never
 * fetched, and so a match on meaning works at all.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type RecallResult } from "./api";

/** Long enough that typing a sentence is one request, short enough to feel live. */
const DEBOUNCE_MS = 220;

export function Recall() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [res, setRes] = useState<RecallResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inflight = useRef<AbortController | null>(null);
  const navigate = useNavigate();

  // ⌘K / Ctrl-K anywhere, Escape to leave. Bound on the window rather than a
  // element so it works while focus is in a card's editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
    else {
      // Reset on close so reopening is a fresh question, not the stale answer
      // to the last one.
      setQ("");
      setRes(null);
      setError(null);
      setSel(0);
    }
  }, [open]);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setRes(null);
      setBusy(false);
      return;
    }
    const t = setTimeout(async () => {
      // Abort the previous request: results arriving out of order would show
      // the answer to a prefix of what is now in the box.
      inflight.current?.abort();
      const ctrl = new AbortController();
      inflight.current = ctrl;
      setBusy(true);
      setError(null);
      try {
        const r = await api.recall(query, ctrl.signal);
        if (!ctrl.signal.aborted) {
          setRes(r);
          setSel(0);
        }
      } catch (e) {
        if (!ctrl.signal.aborted) setError((e as Error).message);
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const hits = res?.hits ?? [];

  const go = useCallback(
    (i: number) => {
      const h = hits[i];
      if (!h) return;
      setOpen(false);
      navigate(`/app/${h.board_id}?card=${h.id}`);
    },
    [hits, navigate],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, hits.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    }
    if (e.key === "Enter") {
      e.preventDefault();
      go(sel);
    }
  };

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  return (
    <div className="rc-scrim" onPointerDown={() => setOpen(false)}>
      <div className="rc" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Recall">
        <div className="rc-bar">
          <span className="rc-icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </span>
          <input
            ref={input}
            className="rc-input"
            value={q}
            placeholder="What do you already know about…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy && <span className="rc-spin" aria-label="Searching" />}
          <kbd className="rc-kbd">esc</kbd>
        </div>

        <div className="rc-list" ref={listRef}>
          {error && <p className="rc-msg rc-err">{error}</p>}

          {!error && !q.trim() && (
            <p className="rc-msg">
              Search by meaning, not just wording. “who owns this” finds the card that says
              nobody has picked it up.
            </p>
          )}

          {!error && q.trim() && !busy && hits.length === 0 && (
            <p className="rc-msg">
              Nothing recorded about “{q.trim()}”. That is worth writing down.
            </p>
          )}

          {hits.map((h, i) => (
            <button
              key={h.id}
              className={`rc-hit${i === sel ? " on" : ""}`}
              data-sel={i === sel}
              onMouseMove={() => setSel(i)}
              onClick={() => go(i)}
            >
              <span className="rc-hit-top">
                <span className="rc-hit-title">{h.title || "Untitled"}</span>
                {h.superseded && <span className="rc-tag stale">superseded</span>}
              </span>
              <span className="rc-hit-meta">
                {h.board_name}
                {h.why.map((w) => (
                  <span className="rc-tag" key={w}>
                    {w}
                  </span>
                ))}
              </span>
              {h.passage && (
                <span className="rc-hit-passage">
                  {h.passage}
                  {h.truncated ? "…" : ""}
                </span>
              )}
              {h.links.length > 0 && (
                <span className="rc-hit-links">
                  {h.links.slice(0, 3).map((l) => (
                    <span key={l.id}>
                      {l.label ? `${l.label} · ` : ""}
                      {l.title || "untitled"}
                    </span>
                  ))}
                </span>
              )}
            </button>
          ))}

          {res?.degraded && (
            <p className="rc-msg rc-note">
              Recent cards were searched by meaning, everything by wording. The semantic
              index is unavailable, so older cards matched on wording alone.
            </p>
          )}
        </div>

        {hits.length > 0 && (
          <div className="rc-foot">
            <span>
              {hits.length} of {res?.found} matches
            </span>
            <span className="rc-keys">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move <kbd>↵</kbd> open
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
