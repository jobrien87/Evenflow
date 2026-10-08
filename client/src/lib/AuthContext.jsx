import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
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
    return data.user;
  }

  return <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
