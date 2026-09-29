/**
 * A shared artefact, for whoever has the link.
 *
 * The only route in the app that renders someone's content without a session,
 * so it is deliberately bare: the artefact, its name, and nothing else. No
 * rail, no board, no way to reach anything the link did not grant. The
 * resolver on the server returns one artefact and nothing around it, and this
 * page is the same promise in the UI.
 *
 * Every kind is behind its own `lazy` boundary. Someone opening a shared deck
 * should not download the spreadsheet engine, and a shared page needs none of
 * them.
 */

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type SharedArtefact } from "../api";

const SheetViewer = lazy(() => import("../viewers/SheetViewer"));
const DocViewer = lazy(() => import("../viewers/DocViewer"));
const DeckViewer = lazy(() => import("../viewers/DeckViewer"));

export function SharedView() {
  const { token = "" } = useParams();
  const [found, setFound] = useState<SharedArtefact | null>(null);
  const [error, setError] = useState<string | null>(null);

  const frame = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    let cancelled = false;
    api
      .shared(token)
      .then((r) => !cancelled && setFound(r))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Same pixel-sizing story as the editors: every Spindle component takes
  // numbers, not CSS.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [found]);

  useEffect(() => {
    if (found?.title) document.title = found.title;
  }, [found]);

  if (error)
    return (
      <div className="shared-page shared-gone">
        <h1>This link is not available</h1>
        <p>
          It may have been revoked by its owner, expired, or the artefact may have been
          deleted.
        </p>
      </div>
    );

  if (!found)
    return (
      <div className="shared-page">
        <p className="sheet-msg">Opening…</p>
      </div>
    );

  return (
    <div className="shared-page">
      <header className="shared-head">
        <span className="shared-title">{found.title || "Untitled"}</span>
        <span className="shared-badge">Shared, read only</span>
      </header>

      <div className="shared-body" ref={frame}>
        {size.w > 0 &&
          (found.kind === "html" ? (
            // A shared page runs in the mindbox exactly as it does for its
            // owner: separate origin, opaque frame, no network.
            <iframe
              title={found.title || "Shared page"}
              src={found.frame ?? ""}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          ) : (
            <Suspense fallback={<p className="sheet-msg">Opening…</p>}>
              {found.kind === "sheet" && (
                <SheetViewer payload={found.payload} title={found.title} size={size} />
              )}
              {found.kind === "doc" && (
                <DocViewer payload={found.payload} title={found.title} size={size} />
              )}
              {found.kind === "deck" && (
                <DeckViewer payload={found.payload} title={found.title} size={size} />
              )}
            </Suspense>
          ))}
      </div>
    </div>
  );
}

export default SharedView;
