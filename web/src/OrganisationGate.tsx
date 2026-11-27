/**
 * Creating the organisation, and the pages for people who are not in it yet.
 *
 * The same two steps appear in two places: as a full page on an org-mode
 * instance's first run (there is nothing behind it to put a dialog over), and
 * as a dialog from the workspace menu on a multitenant one. What the server
 * allows is decided in worker/src/organisation.ts; this only has to be honest
 * about it, so nothing here offers a thing the server will refuse.
 */

import { useState } from "react";
import { api, type MyInvite, type OrganisationInfo, type Workspace } from "./api";
import { useAuth } from "./AuthContext";
import { MembersPanel } from "./MembersPanel";
import { Modal } from "./ui/Modal";

/** Step one: a name, or (org mode, existing workspaces) one the owner already has. */
function NameStep({
  adoptable,
  busy,
  error,
  onCreate,
  onAdopt,
}: {
  adoptable: { id: string; name: string }[];
  busy: boolean;
  error: string | null;
  onCreate: (name: string) => void;
  onAdopt: (id: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <>
      <div className="field">
        <label htmlFor="org-name">Organisation name</label>
        <input
          id="org-name"
          className="input"
          value={name}
          placeholder="Acme Ltd"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && onCreate(name)}
        />
        <p className="field-hint">Everyone you invite sees every mindmap in it. You can rename it later.</p>
      </div>
      {error && <p className="trash-error">{error}</p>}
      {adoptable.length > 0 && (
        <div className="org-adopt">
          <p className="field-hint">
            Or make a workspace you already own the organisation. Its people and mindmaps stay exactly as they are.
          </p>
          {adoptable.map((w) => (
            <button
              key={w.id}
              className="btn btn-small"
              disabled={busy}
              aria-label={`Use ${w.name} as the organisation`}
              onClick={() => onAdopt(w.id)}
            >
              Use {w.name}
            </button>
          ))}
        </div>
      )}
      <div className="org-actions">
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => onCreate(name)}>
          Create organisation
        </button>
      </div>
    </>
  );
}

/** Step two: people. Skippable; anyone can be invited later from the workspace menu. */
function InviteStep({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  return (
    <>
      <MembersPanel kind="workspaces" id={workspace.id} ownerId={workspace.owner_id} myRole="owner" />
      <p className="field-hint">They become members when they accept. You can invite more people at any time.</p>
      <div className="org-actions">
        <button className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </>
  );
}

/** The org-mode first run, as a page: set up, then invite. */
export function OrganisationSetup({
  info,
  onCreated,
  onDone,
}: {
  info: OrganisationInfo;
  /** The organisation exists; the page keeps showing the invite step until Done. */
  onCreated: (w: Workspace) => void;
  onDone: () => void;
}) {
  const [made, setMade] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (body: { name?: string; workspace_id?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const w = await api.createOrganisation(body);
      setMade(w);
      onCreated(w);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="org-page">
      <div className="org-card org-onboarding">
        {made ? (
          <>
            <h1>Invite your team</h1>
            <p className="org-lede">
              <strong>{made.name}</strong> is ready. Add the people who should be in it.
            </p>
            <InviteStep workspace={made} onDone={onDone} />
          </>
        ) : (
          <>
            <h1>Set up your organisation</h1>
            <p className="org-lede">
              You are the first account here, so you are the owner. Name the organisation; everyone else joins it by
              invitation.
            </p>
            <NameStep
              adoptable={info.adoptable}
              busy={busy}
              error={error}
              onCreate={(name) => void go({ name })}
              onAdopt={(workspace_id) => void go({ workspace_id })}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Create an organisation from the workspace menu (multitenant). A dialog with
 * the same two steps; closing it after the first one is the same as Done.
 */
export function CreateOrganisationDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (w: Workspace) => void;
}) {
  const [made, setMade] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setMade(null);
    setError(null);
    onClose();
  };

  const create = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      const w = await api.createOrganisation({ name });
      setMade(w);
      onCreated(w);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (made)
    return (
      <Modal open={open} title="Invite your team" description={`${made.name} is ready. Add the people who should be in it.`} onClose={close} width={520}>
        <InviteStep workspace={made} onDone={close} />
      </Modal>
    );

  return (
    <Modal
      open={open}
      title="Create organisation"
      description="A shared space for a team. You are its owner."
      onClose={close}
      width={440}
      footer={
        <>
          <span className="ws-spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
        </>
      }
    >
      <NameStep adoptable={[]} busy={busy} error={error} onCreate={(n) => void create(n)} onAdopt={() => {}} />
    </Modal>
  );
}

/**
 * An org-mode instance, for someone who is not in its organisation: told how to
 * get in, never offered a way to make one. Invitations waiting for them are
 * answered here, which is the only way in.
 */
export function OrganisationWaiting({
  info,
  invites,
  onAnswered,
}: {
  info: OrganisationInfo;
  invites: MyInvite[];
  onAnswered: (invite: MyInvite, accepted: boolean) => void;
}) {
  const { user, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notReady = info.state === "waiting";
  const mine = invites.filter((i) => i.target_type === "workspace");

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

  return (
    <div className="org-page">
      <div className="org-card org-gate">
        {mine.length > 0 ? (
          <h1>You're invited</h1>
        ) : notReady ? (
          <h1>The organisation isn't set up yet</h1>
        ) : (
          <h1>Ask your admin for an invite</h1>
        )}
        {mine.length > 0 ? (
          <ul className="org-invites">
            {mine.map((i) => (
              <li key={i.token}>
                <span>
                  <strong>{i.invited_by.name || i.invited_by.email}</strong> invited you to <strong>{i.target_name}</strong>
                </span>
                <span className="org-invite-actions">
                  <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void answer(i, true)}>
                    Accept
                  </button>
                  <button className="btn btn-small btn-quiet" disabled={busy} onClick={() => void answer(i, false)}>
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : notReady ? (
          <p className="org-lede">
            Whoever set this instance up has not created its organisation yet. Come back once they have, and ask them to
            invite <strong>{user?.email}</strong>.
          </p>
        ) : (
          <p className="org-lede">
            You are signed in as <strong>{user?.email}</strong>, but you are not in{" "}
            <strong>{info.organisation_name ?? "the organisation"}</strong>. Ask an admin to invite that address; the
            invitation shows up here and you join by accepting it.
          </p>
        )}
        {error && <p className="trash-error">{error}</p>}
        <div className="org-actions">
          <button className="btn btn-quiet" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
