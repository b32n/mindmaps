import { useState } from "react";
import { Link, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { auth } from "../api";
import { useAuth } from "../AuthContext";

/**
 * Mirrors the server's policy in worker/src/auth.ts. Shown live as the user
 * types so the rules are visible up front rather than discovered one at a time
 * through rejections. The server remains the authority.
 */
const RULES: { label: string; ok: (p: string) => boolean }[] = [
  { label: "12 characters or more", ok: (p) => p.length >= 12 },
  { label: "a lowercase letter", ok: (p) => /[a-z]/.test(p) },
  { label: "an uppercase letter", ok: (p) => /[A-Z]/.test(p) },
  { label: "a number", ok: (p) => /[0-9]/.test(p) },
  { label: "a symbol", ok: (p) => /[^A-Za-z0-9]/.test(p) },
  { label: "no character 4+ times in a row", ok: (p) => !/(.)\1{3,}/.test(p) },
];

function GoogleButton({ next }: { next: string }) {
  const { googleEnabled } = useAuth();
  if (!googleEnabled) return null;
  return (
    <>
      <a className="btn-google" href={`/api/auth/google?next=${encodeURIComponent(next)}`}>
        <svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true">
          <path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.5h4.8a4 4 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.6z"/>
          <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z"/>
          <path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z"/>
          <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z"/>
        </svg>
        Continue with Google
      </a>
      <div className="or"><span>or</span></div>
    </>
  );
}

/**
 * Where to go after signing in.
 *
 * `?next=` carries an absolute URL when the OAuth authorize endpoint bounced
 * the user here to sign in — the authorization server lives on the API origin,
 * not this one, so a router navigation would land on the wrong server. Only
 * the API origin is honoured; anything else is an open redirect and is ignored.
 */
const API_ORIGIN = import.meta.env.VITE_API_URL ?? window.location.origin;

function useNextTarget(): { next: string; external: boolean } {
  const loc = useLocation() as { state?: { from?: string } };
  const [params] = useSearchParams();
  const raw = params.get("next") ?? loc.state?.from ?? "/app";
  if (/^https?:\/\//i.test(raw)) {
    try {
      if (new URL(raw).origin === new URL(API_ORIGIN, window.location.origin).origin)
        return { next: raw, external: true };
    } catch {
      /* fall through to the safe default */
    }
    return { next: "/app", external: false };
  }
  return { next: raw.startsWith("/") ? raw : "/app", external: false };
}

export function LoginPage() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { next, external } = useNextTarget();
  const connecting = params.get("connect");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(params.get("error"));
  const [busy, setBusy] = useState(false);

  const go = () => {
    if (external) window.location.assign(next);
    else nav(next, { replace: true });
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await auth.login(email, password);
      signIn(user);
      go();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <Link to="/" className="auth-brand">mindmaps</Link>
        <h1>Welcome back</h1>
        {connecting && (
          <p className="auth-alt">Sign in to connect <strong>{connecting}</strong> to your mindmaps.</p>
        )}

        <GoogleButton next={next} />

        {error && <div className="auth-error">{error}</div>}

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
        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <button className="auth-submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="auth-alt">
          No account? <Link to="/register">Create one</Link>
        </p>
      </form>
    </div>
  );
}

export function RegisterPage() {
  const { signIn } = useAuth();
  const nav = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const failing = RULES.filter((r) => !r.ok(password));
  const strong = failing.length === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!strong) {
      setTouched(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { user } = await auth.register(email, password, name);
      signIn(user);
      nav("/app", { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <Link to="/" className="auth-brand">mindmaps</Link>
        <h1>Create your account</h1>

        <GoogleButton next="/app" />

        {error && <div className="auth-error">{error}</div>}

        <label>
          Name
          <input value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
        </label>
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
        <label>
          Password
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

        <button className="auth-submit" disabled={busy || !strong}>
          {busy ? "Creating…" : "Create account"}
        </button>
        <p className="auth-alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
