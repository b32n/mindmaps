/**
 * The two things an owner or admin does to a workspace itself, as opposed to
 * its people: rename it, and (owner only) close it.
 *
 * Closing asks twice. It is soft, and says so, but it takes the workspace away
 * from everyone in it at once, which is worth a second click.
 */

import { useState } from "react";
import { api, type Workspace } from "./api";

export function RenameWorkspace({ workspace, onRenamed }: { workspace: Workspace; onRenamed: (name: string, updatedAt: number) => void }) {
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = name.trim() !== workspace.name;

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.renameWorkspace(workspace.id, name);
      setName(r.name);
      onRenamed(r.name, r.updated_at);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws-admin">
      <label htmlFor="ws-rename">Workspace name</label>
      <div className="ws-admin-row">
        <input
          id="ws-rename"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
        />
        <button className="btn" onClick={() => void save()} disabled={busy || !dirty}>
          Rename
        </button>
      </div>
      {error && <p className="trash-error">{error}</p>}
    </div>
  );
}

export function CloseWorkspace({ workspace, onClosed }: { workspace: Workspace; onClosed: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.closeWorkspace(workspace.id);
      onClosed();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="ws-admin ws-admin-close">
      {asking ? (
        <>
          <p className="members-note">
            Close {workspace.name}? Everyone loses access to it and its mindmaps straight away. Nothing is
            deleted: you can reopen it within 30 days from the workspace menu.
          </p>
          <div className="ws-admin-row">
            <button className="btn btn-danger" onClick={() => void close()} disabled={busy}>
              Yes, close it
            </button>
            <button className="btn btn-quiet" onClick={() => setAsking(false)} disabled={busy}>
              Keep it open
            </button>
          </div>
        </>
      ) : (
        <button className="btn btn-danger" onClick={() => setAsking(true)}>
          Close workspace
        </button>
      )}
      {error && <p className="trash-error">{error}</p>}
    </div>
  );
}
