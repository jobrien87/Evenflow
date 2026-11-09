import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    api
      .me()
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
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

  return <AuthContext.Provider value={{ user, loading, login, logout, refreshUser, impersonation }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
