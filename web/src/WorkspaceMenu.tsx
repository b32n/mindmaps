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
import { api, type Workspace } from "./api";
import { Modal } from "./ui/Modal";
import { IconCheck, IconPeople, IconPlus } from "./ui/Icons";

export function WorkspaceMenu({
  workspaces,
  currentId,
  onSwitch,
  onCreated,
  onManage,
}: {
  workspaces: Workspace[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onCreated: (w: Workspace) => void;
  /** Opens the members panel. Absent for a personal workspace. */
  onManage: (w: Workspace) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
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
                {!w.personal && (
                  <span className="ws-item-role">
                    {w.role === "owner" ? "Owner" : w.role === "editor" ? "Can edit" : "Can view"}
                  </span>
                )}
              </span>
              {!w.personal && w.role === "owner" && (
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
            </button>
          ))}

          <div className="ws-sep" />

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
        </div>
      )}

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
    </div>
  );
}
