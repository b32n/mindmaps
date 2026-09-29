/**
 * The trash: everything deleted in the last week, and the way back.
 *
 * Deleting archives rather than destroys (worker/src/trash.ts), so every row
 * here is genuinely restorable — a card comes back with its links, a mindmap
 * comes back with everything that was on it. The window is the same seven days
 * the R2 objects are kept for, which is what makes that promise true rather
 * than optimistic.
 */

import { useCallback, useEffect, useState } from "react";
import { api, type TrashEntry } from "./api";
import { Modal } from "./ui/Modal";

/** Matches RETENTION_MS in worker/src/r2trash.ts. */
const RETENTION_DAYS = 7;

/**
 * How long this has left, in the words a person would use.
 *
 * Counting *down* rather than showing a delete date, because the only question
 * anyone brings to a trash folder is "do I still have time".
 */
function remaining(deletedAt: number): { text: string; urgent: boolean } {
  const msLeft = deletedAt + RETENTION_DAYS * 86_400_000 - Date.now();
  if (msLeft <= 0) return { text: "gone shortly", urgent: true };
  const hours = Math.floor(msLeft / 3_600_000);
  if (hours < 1) return { text: `${Math.max(1, Math.round(msLeft / 60_000))} min left`, urgent: true };
  if (hours < 24) return { text: `${hours}h left`, urgent: true };
  const days = Math.round(hours / 24);
  return { text: `${days} day${days === 1 ? "" : "s"} left`, urgent: false };
}

function whenDeleted(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TrashDialog({
  open,
  onClose,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  /** Reload the rail and the board: a restore can bring back either. */
  onRestored: (boardId: string) => void;
}) {
  const [items, setItems] = useState<TrashEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .trash()
      .then(setItems)
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setConfirmEmpty(false);
    load();
  }, [open, load]);

  const restore = async (entry: TrashEntry) => {
    setBusy(entry.id);
    setError(null);
    try {
      const { board_id } = await api.restoreTrash(entry.id);
      setItems((xs) => (xs ?? []).filter((x) => x.id !== entry.id));
      onRestored(board_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const purge = async (entry: TrashEntry) => {
    setBusy(entry.id);
    setError(null);
    try {
      await api.purgeTrash(entry.id);
      setItems((xs) => (xs ?? []).filter((x) => x.id !== entry.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const empty = async () => {
    setBusy("*");
    try {
      await api.emptyTrash();
      setItems([]);
      setConfirmEmpty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      title="Trash"
      description={`Deleted in the last ${RETENTION_DAYS} days. Restore anything here, or let it go.`}
      onClose={onClose}
      width={620}
      footer={
        items?.length ? (
          confirmEmpty ? (
            <>
              <span className="trash-warn">
                Delete all {items.length} for good? This cannot be undone.
              </span>
              <button className="btn" onClick={() => setConfirmEmpty(false)}>
                Cancel
              </button>
              <button className="btn btn-confirm-danger" onClick={() => void empty()} disabled={busy === "*"}>
                Delete all
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setConfirmEmpty(true)}>
              Empty trash
            </button>
          )
        ) : null
      }
    >
      {error && <p className="trash-error">{error}</p>}

      {items === null && <p className="trash-msg">Loading…</p>}

      {items?.length === 0 && (
        <p className="trash-msg">
          Nothing deleted recently. Anything you remove shows up here for {RETENTION_DAYS} days.
        </p>
      )}

      <ul className="trash-list">
        {(items ?? []).map((entry) => {
          const left = remaining(entry.deleted_at);
          return (
            <li key={entry.id} className="trash-row">
              <span className={`trash-kind ${entry.kind}`}>
                {entry.kind === "board" ? "Mindmap" : entry.node_type ?? "Card"}
              </span>

              <span className="trash-main">
                <span className="trash-label">{entry.label || "Untitled"}</span>
                <span className="trash-meta">
                  {/* A mindmap says what it held; a node says where it lived. */}
                  {entry.kind === "board" ? entry.summary : entry.context}
                  {entry.context && entry.kind === "board" ? ` · ${entry.context}` : ""}
                  {" · "}
                  {whenDeleted(entry.deleted_at)}
                  {" · "}
                  <span className={left.urgent ? "trash-soon" : undefined}>{left.text}</span>
                </span>
              </span>

              <button
                className="btn btn-small"
                onClick={() => void restore(entry)}
                disabled={busy === entry.id}
              >
                Restore
              </button>
              <button
                className="btn btn-small btn-quiet"
                onClick={() => void purge(entry)}
                disabled={busy === entry.id}
                title="Delete for good"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
