/**
 * An organisation's domains, sign-up policy and SSO, for its owner and admins.
 *
 * Three small sections in the workspace dialog. What each person may do is
 * decided by the server (worker/src/org-policy.ts); this hides what it would refuse
 * (SSO is the owner's; none of it exists on a personal install) and reports
 * what it says. The client secret is only ever sent, never shown: the form
 * knows that one is stored, not what it is.
 */

import { useCallback, useEffect, useState } from "react";
import { api, type OrgDomain, type OrgSecurity, type Workspace } from "./api";

type Busy = string | null;

export function OrgSecurityPanel({ workspace }: { workspace: Workspace }) {
  const ws = workspace.id;
  const owner = workspace.role === "owner";
  const [sec, setSec] = useState<OrgSecurity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);

  const load = useCallback(
    () => api.security(ws).then(setSec).catch((e: Error) => setError(e.message)),
    [ws],
  );
  useEffect(() => {
    void load();
  }, [load]);

  /** One action at a time: report its failure in one place, then re-read. */
  const run = async (what: string, f: () => Promise<unknown>, done?: string) => {
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      await f();
      if (done) setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      // Re-read before letting go, or a control shows its old value for a beat and a quick second click undoes the first.
      await load();
      setBusy(null);
    }
  };

  if (!sec) return <section className="org-sec">{error ? <p className="trash-error">{error}</p> : <p className="members-note">Loading…</p>}</section>;

  const verified = sec.domains.filter((d) => d.status === "verified");
  return (
    <section className="org-sec" aria-label="Domains, policy and single sign-on">
      {error && <p className="trash-error" role="alert">{error}</p>}
      {notice && <p className="members-note" role="status">{notice}</p>}

      <h3 className="org-sec-h">Domains</h3>
      <DomainsSection ws={ws} domains={sec.domains.filter((d) => d.status !== "removed")} busy={busy} run={run} />

      <h3 className="org-sec-h">Policy</h3>
      {verified.length === 0 ? (
        <p className="members-note">Policy applies to verified domains. Verify one first.</p>
      ) : (
        <div className="org-policy">
          <label className="org-check">
            <input
              type="checkbox"
              checked={sec.policy.auto_join}
              disabled={!!busy}
              onChange={(e) => void run("policy", () => api.setPolicy(ws, { auto_join: e.target.checked }))}
            />
            Let people with an address on a verified domain join
          </label>
          <div className="ws-admin-row">
            <label htmlFor="org-default-role">Joins as</label>
            <select
              id="org-default-role"
              className="input"
              value={sec.policy.default_role}
              disabled={!!busy}
              onChange={(e) => void run("policy", () => api.setPolicy(ws, { default_role: e.target.value as "viewer" | "editor" }))}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
          </div>
          <p className="members-note">
            They are offered a Join button, never added silently, and only once the address is proven by Google or your SSO.
          </p>
          <label className="org-check">
            <input
              type="checkbox"
              checked={sec.policy.restrict_invites}
              disabled={!!busy}
              onChange={(e) => void run("policy", () => api.setPolicy(ws, { restrict_invites: e.target.checked }))}
            />
            Only invite people on a verified domain
          </label>
        </div>
      )}

      {owner && <SsoSection ws={ws} sec={sec} busy={busy} run={run} hasDomain={verified.length > 0} />}
    </section>
  );
}

function DomainsSection({
  ws,
  domains,
  busy,
  run,
}: {
  ws: string;
  domains: OrgDomain[];
  busy: Busy;
  run: (what: string, f: () => Promise<unknown>, done?: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <div className="org-domains">
      <div className="ws-admin-row">
        <input
          className="input"
          aria-label="Domain"
          placeholder="example.com"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && void run("add", () => api.addDomain(ws, name).then(() => setName("")))}
        />
        <button className="btn" disabled={!!busy || !name.trim()} onClick={() => void run("add", () => api.addDomain(ws, name).then(() => setName("")))}>
          Add domain
        </button>
      </div>
      {domains.map((d) => (
        <div key={d.id} className="org-domain" data-domain={d.domain}>
          <div className="org-domain-head">
            <strong>{d.domain}</strong>
            <span className="members-note">{d.status === "verified" ? "Verified" : "Not verified yet"}</span>
            <span className="org-domain-actions">
              {d.status === "pending" && (
                <button
                  className="btn btn-small"
                  disabled={!!busy}
                  aria-label={`Verify ${d.domain}`}
                  onClick={() => void run("verify", () => api.verifyDomain(ws, d.id), `${d.domain} is verified.`)}
                >
                  Verify
                </button>
              )}
              <button className="btn btn-small btn-quiet" disabled={!!busy} aria-label={`Remove ${d.domain}`} onClick={() => void run("remove", () => api.removeDomain(ws, d.id))}>
                Remove
              </button>
            </span>
          </div>
          {d.status === "pending" && d.record && (
            <p className="members-note">
              Add a {d.record.type} record at <code>{d.record.name}</code> with the value <code>{d.record.value}</code>, then Verify.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function SsoSection({
  ws,
  sec,
  busy,
  run,
  hasDomain,
}: {
  ws: string;
  sec: OrgSecurity;
  busy: Busy;
  run: (what: string, f: () => Promise<unknown>, done?: string) => Promise<void>;
  hasDomain: boolean;
}) {
  const { sso, policy } = sec;
  const [issuer, setIssuer] = useState(sso.issuer ?? "");
  const [clientId, setClientId] = useState(sso.client_id ?? "");
  const [secret, setSecret] = useState("");
  useEffect(() => {
    setIssuer(sso.issuer ?? "");
    setClientId(sso.client_id ?? "");
  }, [sso.issuer, sso.client_id]);

  const save = () =>
    run(
      "sso-save",
      () => api.saveSso(ws, { issuer, client_id: clientId, ...(secret ? { client_secret: secret } : {}) }).then(() => setSecret("")),
      "Saved. Test it before turning it on.",
    );
  const test = () =>
    run("sso-test", async () => {
      const { url } = await api.testSso(ws);
      window.location.assign(url);
    });

  const enabled = sso.status === "enabled";
  return (
    <>
      <h3 className="org-sec-h">Single sign-on</h3>
      <div className="org-sso">
        <p className="members-note">
          Register this redirect URI with your identity provider: <code>{sso.redirect_uri}</code>
        </p>
        <label htmlFor="sso-issuer">Issuer</label>
        <input id="sso-issuer" className="input" placeholder="https://login.example.com" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
        <label htmlFor="sso-client">Client ID</label>
        <input id="sso-client" className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        <label htmlFor="sso-secret">Client secret</label>
        <input
          id="sso-secret"
          className="input"
          type="password"
          autoComplete="off"
          placeholder={sso.has_secret ? "Stored. Leave empty to keep it." : ""}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <div className="ws-admin-row">
          <button className="btn" disabled={!!busy || !issuer.trim() || !clientId.trim()} onClick={() => void save()}>
            Save
          </button>
          <button className="btn" disabled={!!busy || sso.status === "none"} onClick={() => void test()}>
            Test
          </button>
          {sso.status !== "none" && (
            <button className="btn btn-small btn-quiet" disabled={!!busy} onClick={() => void run("sso-remove", () => api.removeSso(ws))}>
              Remove SSO
            </button>
          )}
        </div>
        <p className="members-note" data-testid="sso-status">
          {sso.status === "none" && "Not configured."}
          {sso.status === "draft" && "Saved, not tested yet."}
          {sso.status === "tested" && "Tested: ready to turn on."}
          {enabled && "On."}
        </p>
        <label className="org-check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!!busy || !hasDomain || (!enabled && sso.status !== "tested")}
            onChange={(e) => void run("sso-enable", () => api.enableSso(ws, e.target.checked))}
          />
          Turn SSO on
        </label>
        {!hasDomain && <p className="members-note">SSO signs people in by their verified domain. Verify one first.</p>}
        <label className="org-check">
          <input
            type="checkbox"
            checked={policy.enforce_sso}
            disabled={!!busy || (!enabled && !policy.enforce_sso)}
            onChange={(e) => void run("sso-enforce", () => api.enforceSso(ws, e.target.checked))}
          />
          Require SSO for people on a verified domain
        </label>
        <p className="members-note">
          When required, they reach this organisation only through SSO. You, as owner, keep this page to switch it off if the provider fails.
        </p>
      </div>
    </>
  );
}
