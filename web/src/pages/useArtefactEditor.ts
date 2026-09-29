/**
 * Load, autosave and title an artefact, for any of the three editors.
 *
 * The three Spindle models differ in everything except their lifecycle: build
 * a model, `setData` the payload from R2, subscribe to the events that mean
 * "the document changed", and write `getData()` back on a debounce. That
 * lifecycle is the fiddly part — the debounce, the flush on unload, the state
 * label — and it is identical, so it lives here once.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

/** Long enough to batch a burst of typing, short enough to survive a tab close. */
const SAVE_AFTER_MS = 1200;

/** What every Spindle model happens to expose, and all this needs. */
export interface ArtefactModel {
  setData(data: never): void;
  getData(): unknown;
  on(event: never, handler: () => void): (() => void) | void;
  /** Documents and decks carry their own title; a workbook carries `name`. */
  setTitle?(title: string): void;
  name?: string;
}

export interface ArtefactEditor<M> {
  model: M | null;
  title: string;
  setTitle: (t: string) => void;
  error: string | null;
  /** "Saving…" | "Unsaved" | "Saved" */
  state: string;
  dirty: boolean;
  /** Write now, rather than waiting out the debounce. */
  flush: () => void;
}

export function useArtefactEditor<M extends ArtefactModel>({
  nodeId,
  build,
  events,
}: {
  nodeId: string;
  /** Make an empty model, then the payload is applied with `setData`. */
  build: (id: string, name: string) => M;
  /** The model's own event names that mean the document changed. */
  events: readonly string[];
}): ArtefactEditor<M> {
  const [model, setModel] = useState<M | null>(null);
  const [title, setTitleState] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirtyAt, setDirtyAt] = useState<number | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelRef = useRef<M | null>(null);

  useEffect(() => {
    let cancelled = false;
    setModel(null);
    setError(null);

    Promise.all([api.artefact(nodeId), api.node(nodeId)])
      .then(([payload, node]) => {
        if (cancelled) return;
        const p = payload as { id?: string; name?: string; title?: string };
        const m = build(p?.id ?? nodeId, p?.name ?? p?.title ?? node.title ?? "Untitled");
        m.setData(payload as never);
        modelRef.current = m;
        setTitleState(node.title ?? "");
        setModel(m);
      })
      .catch((e) => !cancelled && setError((e as Error).message));

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // `build` is a module-level constructor call, stable by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const save = useCallback(async () => {
    const m = modelRef.current;
    if (!m) return;
    setSaving(true);
    try {
      await api.saveArtefact(nodeId, m.getData());
      setDirtyAt(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [nodeId]);

  /**
   * Debounced save, driven by the model's own events.
   *
   * None of the providers take a change callback, so the mutation signal comes
   * from the model. Selection events are deliberately not subscribed: moving
   * the cursor is not a change, and saving on it would write to R2 every time
   * an arrow key is pressed.
   */
  useEffect(() => {
    const m = model;
    if (!m) return;
    const touch = () => {
      setDirtyAt(Date.now());
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), SAVE_AFTER_MS);
    };
    const offs = events.map((e) => m.on(e as never, touch));
    return () => offs.forEach((off) => typeof off === "function" && off());
  }, [model, events, save]);

  // A pending save must not be lost to a closed tab. The debounce window is
  // short but it is not zero.
  useEffect(() => {
    if (dirtyAt === null) return;
    const flush = () => void save();
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [dirtyAt, save]);

  /**
   * Rename both the node and the payload.
   *
   * The node title is what the board and recall read, so it has to change. But
   * a document and a deck carry a title of their own and render it inside the
   * editor, so changing only the node leaves the page header saying one thing
   * and the document saying another. A workbook keeps the same idea in `name`.
   *
   * Writing the payload back is deliberate rather than incidental: the title is
   * part of the snapshot the brain reads, so a rename that never reached R2
   * would leave the artefact findable under its old name.
   */
  const setTitle = useCallback(
    (t: string) => {
      setTitleState(t);
      void api.updateNode(nodeId, { title: t });

      const m = modelRef.current;
      if (!m) return;
      if (typeof m.setTitle === "function") m.setTitle(t);
      else if ("name" in m) (m as { name: string }).name = t;

      setDirtyAt(Date.now());
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), SAVE_AFTER_MS);
    },
    [nodeId, save],
  );

  return {
    model,
    title,
    setTitle,
    error,
    state: saving ? "Saving…" : dirtyAt !== null ? "Unsaved" : "Saved",
    dirty: dirtyAt !== null,
    flush: () => void save(),
  };
}
