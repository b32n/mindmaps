import { useEffect, useState } from "react";
import { auth, type Connection, type User } from "./api";
import { Modal } from "./ui/Modal";
import { useModePolicy } from "./policy";

/**
 * Account settings.
 *
 * The one setting originally wanted here — "open cards scrolled to the bottom" —
 * ended up on the card instead, because it describes a particular card (a
 * running log) rather than the whole account. What genuinely belongs at this
 * level is the list of harnesses holding an OAuth token, which until now could
 * only be revoked with a curl command. Since then the two things an account
 * owes its owner: a way to take everything out, and a way to leave.
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
  const { teamSpaces } = useModePolicy();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the delete-account form: closed, or open with what has been typed so far
  const [deleting, setDeleting] = useState<{ typed: string; busy: boolean; error: string | null } | null>(null);

  // shared workspaces this account owns that other people are in
  const [blockers, setBlockers] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (!open) return;
    setBlockers([]);
    auth.deleteBlockers().then((r) => setBlockers(r.workspaces)).catch(() => {});
    setConnections(null);
    setError(null);
    setDeleting(null);
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

  async function deleteAccount() {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true, error: null });
    try {
      await auth.deleteAccount(deleting.typed.trim());
      // A full navigation rather than a route change: nothing in memory should
      // outlive the account, and the sign-in page must load with no session.
      window.location.assign("/login?notice=deleted");
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        // Refused because of a shared workspace: say so once, in the warning
        // above the button, and close the confirmation that can no longer work.
        setDeleting(null);
        auth.deleteBlockers().then((r) => setBlockers(r.workspaces)).catch(() => {});
        return;
      }
      setDeleting({ ...deleting, busy: false, error: (e as Error).message });
    }
  }

  if (!open) return null;

  const matches =
    !!user && !!deleting && deleting.typed.trim().toLowerCase() === user.email.toLowerCase();

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

      <section className="set-block">
        <h3>Your data</h3>
        <p className="set-hint">
          Download everything you own as one zip: your mindmaps, cards, links, sheets,
          documents, decks, pages, files and images, with their version history. What
          other people have shared with you is listed by reference only.
        </p>
        <div>
          <a className="btn" href={auth.exportUrl} download>
            Download my data
          </a>
        </div>
      </section>

      <section className="set-block">
        <h3>Delete account</h3>
        <p className="set-hint">
          Deletes your account and everything you own, and ends every session and
          connected app at once. Anything you have shared with others stops working.
          This cannot be undone; download your data first if you want a copy.
        </p>
        {blockers.length > 0 && (
          <div className="modal-warn" data-testid="delete-blockers">
            <p>
              You can't delete your account yet. You own{" "}
              {blockers.map((w) => `“${w.name}”`).join(", ")}, and other people are in{" "}
              {blockers.length === 1 ? "it" : "them"}.{" "}
              {teamSpaces
                ? "Transfer ownership to another member (open the workspace menu, then People, then Make owner), or remove the members, then come back."
                : "Team spaces are hidden on this instance (personal mode). Switch it to org to open them, transfer ownership to another member or remove the members, then come back."}
            </p>
          </div>
        )}
        {!deleting && (
          <div>
            <button
              className="btn btn-danger"
              disabled={blockers.length > 0}
              onClick={() => setDeleting({ typed: "", busy: false, error: null })}
            >
              Delete account…
            </button>
          </div>
        )}
        {deleting && (
          <form
            className="set-confirm"
            onSubmit={(e) => {
              e.preventDefault();
              if (matches && !deleting.busy) void deleteAccount();
            }}
          >
            <label>
              Type your email address ({user?.email}) to confirm
              <input
                type="email"
                value={deleting.typed}
                autoComplete="off"
                autoFocus
                onChange={(e) => setDeleting({ ...deleting, typed: e.target.value, error: null })}
              />
            </label>
            {deleting.error && <p className="modal-warn">{deleting.error}</p>}
            <div className="set-confirm-actions">
              <button
                type="submit"
                className="btn btn-confirm-danger"
                disabled={!matches || deleting.busy}
              >
                {deleting.busy ? "Deleting…" : "Delete my account"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={deleting.busy}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
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
