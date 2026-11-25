import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { auth } from "../api";
import { useAuth } from "../AuthContext";
import { RULES } from "./Auth";
import { Turnstile, type TurnstileHandle } from "../Turnstile";

/**
 * The pages behind the links in the emails: confirm an address, ask for a
 * password reset, choose a new password. Same card as sign-in and sign-up.
 * What the server does with each is in docs/EMAIL.md.
 */

/**
 * The link is confirmed by a button, not on load. A mail scanner that opens
 * links (and runs script) would otherwise use the link up before the person
 * ever saw it.
 */
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { user, refresh } = useAuth();
  const [state, setState] = useState<"ready" | "busy" | "done" | "failed">(token ? "ready" : "failed");
  const [error, setError] = useState<string | null>(token ? null : "That link is invalid or has expired.");

  async function confirm() {
    setState("busy");
    try {
      await auth.verifyEmail(token);
      await refresh();
      setState("done");
    } catch (err) {
      setError((err as Error).message);
      setState("failed");
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link to="/" className="auth-brand">mindmaps</Link>
        {state === "done" ? (
          <>
            <h1>Email confirmed</h1>
            <p className="auth-alt" role="status">Thanks. Your address is confirmed.</p>
            <Link className="auth-submit auth-link-button" to={user ? "/app" : "/login"}>
              {user ? "Open mindmaps" : "Sign in"}
            </Link>
          </>
        ) : (
          <>
            <h1>Confirm your email</h1>
            {error && <div className="auth-error" role="alert">{error}</div>}
            {state !== "failed" ? (
              <>
                <p className="auth-alt">Press the button to confirm this address for your account.</p>
                <button className="auth-submit" onClick={confirm} disabled={state === "busy"}>
                  {state === "busy" ? "Confirming…" : "Confirm email address"}
                </button>
              </>
            ) : (
              <p className="auth-alt">
                {user ? (
                  <>Ask for a new link from the banner in <Link to="/app">the app</Link>.</>
                ) : (
                  <>Sign in and ask for a new link from the banner in the app.</>
                )}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const { emailEnabled, loading, turnstileSiteKey } = useAuth();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const challenge = useRef<TurnstileHandle>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.forgotPassword(email, token ?? undefined);
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
      challenge.current?.reset(); // a token works once
    }
    setBusy(false);
  }

  if (loading) return <div className="boot">Loading…</div>;

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <Link to="/" className="auth-brand">mindmaps</Link>
        <h1>Reset your password</h1>
        {!emailEnabled ? (
          <>
            <div className="auth-error" role="alert">
              This mindmaps can't send email, so passwords can't be reset here. Ask whoever runs it to reset yours.
            </div>
            <p className="auth-alt"><Link to="/login">Back to sign in</Link></p>
          </>
        ) : sent ? (
          <>
            <p className="auth-alt" role="status">
              If there is an account for that address, we've sent a link to it. The link works once and expires in an hour.
            </p>
            <p className="auth-alt"><Link to="/login">Back to sign in</Link></p>
          </>
        ) : (
          <>
            <p className="auth-alt">Enter your email and we'll send you a link to choose a new password.</p>
            {error && <div className="auth-error" role="alert">{error}</div>}
            <label>
              Email
              <input
                type="email"
                value={email}
                autoComplete="email"
                required
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {turnstileSiteKey && (
              <Turnstile ref={challenge} siteKey={turnstileSiteKey} action="forgot-password" onToken={setToken} />
            )}
            <button className="auth-submit" disabled={busy || (!!turnstileSiteKey && !token)}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
            <p className="auth-alt"><Link to="/login">Back to sign in</Link></p>
          </>
        )}
      </form>
    </div>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : "That link is invalid or has expired.");
  const [busy, setBusy] = useState(false);
  const [dead, setDead] = useState(!token);

  const strong = RULES.every((r) => r.ok(password));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!strong) {
      setTouched(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.resetPassword(token, password);
      nav("/login?notice=reset", { replace: true });
    } catch (err) {
      setError((err as Error).message);
      // a weak password leaves the link usable; anything else means it is gone
      setDead(!/^Your password needs/.test((err as Error).message));
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <Link to="/" className="auth-brand">mindmaps</Link>
        <h1>Choose a new password</h1>
        {error && <div className="auth-error" role="alert">{error}</div>}
        {dead ? (
          <p className="auth-alt"><Link to="/forgot-password">Ask for a new link</Link></p>
        ) : (
          <>
            <label>
              New password
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                required
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched(true)}
              />
            </label>
            {(touched || password) && (
              <ul className="pw-rules">
                {RULES.map((r) => {
                  const ok = r.ok(password);
                  return (
                    <li key={r.label} className={ok ? "ok" : "no"}>
                      <span aria-hidden="true">{ok ? "✓" : "○"}</span> {r.label}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="auth-alt">Saving signs you out of every device.</p>
            <button className="auth-submit" disabled={busy || !strong}>
              {busy ? "Saving…" : "Save new password"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}

/**
 * Shown over the app while the signed-in address is unconfirmed and this
 * instance can send email. Dismissal is not offered: until the address is
 * confirmed, invitations to it are held back, and that is worth saying.
 */
export function VerifyBanner() {
  const { user, emailEnabled, emailVerified, turnstileSiteKey } = useAuth();
  const [state, setState] = useState<"idle" | "check" | "busy" | "sent" | "limited" | "failed">("idle");
  const challenge = useRef<TurnstileHandle>(null);
  if (!user || !emailEnabled || emailVerified) return null;

  async function resend(token?: string) {
    setState("busy");
    try {
      await auth.resendVerification(token);
      setState("sent");
    } catch (err) {
      setState((err as Error & { status?: number }).status === 429 ? "limited" : "failed");
      challenge.current?.reset(); // a token works once
    }
  }
  // With the sign-up check on, pressing the button shows it; solving it sends the mail.
  const press = () => (turnstileSiteKey ? setState("check") : resend());

  return (
    <div className="verify-banner" role="status">
      <span>
        {state === "sent"
          ? `We sent a new link to ${user.email}.`
          : state === "limited"
            ? "That's enough emails for now. Try again in a while."
            : state === "failed"
              ? "We couldn't send that. Try again in a moment."
              : `Confirm your email: we sent a link to ${user.email}. Until you do, invitations to it wait.`}
      </span>
      {state === "check" && turnstileSiteKey && (
        <Turnstile
          ref={challenge}
          siteKey={turnstileSiteKey}
          action="resend-verification"
          onToken={(t) => t && void resend(t)}
        />
      )}
      <button className="verify-banner-btn" onClick={press} disabled={state === "busy" || state === "check"}>
        Resend email
      </button>
    </div>
  );
}
