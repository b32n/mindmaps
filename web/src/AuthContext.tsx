import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { auth, type User } from "./api";

interface AuthState {
  user: User | null;
  googleEnabled: boolean;
  /** null until the first /auth/me lands — distinct from "signed out" */
  loading: boolean;
  signIn: (u: User) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    auth
      .me()
      .then((r) => {
        setUser(r.user);
        setGoogleEnabled(r.googleEnabled);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const signOut = useCallback(async () => {
    await auth.logout().catch(() => {});
    setUser(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, googleEnabled, loading, signIn: setUser, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
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
