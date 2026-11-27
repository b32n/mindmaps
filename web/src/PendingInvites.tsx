import { useState } from "react";
import { api, type MyInvite } from "./api";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", editor: "Can edit", viewer: "Can view" } as const;
const NOUN = { workspace: "the workspace", board: "the mindmap", node: "the artefact" } as const;

/**
 * Invitations waiting for this person, where there is no workspace menu to hold
 * them (personal mode hides it). A mindmap or artefact someone shared by email
 * is joined only by accepting it, so without this the invitation could not be
 * answered at all.
 */
export function PendingInvites({
  invites,
  onAnswered,
}: {
  invites: MyInvite[];
  onAnswered: (invite: MyInvite, accepted: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!invites.length) return null;

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
    <div className="rail-invites" role="region" aria-label="Invitations">
      <div className="ws-section">Invitations</div>
      {invites.map((i) => (
        <div className="ws-invite" key={i.token}>
          <span className="ws-invite-what">
            <strong>{i.invited_by.name || i.invited_by.email}</strong> invited you to {NOUN[i.target_type]}{" "}
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
      {error && <p className="trash-error">{error}</p>}
    </div>
  );
}
