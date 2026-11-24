import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Set only when the initial session check itself failed to get a real
  // answer (network error, a 500, a timed-out request during a backend
  // hiccup) — distinct from a confirmed 401, which is a real "not signed
  // in." Collapsing the two used to bounce a legitimately logged-in user
  // to /login just because one background check happened to land during
  // a slow moment, with nothing to tell them that's what happened.
  const [authError, setAuthError] = useState(false);
  // Impersonation state lives here, alongside `user`, rather than in its
  // own component-local fetch (ImpersonationBar.jsx used to own this) —
  // a "Log in as" action can be triggered from more than one place in the
  // app now (the global VIEW AS... search, and AgenciesPanel's per-row
  // button), and every one of them already has to call refreshUser() to
  // pick up the new effective user for RoleGate/routing. Folding
  // impersonation status into that same refresh means every trigger point
  // updates the banner too, for free, with no separate wiring per caller.
  const [impersonation, setImpersonation] = useState(null);

  async function loadImpersonationStatus() {
    try {
      const data = await api.impersonationStatus();
      setImpersonation(data);
    } catch {
      setImpersonation(null);
    }
  }

  async function checkAuth() {
    setLoading(true);
    try {
      const data = await api.me();
      setUser(data.user);
      setAuthError(false);
    } catch (err) {
      // Only a real 401 means "not signed in" — anything else (network
      // error, a 500) means the check itself failed, which is not the
      // same thing as being logged out.
      if (err.status === 401) {
        setUser(null);
        setAuthError(false);
      } else {
        setAuthError(true);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    checkAuth();
    loadImpersonationStatus();
  }, []);

  // A password-verified login for an MFA-enrolled account doesn't set a
  // user or session yet — it returns a challengeToken instead, which the
  // caller must pass to completeMfaLogin with a real code before any
  // session exists. Login.jsx is the one caller; it inspects the shape
  // of what's returned to decide whether to show the second-factor step.
  async function login(email, password) {
    const data = await api.login(email, password);
    if (data.mfaRequired) {
      return { mfaRequired: true, challengeToken: data.challengeToken };
    }
    setUser(data.user);
    return { user: data.user };
  }

  async function completeMfaLogin(challengeToken, code) {
    const data = await api.mfaVerifyLogin(challengeToken, code);
    setUser(data.user);
    return data.user;
  }

  async function logout() {
    await api.logout();
    setUser(null);
  }

  async function refreshUser() {
    const data = await api.me();
    setUser(data.user);
    await loadImpersonationStatus();
    return data.user;
  }

  return <AuthContext.Provider value={{ user, loading, login, logout, refreshUser, impersonation, authError, retryAuthCheck: checkAuth }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
