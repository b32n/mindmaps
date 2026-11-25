/**
 * What the organisation's policy and SSO ask of the signed-in person.
 *
 * Join: an organisation whose verified domain covers their address offers a
 * Join step. It is a button, never something that happens on sign-in. When the
 * address is not yet proven (a password sign-up), the offer is not shown, only
 * a line saying proving it would unlock one.
 *
 * Locked: an organisation that requires SSO says so, with the way in.
 */

import { useCallback, useEffect, useState } from "react";
import { api, auth, type JoinOffer, type Workspace } from "./api";
import { useAuth } from "./AuthContext";

export function JoinBanner({ onJoined }: { onJoined: (workspaceId: string) => void }) {
  const [offers, setOffers] = useState<JoinOffer[]>([]);
  const [unproven, setUnproven] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.joinOffers().then((r) => {
      setOffers(r.offers);
      setUnproven(r.unproven);
    }).catch(() => {});
  }, []);

  const join = useCallback(
    async (o: JoinOffer) => {
      setBusy(true);
      setError(null);
      try {
        await api.joinOrganisation(o.workspace_id);
        setOffers((xs) => xs.filter((x) => x.workspace_id !== o.workspace_id));
        onJoined(o.workspace_id);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [onJoined],
  );

  if (!offers.length && !unproven) return null;
  return (
    <div className="join-banner" role="region" aria-label="Join your organisation">
      {offers.map((o) => (
        <div key={o.workspace_id} className="join-offer">
          <span>
            You can join <strong>{o.name}</strong> as {o.role === "editor" ? "an editor" : "a viewer"}.
          </span>
          <button className="btn btn-small btn-primary" disabled={busy} aria-label={`Join ${o.name}`} onClick={() => void join(o)}>
            Join
          </button>
        </div>
      ))}
      {!offers.length && unproven && (
        <span>Your address belongs to an organisation here. Sign in with Google or SSO to prove it and you can join.</span>
      )}
      {error && <span className="trash-error">{error}</span>}
    </div>
  );
}

/** Organisations that require SSO of this session: say so, and offer the way in. */
export function LockedNotice({ workspaces }: { workspaces: Workspace[] }) {
  const { user } = useAuth();
  const locked = workspaces.filter((w) => w.sso_required);
  const [error, setError] = useState<string | null>(null);
  if (!locked.length || !user) return null;
  const go = async () => {
    try {
      window.location.assign((await auth.ssoStart(user.email)).url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="join-banner" role="region" aria-label="Single sign-on required">
      <span>{locked.map((w) => w.name).join(", ")} requires single sign-on.</span>
      <button className="btn btn-small" onClick={() => void go()}>Sign in with SSO</button>
      {error && <span className="trash-error">{error}</span>}
    </div>
  );
}

/** The owner's "Test" ends back in the app with the result in the address; say it once and tidy the address. */
export function SsoTestResult() {
  const [result] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get("sso_test");
    return r ? { ok: r === "ok", reason: q.get("reason") } : null;
  });
  const [shown, setShown] = useState(!!result);
  useEffect(() => {
    if (result) window.history.replaceState(null, "", window.location.pathname);
  }, [result]);
  if (!result || !shown) return null;
  return (
    <div className="join-banner" role="status">
      <span>{result.ok ? "SSO test passed. You can turn it on in the organisation's settings." : `SSO test failed: ${result.reason ?? "unknown reason"}.`}</span>
      <button className="btn btn-small btn-quiet" onClick={() => setShown(false)}>Dismiss</button>
    </div>
  );
}
