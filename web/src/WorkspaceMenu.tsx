/**
 * The workspace switcher.
 *
 * A custom menu rather than a `<select>`, because a workspace row carries more
 * than a name: whether it is your personal one, what you can do in it, and
 * which you are looking at now. A native select can show one line of text and
 * nothing else, and it renders in the platform's style rather than the app's.
 *
 * Creating a workspace opens the same kind of dialog as everything else here.
 * It was a `window.prompt`, which is faster to write and looks like a browser
 * error box in the middle of an otherwise designed app.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth, useMode } from "./AuthContext";
import { api, type ClosedWorkspace, type MyInvite, type Workspace } from "./api";
import { CreateOrganisationDialog } from "./OrganisationGate";
import { Modal } from "./ui/Modal";
import { IconCheck, IconLogout, IconPeople, IconPlus } from "./ui/Icons";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", editor: "Can edit", viewer: "Can view" } as const;
const NOUN = { workspace: "the workspace", board: "the mindmap", node: "the artefact" } as const;

export function WorkspaceMenu({
  workspaces,
  currentId,
  invites,
  onSwitch,
  onCreated,
  onManage,
  onLeft,
  onReopened,
  onAnswered,
}: {
  workspaces: Workspace[];
  currentId: string | null;
  /** Invitations waiting for this person. Nothing joins until one is accepted. */
  invites: MyInvite[];
  onSwitch: (id: string) => void;
  onCreated: (w: Workspace) => void;
  /** Opens the members panel. Absent for a personal workspace. */
  onManage: (w: Workspace) => void;
  /** After leaving a workspace, so the caller can drop it and move off it. */
  onLeft: (w: Workspace) => void;
  /** After the owner reopens a closed workspace. */
  onReopened: () => void;
  /** After an invitation is accepted or declined. */
  onAnswered: (invite: MyInvite, accepted: boolean) => void;
}) {
  const { user } = useAuth();
  // Only a multitenant instance lets people make shared spaces: a personal one
  // has none, and an org-mode one has its single organisation.
  const canCreate = useMode() === "multitenant";
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [leaving, setLeaving] = useState<Workspace | null>(null);
  const [closed, setClosed] = useState<ClosedWorkspace[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0] ?? null;

  // Escape closes, and so does a click anywhere else. A menu that survives
  // either is a menu you have to fight.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  // The owner's closed workspaces, read when the menu opens: it is a list
  // nobody needs until they go looking for it, so it is not worth a request on
  // every page load.
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .closedWorkspaces()
      .then((rows) => live && setClosed(rows.filter((r) => r.reopenable)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, workspaces.length]);

  const answer = async (invite: MyInvite, accept: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (accept) await api.acceptInvite(invite.token);
      else await api.declineInvite(invite.token);
      onAnswered(invite, accept);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reopen = async (w: ClosedWorkspace) => {
    setBusy(true);
    setError(null);
    try {
      await api.reopenWorkspace(w.id);
      setClosed((xs) => xs.filter((x) => x.id !== w.id));
      onReopened();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!leaving) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeMember("workspaces", leaving.id, user!.id);
      const left = leaving;
      setLeaving(null);
      onLeft(left);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const w = await api.createWorkspace(trimmed);
      onCreated(w);
      setCreating(false);
      setName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const label = (w: Workspace) => (w.personal ? "Personal" : w.name);

  return (
    <div className="ws" ref={wrap}>
      <button
        className={`ws-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="ws-name">{current ? label(current) : "Workspace"}</span>
        {invites.length > 0 && (
          <span className="ws-badge" title="Invitations waiting for you">
            {invites.length}
          </span>
        )}
        <svg className="ws-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="ws-menu" role="menu">
          {workspaces.map((w) => (
            <button
              key={w.id}
              role="menuitem"
              className={`ws-item${w.id === currentId ? " on" : ""}`}
              onClick={() => {
                onSwitch(w.id);
                setOpen(false);
              }}
            >
              <span className="ws-check">{w.id === currentId && <IconCheck size={13} />}</span>
              <span className="ws-item-main">
                <span className="ws-item-name">{label(w)}</span>
                {/* Personal needs no role: there is only ever one of you in it. */}
                {!w.personal && <span className="ws-item-role">{ROLE_LABEL[w.role]}</span>}
              </span>
              {!w.personal && (w.role === "owner" || w.role === "admin") && (
                <span
                  className="ws-item-people"
                  title="People"
                  onClick={(e) => {
                    e.stopPropagation();
                    onManage(w);
                    setOpen(false);
                  }}
                >
                  <IconPeople size={13} />
                </span>
              )}
              {/* Any member but the owner can leave. The owner transfers first,
                  so the control is not offered rather than offered and refused. */}
              {!w.personal && w.role !== "owner" && (
                <span
                  className="ws-item-leave"
                  title="Leave workspace"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLeaving(w);
                    setError(null);
                    setOpen(false);
                  }}
                >
                  <IconLogout size={13} />
                </span>
              )}
            </button>
          ))}

          {invites.length > 0 && (
            <>
              <div className="ws-sep" />
              <div className="ws-section">Invitations</div>
              {invites.map((i) => (
                <div className="ws-invite" key={i.token}>
                  <span className="ws-invite-what">
                    <strong>{i.invited_by.name || i.invited_by.email}</strong> invited you to{" "}
                    {i.target_type === "workspace" ? "" : `${NOUN[i.target_type]} `}
                    <strong>{i.target_name}</strong>
                    <span className="ws-item-role"> · {ROLE_LABEL[i.role]}</span>
                  </span>
                  <span className="ws-invite-actions">
                    <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void answer(i, true)}>
                      Accept
                    </button>
                    <button className="btn btn-small btn-quiet" disabled={busy} onClick={() => void answer(i, false)}>
                      Decline
                    </button>
                  </span>
                </div>
              ))}
            </>
          )}

          {closed.length > 0 && (
            <>
              <div className="ws-sep" />
              <div className="ws-section">Closed workspaces</div>
              {closed.map((w) => (
                <div className="ws-closed-row" key={w.id}>
                  <span className="ws-invite-what">
                    {w.name}
                    <span className="ws-item-role">
                      {" "}
                      · Reopen until {new Date(w.reopen_until).toLocaleDateString()}
                    </span>
                  </span>
                  <button className="btn btn-small" disabled={busy} onClick={() => void reopen(w)}>
                    Reopen
                  </button>
                </div>
              ))}
            </>
          )}
          {error && <p className="trash-error">{error}</p>}

          {canCreate && (
            <>
              <div className="ws-sep" />

              <button
                role="menuitem"
                className="ws-item ws-new"
                onClick={() => {
                  setOpen(false);
                  setCreatingOrg(true);
                }}
              >
                <span className="ws-check">
                  <IconPlus size={13} />
                </span>
                <span className="ws-item-main">
                  <span className="ws-item-name">Create organisation</span>
                </span>
              </button>
              <button
                role="menuitem"
                className="ws-item ws-new"
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
              >
                <span className="ws-check">
                  <IconPlus size={13} />
                </span>
                <span className="ws-item-main">
                  <span className="ws-item-name">New workspace</span>
                </span>
              </button>
            </>
          )}
        </div>
      )}

      <CreateOrganisationDialog
        open={creatingOrg}
        onClose={() => setCreatingOrg(false)}
        onCreated={onCreated}
      />

      <Modal
        open={creating}
        title="New workspace"
        description="A shared space. Everyone you invite sees every mindmap in it."
        onClose={() => setCreating(false)}
        width={420}
        footer={
          <>
            <span className="ws-spacer" />
            <button className="btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void create()}
              disabled={busy || !name.trim()}
            >
              Create
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="ws-name">Name</label>
          <input
            id="ws-name"
            className="input"
            value={name}
            placeholder="Platform team"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <p className="field-hint">
            Your personal mindmaps stay where they are. You can move one here later, or
            start something new.
          </p>
        </div>
        {error && <p className="trash-error">{error}</p>}
      </Modal>

      <Modal
        open={!!leaving}
        title={`Leave ${leaving?.name ?? ""}`}
        description="You will lose access to its mindmaps. An owner or admin can invite you again."
        onClose={() => setLeaving(null)}
        width={420}
        footer={
          <>
            <span className="ws-spacer" />
            <button className="btn" onClick={() => setLeaving(null)}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={() => void leave()} disabled={busy}>
              Leave workspace
            </button>
          </>
        }
      >
        {error && <p className="trash-error">{error}</p>}
      </Modal>
    </div>
  );
}
