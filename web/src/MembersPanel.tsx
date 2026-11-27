/**
 * Who has access, and how to change it.
 *
 * One component for all three things you can share — a workspace, a mindmap, an
 * artefact — because the question is identical and only the noun differs. The
 * server enforces who may hand out access; this only has to be honest about
 * what each role means.
 *
 * Deliberately plain about the invite outcomes. Inviting someone to a
 * workspace never adds them: they get an invitation and become a member when
 * they accept it. A mindmap or artefact shared with an existing account is
 * theirs straight away. For someone with no account the invitation waits until
 * they sign up with that address, and then for them to accept. Those are
 * different enough that a shared "invited!" message would mislead.
 */

import { useCallback, useEffect, useState } from "react";
import { api, type Member, type PendingInvite } from "./api";

type Kind = "workspaces" | "boards" | "artefacts";

const NOUN: Record<Kind, string> = {
  workspaces: "workspace",
  boards: "mindmap",
  artefacts: "artefact",
};

type MyRole = "owner" | "admin" | "editor" | "viewer";

const LABEL: Record<MyRole, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Can edit",
  viewer: "Can view",
};

export function MembersPanel({
  kind,
  id,
  ownerId,
  myRole: initialRole,
  onTransferred,
}: {
  kind: Kind;
  id: string;
  /** Shown as the owner row, which no membership table contains. */
  ownerId?: string;
  /** Workspaces: the viewer's role, which decides what the rows offer. */
  myRole?: MyRole;
  /** Called after ownership moves, so the caller can refresh its own copy of the roles. */
  onTransferred?: () => void;
}) {
  const [myRole, setMyRole] = useState<MyRole | undefined>(initialRole);
  const [owner, setOwner] = useState<{ user_id: string; email: string; name: string | null } | null>(null);
  // the member a "Make owner" is waiting on a confirmation for
  const [confirming, setConfirming] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("editor");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .members(kind, id)
      .then((r) => {
        setMembers(r.members);
        setPending(r.pending);
        setOwner(r.owner ?? null);
      })
      .catch((e) => setError((e as Error).message));
  }, [kind, id]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    const addr = email.trim();
    if (!addr) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.addMember(kind, id, addr, role);
      setEmail("");
      // The two outcomes read differently on purpose: one is finished, the
      // other is waiting on the other person.
      setNote(
        r.added
          ? `${r.added.email} now has access.`
          : r.invited?.existing
            ? `Invited ${r.invited.email}. They become a member when they accept.`
            : `Invited ${r.invited?.email}. They can accept once they sign up with that address.`,
      );
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId: string) => {
    setMembers((xs) => (xs ?? []).filter((m) => m.user_id !== userId));
    try {
      await api.removeMember(kind, id, userId);
    } catch (e) {
      setError((e as Error).message);
      load();
    }
  };

  const changeRole = async (userId: string, next: "admin" | "editor" | "viewer") => {
    setError(null);
    try {
      await api.setMemberRole(id, userId, next);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  };

  const transfer = async (userId: string) => {
    setError(null);
    setNote(null);
    try {
      await api.transferWorkspace(id, userId);
      setConfirming(null);
      // This person is an admin now; the rows must stop offering owner powers.
      setMyRole("admin");
      onTransferred?.();
    } catch (e) {
      setError((e as Error).message);
      setConfirming(null);
    }
    load();
  };

  const revoke = async (token: string) => {
    setPending((xs) => xs.filter((p) => p.token !== token));
    try {
      await api.revokeInvite(token);
    } catch (e) {
      setError((e as Error).message);
      load();
    }
  };

  return (
    <div className="members">
      <div className="members-add">
        <input
          className="members-email"
          type="email"
          value={email}
          placeholder="Email address"
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <select
          className="members-role"
          value={role}
          onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
        >
          <option value="editor">Can edit</option>
          <option value="viewer">Can view</option>
        </select>
        <button className="btn btn-primary" onClick={() => void add()} disabled={busy || !email.trim()}>
          Invite
        </button>
      </div>

      {note && <p className="members-note">{note}</p>}
      {error && <p className="trash-error">{error}</p>}

      <ul className="members-list">
        {kind === "workspaces" && owner ? (
          <li className="members-row" data-testid="owner-row">
            <span className="members-who">
              {myRole === "owner" ? "You" : owner.name || owner.email}
              {myRole !== "owner" && owner.name && <span className="members-email-quiet">{owner.email}</span>}
            </span>
            <span className="members-what">Owner</span>
          </li>
        ) : (
          ownerId && (
            <li className="members-row">
              <span className="members-who">You</span>
              <span className="members-what">Owner</span>
            </li>
          )
        )}

        {(members ?? []).map((m) => {
          const who = m.name || m.email;
          // Workspace rows carry role controls for whoever may use them: owners
          // for everyone, admins for editors and viewers only.
          const manage =
            kind === "workspaces" && (myRole === "owner" || (myRole === "admin" && m.role !== "admin"));
          return (
            <li key={m.user_id} className="members-row">
              <span className="members-who">
                {who}
                {m.name && <span className="members-email-quiet">{m.email}</span>}
              </span>
              {confirming === m.user_id ? (
                <>
                  <span className="members-what">
                    Make {who} the owner? You will become an admin.
                  </span>
                  <button className="btn btn-small btn-danger" onClick={() => void transfer(m.user_id)}>
                    Confirm transfer
                  </button>
                  <button className="btn btn-small btn-quiet" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {manage ? (
                    <select
                      className="members-role"
                      aria-label={`Role for ${who}`}
                      value={m.role === "owner" ? "editor" : m.role}
                      onChange={(e) => void changeRole(m.user_id, e.target.value as "admin" | "editor" | "viewer")}
                    >
                      <option value="editor">Can edit</option>
                      <option value="viewer">Can view</option>
                      {myRole === "owner" && <option value="admin">Admin</option>}
                    </select>
                  ) : (
                    <span className="members-what">{LABEL[m.role]}</span>
                  )}
                  {kind === "workspaces" && myRole === "owner" && (
                    <button className="btn btn-small btn-quiet" onClick={() => setConfirming(m.user_id)}>
                      Make owner
                    </button>
                  )}
                  {(kind !== "workspaces" || manage) && (
                    <button className="btn btn-small btn-quiet" onClick={() => void remove(m.user_id)}>
                      Remove
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}

        {pending.map((p) => (
          <li key={p.token} className="members-row pending">
            <span className="members-who">
              {p.email}
              <span className="members-email-quiet">
                {p.has_account ? "waiting for them to accept" : "waiting for them to sign up"}
              </span>
            </span>
            <span className="members-what">{p.role === "editor" ? "Can edit" : "Can view"}</span>
            <button className="btn btn-small btn-quiet" onClick={() => void revoke(p.token)}>
              Cancel
            </button>
          </li>
        ))}
      </ul>

      {members !== null && members.length === 0 && pending.length === 0 && (
        <p className="members-note">
          Only you can see this {NOUN[kind]}. Invite someone by email to share it.
        </p>
      )}
    </div>
  );
}
