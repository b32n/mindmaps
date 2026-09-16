import { useEffect, useState } from "react";
import { auth, type Connection, type User } from "./api";
import { Modal } from "./ui/Modal";

/**
 * Account settings.
 *
 * The one setting originally wanted here — "open cards scrolled to the bottom" —
 * ended up on the card instead, because it describes a particular card (a
 * running log) rather than the whole account. What genuinely belongs at this
 * level is the list of harnesses holding an OAuth token, which until now could
 * only be revoked with a curl command.
 */
export function SettingsDialog({
  open,
  user,
  onClose,
}: {
  open: boolean;
  user: User | null;
  onClose: () => void;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setConnections(null);
    setError(null);
    auth
      .connections()
      .then(setConnections)
      .catch((e) => {
        setConnections([]);
        setError(e.message);
      });
  }, [open]);

  async function disconnect(c: Connection) {
    setBusy(c.client_id);
    try {
      await auth.disconnect(c.client_id);
      setConnections((cs) => (cs ?? []).filter((x) => x.client_id !== c.client_id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;

  return (
    <Modal open title="Settings" onClose={onClose} width={520}>
      <section className="set-block">
        <h3>Account</h3>
        <dl className="set-facts">
          <dt>Name</dt>
          <dd>{user?.name || "Not set"}</dd>
          <dt>Email</dt>
          <dd>{user?.email}</dd>
        </dl>
      </section>

      <section className="set-block">
        <h3>Connected apps</h3>
        <p className="set-hint">
          Agent harnesses holding an access token for your mindmaps. Disconnecting
          revokes it immediately; the app can ask for access again.
        </p>

        {error && <p className="modal-warn">{error}</p>}

        {connections === null && <p className="set-empty">Loading…</p>}

        {connections?.length === 0 && !error && (
          <p className="set-empty">
            Nothing connected yet. Add this server to a harness with
            <code>claude mcp add --transport http mindmaps {location.origin}/mcp</code>
          </p>
        )}

        {connections?.map((c) => (
          <div className="set-row" key={c.client_id}>
            <div className="set-row-main">
              <span className="set-row-name">{c.client_name || "Unnamed app"}</span>
              <span className="set-row-meta">
                {c.scope?.includes("write") ? "Read and write" : "Read only"} · last used{" "}
                {relative(c.last_seen)}
              </span>
            </div>
            <button
              className="btn btn-danger"
              disabled={busy === c.client_id}
              onClick={() => void disconnect(c)}
            >
              {busy === c.client_id ? "…" : "Disconnect"}
            </button>
          </div>
        ))}
      </section>
    </Modal>
  );
}

/** Coarse on purpose: "3 days ago" is the useful precision for this list. */
function relative(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
