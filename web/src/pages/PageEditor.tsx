/**
 * The HTML artefact editor: the rendered page, with the source on request.
 *
 * Preview-first by default. Most pages here are written by an agent, so the
 * common reason to open one is to look at it rather than to read it, and a
 * permanent wall of markup beside it makes the artefact feel like source code
 * instead of a thing.
 *
 * The preview is not rendered in this document. It is an iframe pointing at the
 * mindbox — a separate origin — with `sandbox="allow-scripts"` and no
 * `allow-same-origin`, which is the whole reason this artefact type is safe to
 * have. Rendering author-written script inline here would hand it the session
 * cookie and every card the user owns.
 *
 * `allow-same-origin` is absent on purpose and must stay absent: granted
 * together with `allow-scripts`, a frame can reach its own document and strip
 * the sandbox attribute off itself.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { useArtefactEditor } from "./useArtefactEditor";
import { ArtefactFrame } from "./ArtefactFrame";
import { ShareMenu } from "../ShareMenu";

/**
 * The model for an HTML page.
 *
 * The other three kinds bring a Spindle model that already speaks
 * setData/getData/on, which is what `useArtefactEditor` drives. A page has no
 * engine behind it, so this is the smallest thing that satisfies the same
 * contract and gets the same debounced autosave, title syncing and
 * flush-on-unload rather than a second implementation of all three.
 */
class PageDoc {
  title = "";
  html = "";
  private handlers = new Set<() => void>();

  setData(data: { title?: string; html?: string }) {
    this.title = data?.title ?? "";
    this.html = data?.html ?? "";
  }
  getData() {
    return { title: this.title, html: this.html };
  }
  on(_event: string, handler: () => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  setTitle(title: string) {
    this.title = title;
  }
  setHtml(html: string) {
    this.html = html;
    this.handlers.forEach((h) => h());
  }
}

const EVENTS = ["change"] as const;

export function PageEditor() {
  const { nodeId = "" } = useParams();
  const ed = useArtefactEditor<PageDoc>({
    nodeId,
    build: () => new PageDoc(),
    events: EVENTS,
  });

  const [source, setSource] = useState("");

  // Remembered, because whichever way you work is the way you keep working.
  const [showCode, setShowCode] = useState(
    () => localStorage.getItem("mindmaps.pageCode") === "1",
  );
  useEffect(() => {
    localStorage.setItem("mindmaps.pageCode", showCode ? "1" : "0");
  }, [showCode]);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const loaded = useRef(false);

  // Seed the textarea once the payload arrives. Guarded, because the editor is
  // the source of truth after that and re-seeding would undo live typing.
  useEffect(() => {
    if (!ed.model || loaded.current) return;
    setSource(ed.model.html);
    loaded.current = true;
  }, [ed.model]);

  /**
   * Point the preview at a freshly signed URL.
   *
   * Called after a save rather than on every keystroke: the mindbox reads the
   * stored payload, so a preview of unsaved text would be a preview of the
   * wrong thing. The URL is minted each time because it expires.
   */
  const refresh = useCallback(async () => {
    try {
      const { url } = await api.artefactFrame(nodeId);
      // A changing query string is what makes the iframe actually reload; the
      // signature differs per mint, so this happens for free.
      setFrameSrc(url);
      setFrameError(null);
    } catch (e) {
      setFrameError((e as Error).message);
    }
  }, [nodeId]);

  useEffect(() => {
    if (ed.model) void refresh();
  }, [ed.model, refresh]);

  // Re-render the preview when a save lands, not while typing.
  const wasDirty = useRef(false);
  useEffect(() => {
    if (wasDirty.current && !ed.dirty) void refresh();
    wasDirty.current = ed.dirty;
  }, [ed.dirty, refresh]);

  return (
    <ArtefactFrame
      title={ed.title}
      onTitle={ed.setTitle}
      state={ed.state}
      placeholder="Untitled page"
      error={ed.error}
      loading={!ed.model}
      dirty={ed.dirty}
      onLeave={ed.flush}
      actions={
        <>
          <ShareMenu nodeId={nodeId} />
          <button
          className={`page-code-toggle${showCode ? " on" : ""}`}
          onClick={() => setShowCode((v) => !v)}
          aria-pressed={showCode}
          >
            Code
          </button>
        </>
      }
    >
      {() => (
        <div className={`page-split${showCode ? "" : " solo"}`}>
          <textarea
            className="page-source"
            value={source}
            spellCheck={false}
            placeholder="<h1>Hello</h1>"
            onChange={(e) => {
              setSource(e.target.value);
              ed.model!.setHtml(e.target.value);
            }}
          />
          <div className="page-preview">
            {frameError ? (
              <p className="sheet-msg sheet-err">{frameError}</p>
            ) : frameSrc ? (
              <iframe
                title="Preview"
                src={frameSrc}
                // The two attributes this whole design rests on. `allow-scripts`
                // without `allow-same-origin` gives the frame an opaque origin,
                // so it can run code and reach nothing.
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
              />
            ) : (
              <p className="sheet-msg">Rendering…</p>
            )}
          </div>
        </div>
      )}
    </ArtefactFrame>
  );
}

export default PageEditor;
