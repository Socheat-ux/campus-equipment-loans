import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Counts sign-in, sign-out and expiry events, so a slow /me answer from before one of them is ignored.
  const authEpoch = useRef(0);

  useEffect(() => {
    api("/me")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // api() fires this when a request finds the session gone, so the UI returns to the login page.
  // A 403 fires "auth-changed": the role may have changed, so ask the server who we are now and let RoleGate react.
  useEffect(() => {
    const expired = () => {
      authEpoch.current++;
      setUser(null);
    };
    const changed = () => {
      const epoch = authEpoch.current;
      api("/me")
        .then((data) => epoch === authEpoch.current && setUser(data.user))
        // 401 means the session is gone; any other failure keeps what is shown
        .catch((err) => epoch === authEpoch.current && err.status === 401 && setUser(null));
    };
    window.addEventListener("auth-expired", expired);
    window.addEventListener("auth-changed", changed);
    return () => {
      window.removeEventListener("auth-expired", expired);
      window.removeEventListener("auth-changed", changed);
    };
  }, []);

  const enter = (path) => async (credentials) => {
    const data = await api(path, credentials);
    authEpoch.current++;
    setUser(data.user);
  };

  // If the request fails the error reaches the caller and the user stays signed in on screen, matching the server.
  const logout = async () => {
    await api("/logout", {});
    authEpoch.current++;
    setUser(null);
  };

  return (
    <Ctx.Provider value={{ user, loading, login: enter("/login"), signup: enter("/signup"), logout }}>
      {children}
    </Ctx.Provider>
  );
}
