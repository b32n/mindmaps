import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { auth, type Mode, type User } from "./api";

interface AuthState {
  user: User | null;
  googleEnabled: boolean;
  /** this instance can send email, so verification and password reset exist */
  emailEnabled: boolean;
  /** the signed-in address is confirmed (true when signed out: nothing to nag about) */
  emailVerified: boolean;
  /** ask the server again who we are, e.g. after confirming the address */
  refresh: () => Promise<void>;
  /** the instance's deployment mode; null until /auth/me lands */
  mode: Mode | null;
  /** null until the first /auth/me lands — distinct from "signed out" */
  loading: boolean;
  signIn: (u: User) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailVerified, setEmailVerified] = useState(true);
  const [mode, setMode] = useState<Mode | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(
    () =>
      auth
        .me()
        .then((r) => {
          setUser(r.user);
          setGoogleEnabled(r.googleEnabled);
          setMode(r.mode);
          setEmailEnabled(!!r.emailEnabled);
          setEmailVerified(r.emailVerified !== false);
        })
        .catch(() => setUser(null))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Signing in or up hands us the user; whether their address is confirmed is a separate question for the server.
  const signIn = useCallback(
    (u: User) => {
      setUser(u);
      void refresh();
    },
    [refresh],
  );

  // Available to CSS and to anything outside React; nothing styles on it yet.
  useEffect(() => {
    if (mode) document.documentElement.dataset.mindmapsMode = mode;
    else delete document.documentElement.dataset.mindmapsMode;
  }, [mode]);

  const signOut = useCallback(async () => {
    await auth.logout().catch(() => {});
    setUser(null);
  }, []);

  return (
    <Ctx.Provider
      value={{ user, googleEnabled, emailEnabled, emailVerified, refresh, mode, loading, signIn, signOut }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

/** The deployment mode, or null until the first /auth/me answer lands. */
export function useMode(): Mode | null {
  return useAuth().mode;
}

/**
 * Gate for signed-in routes.
 *
 * Waiting on `loading` matters: without it a refresh on /app flashes the login
 * page before /auth/me resolves, and the redirect can eat the intended
 * destination.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="boot">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

/** Signed-in users shouldn't sit on /login or /register. */
export function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="boot">Loading…</div>;
  if (user) return <Navigate to="/app" replace />;
  return <>{children}</>;
}
