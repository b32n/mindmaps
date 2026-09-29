import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api, type Board as BoardT, type Workspace } from "./api";
import { useAuth } from "./AuthContext";
import { Board } from "./Board";
import { Modal } from "./ui/Modal";
import { SettingsDialog } from "./SettingsDialog";
import { TrashDialog } from "./TrashDialog";
import { ArtefactsView } from "./ArtefactsView";
import { MembersPanel } from "./MembersPanel";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { Recall } from "./Recall";
import { IconGear, IconLayers, IconPeople, IconTrash, IconGrip, IconLogout, IconMap, IconMore, IconPlus } from "./ui/Icons";

export function BoardApp() {
  const { user, signOut } = useAuth();
  const [boards, setBoards] = useState<BoardT[]>([]);
  const [revision, setRevision] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  /** false until the first list arrives, so we don't redirect off a valid id */
  const [loaded, setLoaded] = useState(false);

  /**
   * Which mindmap is open lives in the URL, not in state.
   *
   * That is what makes a reload land you back where you were, the back button
   * retrace your steps, and — once mindmaps can be shared — a link mean
   * something to the person you send it to.
   */
  const { boardId } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const current = boardId ?? null;

  /**
   * Artefacts is a sibling of the mindmaps, not one of them.
   *
   * It shares this shell because it shares the rail, but it has no board id, so
   * every piece of board-resolution below has to step aside for it.
   */
  const onArtefacts = pathname === "/artefacts";

  const open = useCallback(
    (id: string, opts: { replace?: boolean; card?: string } = {}) =>
      navigate(`/app/${id}${opts.card ? `?card=${encodeURIComponent(opts.card)}` : ""}`, {
        replace: opts.replace ?? false,
      }),
    [navigate],
  );

  /**
   * Land somewhere real.
   *
   * Covers both `/app` with no id and an id that no longer resolves — a deleted
   * mindmap, or a link from someone whose mindmaps are not yours. Replace
   * rather than push, so Back does not bounce off the dead address.
   */
  useEffect(() => {
    if (!loaded || onArtefacts) return;
    if (current && boards.some((b) => b.id === current)) return;
    if (boards.length) open(boards[0].id, { replace: true });
    else if (current) navigate("/app", { replace: true });
  }, [loaded, onArtefacts, current, boards, open, navigate]);

  /** null = closed, "new" = creating, otherwise the id being edited */
  const [dialog, setDialog] = useState<null | "new" | string>(null);

  /*
   * Which workspace you are in.
   *
   * Kept in localStorage rather than the URL: it is a lens on everything rather
   * than a place, and a board's address should not change because of which
   * workspace you happened to have selected when you copied the link.
   */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsId, setWsId] = useState<string | null>(
    () => localStorage.getItem("mindmaps.workspace"),
  );
  useEffect(() => {
    api.workspaces().then((ws) => {
      setWorkspaces(ws);
      // Fall back to the personal one if the remembered workspace is gone —
      // someone can be removed from a team between visits.
      setWsId((cur) => (cur && ws.some((w) => w.id === cur) ? cur : (ws[0]?.id ?? null)));
    });
  }, []);
  useEffect(() => {
    if (wsId) localStorage.setItem("mindmaps.workspace", wsId);
  }, [wsId]);

  /** null = closed, otherwise the workspace being managed. */
  const [wsDialog, setWsDialog] = useState<Workspace | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  /** id being dragged, and the row it would drop above */
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  /**
   * Reorder locally, then persist the whole list.
   *
   * Optimistic because a rail that lags behind the cursor feels broken; the
   * server takes the full order, so a failed request leaves it stale rather
   * than half-applied, and the next load corrects it.
   */
  function moveBoard(dragId: string, overId: string) {
    if (dragId === overId) return;
    setBoards((bs) => {
      const from = bs.findIndex((b) => b.id === dragId);
      const to = bs.findIndex((b) => b.id === overId);
      if (from < 0 || to < 0) return bs;
      const next = [...bs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      void api.reorderBoards(next.map((b) => b.id)).catch(() => {});
      return next;
    });
  }

  useEffect(() => {
    api
      .listBoards()
      .then((bs) => {
        setBoards(bs);
        setLoaded(true);
      })
      .catch((e) => setErr(e.message));
  }, []);

  async function create(name: string, description: string) {
    const b = await api.createBoard({
      name,
      description: description || null,
      workspace_id: wsId ?? undefined,
    });
    setBoards((bs) => [b, ...bs]);
    open(b.id);
    setDialog(null);
  }

  async function save(
    id: string,
    patch: { name: string; description: string; labels: string[] },
  ) {
    const updated = await api.updateBoard(id, {
      name: patch.name,
      description: patch.description || null,
      labels: patch.labels,
    });
    setBoards((bs) => bs.map((b) => (b.id === id ? updated : b)));
    setRevision((r) => r + 1); // the open board re-reads its own name
    setDialog(null);
  }

  /**
   * Pin, and re-sort the way the server does.
   *
   * Sorted locally rather than refetched: the rail is the thing you just
   * clicked in, and a round trip to watch it move is a flicker for no gain.
   * The comparator has to match the ORDER BY in the boards route or the order
   * changes under you on the next load.
   */
  async function togglePin(id: string) {
    const target = boards.find((b) => b.id === id);
    if (!target) return;
    const pinned = !target.pinned;
    setBoards((bs) =>
      bs
        .map((b) => (b.id === id ? { ...b, pinned } : b))
        .sort(
          (x, y) =>
            Number(y.pinned) - Number(x.pinned) ||
            (x.position ?? Number.MAX_SAFE_INTEGER) - (y.position ?? Number.MAX_SAFE_INTEGER),
        ),
    );
    await api.updateBoard(id, { pinned }).catch(() => {
      // Put it back rather than leaving the rail disagreeing with the server.
      setBoards((bs) => bs.map((b) => (b.id === id ? { ...b, pinned: !pinned } : b)));
    });
  }

  async function remove(id: string) {
    await api.deleteBoard(id);
    // The redirect effect handles moving off a deleted mindmap; doing it here
    // too would race it.
    setBoards((bs) => bs.filter((b) => b.id !== id));
    setDialog(null);
  }

  if (err)
    return (
      <div className="empty">
        <h2>Can't reach the API</h2>
        <p>{err}</p>
        <p>
          Start it with <code>cd worker &amp;&amp; npm run dev</code>
        </p>
      </div>
    );

  /*
   * The mindmaps of the workspace you are in, plus any shared directly with you
   * from elsewhere — those belong to no workspace you are a member of, so they
   * would otherwise be invisible from every one of them.
   */
  const wsIds = new Set(workspaces.map((w) => w.id));
  const current2 = workspaces.find((w) => w.id === wsId) ?? null;
  const shown = wsId
    ? boards.filter((b) => b.workspace_id === wsId || !wsIds.has(b.workspace_id ?? ""))
    : boards;

  const editing = boards.find((b) => b.id === dialog) ?? null;
  /** the id in the URL, but only once we know it is one of ours */
  const resolved = boards.some((b) => b.id === current) ? current : null;

  return (
    <div className="app">
      <Recall />
      <nav className="rail">
        {/* the brand IS the section label here — a separate "Mindmaps" heading
            underneath it would just say the same word twice */}
        <div className="rail-brand">
          <span>mindmaps</span>
          <button className="rail-add" onClick={() => setDialog("new")} title="New mindmap">
            <IconPlus size={16} />
          </button>
        </div>

        {/* A visible way in as well as the shortcut. A palette nobody knows the
            chord for is a feature that does not exist. */}
        <button
          className="rail-search"
          onClick={() =>
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))
          }
          title="Recall (⌘K)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>Recall</span>
          <kbd>⌘K</kbd>
        </button>

        <WorkspaceMenu
          workspaces={workspaces}
          currentId={wsId}
          onSwitch={setWsId}
          onCreated={(w) => {
            setWorkspaces((xs) => [...xs, w]);
            setWsId(w.id);
          }}
          onManage={setWsDialog}
        />

        <div className="rail-list">
          {shown.map((b) => (
            <div
              key={b.id}
              className={[
                "rail-row",
                b.id === current ? "active" : "",
                dragging === b.id ? "dragging" : "",
                dropOn === b.id && dragging !== b.id ? "drop-target" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              // Native HTML5 drag: no library, and it gives us the drag image
              // and cursor for free. The list is short, so the cost of a
              // physics-based reorder library isn't worth paying.
              draggable
              onDragStart={(e) => {
                setDragging(b.id);
                e.dataTransfer.effectAllowed = "move";
                // Firefox refuses to start a drag without payload
                e.dataTransfer.setData("text/plain", b.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropOn(null);
              }}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault(); // required, or the drop never fires
                e.dataTransfer.dropEffect = "move";
                setDropOn(b.id);
              }}
              onDragLeave={() => setDropOn((d) => (d === b.id ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragging ?? e.dataTransfer.getData("text/plain");
                if (id) moveBoard(id, b.id);
                setDragging(null);
                setDropOn(null);
              }}
            >
              <span className="rail-grip" aria-hidden="true">
                <IconGrip size={14} />
              </span>
              <button className="rail-open" onClick={() => open(b.id)} title={b.description || undefined}>
                <span className="dot" data-status={b.status} />
                <span className="rail-name">{b.name}</span>
                {/* Only when this mindmap has been given to someone directly —
                    see `shared_with`. Silent otherwise, so the badge means
                    something when it does appear. */}
                {!!b.shared_with && (
                  <span className="rail-shared" title={`Shared with ${b.shared_with} ${b.shared_with === 1 ? "person" : "people"}`}>
                    <IconPeople size={12} />
                    {b.shared_with}
                  </span>
                )}
              </button>
              {/* Always rendered, not only when pinned: a control that appears
                  on hover is undiscoverable, and one that appears only once
                  used cannot be used a first time. CSS fades it instead. */}
              <button
                className={`rail-pin${b.pinned ? " on" : ""}`}
                title={b.pinned ? "Unpin" : "Pin to top"}
                aria-pressed={b.pinned}
                onClick={() => void togglePin(b.id)}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.6Z"
                    fill={b.pinned ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                className="rail-edit"
                title="Mindmap settings"
                onClick={() => setDialog(b.id)}
              >
                <IconMore size={16} />
              </button>
            </div>
          ))}

          {shown.length === 0 && (
            <p className="rail-empty">Nothing here yet.</p>
          )}
        </div>

        {/* Two flat lists that cut across mindmaps: the things you made, and
            the things you removed. Both below the list of places, because
            neither is a place you spend time in. */}
        <button
          className={`rail-trash${onArtefacts ? " active" : ""}`}
          onClick={() => navigate("/artefacts")}
        >
          <IconLayers size={15} /> Artefacts
        </button>
        <button className="rail-trash" onClick={() => setTrashOpen(true)}>
          <IconTrash size={15} /> Trash
        </button>

        <div className="rail-account">
          <div className="who" title={user?.email}>
            {user?.avatar_url ? (
              <img src={user.avatar_url} alt="" />
            ) : (
              <span className="avatar">
                {(user?.name || user?.email || "?")[0]?.toUpperCase()}
              </span>
            )}
            <span className="who-name">{user?.name || user?.email}</span>
          </div>
          <button className="signout" onClick={() => setSettingsOpen(true)}>
            <IconGear size={15} /> Settings
          </button>
          <button className="signout" onClick={() => void signOut()}>
            <IconLogout size={15} /> Sign out
          </button>
        </div>
      </nav>

      {/* Mount the board only once the id is known to resolve. A URL is user
          input now — anyone can type one — and handing an unknown id to Board
          means a fetch that 404s and an uncaught error on the way to the
          redirect that was going to fix it anyway. */}
      {onArtefacts ? (
        <ArtefactsView onJump={(id: string) => open(id)} />
      ) : resolved ? (
        <Board key={resolved} boardId={resolved} revision={revision} onNavigate={open} />
      ) : loaded && !boards.length ? (
        <div className="empty">
          <IconMap size={30} />
          <h2>No mindmaps yet</h2>
          <p>A mindmap is a canvas: cards that hold documents, connected however you like.</p>
          <button className="btn btn-primary" onClick={() => setDialog("new")}>
            <IconPlus size={16} /> New mindmap
          </button>
        </div>
      ) : null}

      <Modal
        open={!!wsDialog}
        title={wsDialog?.name ?? "Workspace"}
        description="Everyone here can see every mindmap in this workspace."
        onClose={() => setWsDialog(null)}
        width={520}
      >
        {wsDialog && <MembersPanel kind="workspaces" id={wsDialog.id} ownerId={wsDialog.owner_id} />}
      </Modal>

      <SettingsDialog open={settingsOpen} user={user} onClose={() => setSettingsOpen(false)} />

      <TrashDialog
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onRestored={(id) => {
          // A restore can bring back a mindmap or a card on one, so refresh the
          // rail either way and bump the board so it re-reads its contents.
          //
          // Navigate only once the new list has landed. The redirect guard above
          // sends you to the first mindmap whenever the open id is not in
          // `boards`, so navigating first means arriving at a restored mindmap
          // and being bounced straight off it again.
          void api.listBoards().then((bs) => {
            setBoards(bs);
            setRevision((r) => r + 1);
            if (id && bs.some((b) => b.id === id)) open(id);
          });
        }}
      />

      <MindmapDialog
        mode={dialog === "new" ? "new" : editing ? "edit" : null}
        board={editing}
        onClose={() => setDialog(null)}
        onCreate={create}
        onSave={save}
        onDelete={remove}
      />
    </div>
  );
}

function MindmapDialog({
  mode,
  board,
  onClose,
  onCreate,
  onSave,
  onDelete,
}: {
  mode: "new" | "edit" | null;
  board: BoardT | null;
  onClose: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
  onSave: (id: string, patch: { name: string; description: string; labels: string[] }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // reset whenever the dialog opens against a different target
  useEffect(() => {
    setName(mode === "edit" ? board?.name ?? "" : "");
    setDescription(mode === "edit" ? board?.description ?? "" : "");
    setLabels(mode === "edit" ? (board?.labels ?? []) : []);
    setLabelDraft("");
    setConfirming(false);
    setBusy(false);
  }, [mode, board?.id]);

  const addLabel = () => {
    const v = labelDraft.trim().slice(0, 32);
    if (!v) return;
    // Case-insensitive, so "Auth" and "auth" cannot both exist and filter apart.
    if (!labels.some((l) => l.toLowerCase() === v.toLowerCase())) setLabels([...labels, v]);
    setLabelDraft("");
  };

  if (!mode) return null;
  const creating = mode === "new";

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    try {
      if (creating) await onCreate(value, description.trim());
      else if (board)
        await onSave(board.id, { name: value, description: description.trim(), labels });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={creating ? "New mindmap" : "Mindmap settings"}
      description={
        creating ? "A canvas for one line of thinking. You can rename it later." : undefined
      }
      onClose={onClose}
      footer={
        <>
          {!creating && board && (
            <button
              className={confirming ? "btn btn-confirm-danger" : "btn btn-danger"}
              onClick={() => (confirming ? void onDelete(board.id) : setConfirming(true))}
            >
              {confirming ? "Really delete" : "Delete"}
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : creating ? "Create mindmap" : "Save"}
          </button>
        </>
      }
    >
      <form onSubmit={submit} className="field">
        <label htmlFor="mm-name">Name</label>
        <input
          id="mm-name"
          className="input"
          value={name}
          placeholder="PCI 2026"
          onChange={(e) => setName(e.target.value)}
        />

        <label htmlFor="mm-desc">What belongs here</label>
        <textarea
          id="mm-desc"
          className="input mm-desc"
          value={description}
          rows={2}
          placeholder="Session and token work across the four auth services."
          onChange={(e) => setDescription(e.target.value)}
        />
        {/* Said plainly, because the payoff is not obvious from the field. */}
        <p className="field-hint">
          Your agent reads this when deciding where a new card belongs. One sentence about
          what lives here beats a list of what is on it today.
        </p>

        {!creating && (
          <>
            <label htmlFor="mm-label">Labels</label>
            <div className="mm-labels">
              {labels.map((l) => (
                <span className="mm-label" key={l}>
                  {l}
                  <button
                    type="button"
                    onClick={() => setLabels(labels.filter((x) => x !== l))}
                    aria-label={`Remove ${l}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                id="mm-label"
                className="mm-label-input"
                value={labelDraft}
                placeholder={labels.length ? "add…" : "auth, pci, infra…"}
                onChange={(e) => setLabelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addLabel();
                  }
                  // Backspace on an empty box removes the last chip, which is
                  // what every tag input does and what fingers expect.
                  if (e.key === "Backspace" && !labelDraft && labels.length)
                    setLabels(labels.slice(0, -1));
                }}
                onBlur={addLabel}
              />
            </div>

            {/* Sharing lives here rather than behind its own button: the
                settings dialog is already "everything about this mindmap", and
                who can see it belongs in that list. */}
            <label>People</label>
            <MembersPanel kind="boards" id={board!.id} ownerId={board!.id} />
          </>
        )}
      </form>

      {!creating && confirming && (
        <p className="modal-warn">
          This removes the mindmap and everything on it: cards, documents, links and
          ink. It goes to the trash, where you can put it back for 7 days.
        </p>
      )}
    </Modal>
  );
}
