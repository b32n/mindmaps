/**
 * Who has access, and how to change it.
 *
 * One component for all three things you can share — a workspace, a mindmap, an
 * artefact — because the question is identical and only the noun differs. The
 * server enforces who may hand out access; this only has to be honest about
 * what each role means.
 *
 * Deliberately plain about the two invite outcomes. Inviting someone who
 * already has an account adds them straight away; inviting someone who does not
 * leaves a pending row until they sign up with that address. Those are
 * different enough that a shared "invited!" message would mislead: one is done,
 * the other is waiting on someone else.
 */

import { useCallback, useEffect, useState } from "react";
import { api, type Member, type PendingInvite } from "./api";

type Kind = "workspaces" | "boards" | "artefacts";

const NOUN: Record<Kind, string> = {
  workspaces: "workspace",
  boards: "mindmap",
  artefacts: "artefact",
};

export function MembersPanel({
  kind,
  id,
  ownerId,
}: {
  kind: Kind;
  id: string;
  /** Shown as the owner row, which no membership table contains. */
  ownerId?: string;
}) {
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
          : `Invited ${r.invited?.email}. They will get access when they sign up with that address.`,
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
        {ownerId && (
          <li className="members-row">
            <span className="members-who">You</span>
            <span className="members-what">Owner</span>
          </li>
        )}

        {(members ?? []).map((m) => (
          <li key={m.user_id} className="members-row">
            <span className="members-who">
              {m.name || m.email}
              {m.name && <span className="members-email-quiet">{m.email}</span>}
            </span>
            <span className="members-what">{m.role === "editor" ? "Can edit" : "Can view"}</span>
            <button className="btn btn-small btn-quiet" onClick={() => void remove(m.user_id)}>
              Remove
            </button>
          </li>
        ))}

        {pending.map((p) => (
          <li key={p.token} className="members-row pending">
            <span className="members-who">
              {p.email}
              <span className="members-email-quiet">waiting for them to sign up</span>
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
          Only you can see this {NOUN[kind]}. Anyone you invite gets access the next time
          they sign in.
        </p>
      )}
    </div>
  );
}
