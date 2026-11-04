import { useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { ErrorText } from "../auth/AuthUI.jsx";

// Header shared by every signed-in page: put <AppHeader /> at the top of new pages.
export function AppHeader() {
  const { user, logout } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function out() {
    setError("");
    setBusy(true);
    try {
      await logout();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <header className="app-header">
      <div>
        <p className="brand brand-left">CADT</p>
        <p className="brand-sub brand-left">Campus Equipment Loans</p>
      </div>
      <div className="who">
        <span>
          {user.fullName} <span className="role-badge">{user.role}</span>
        </span>
        <button type="button" className="btn-outline" onClick={out} disabled={busy}>
          {busy ? "Logging out" : "Log out"}
        </button>
      </div>
      <ErrorText>{error}</ErrorText>
    </header>
  );
}

export default function Home() {
  const { user } = useAuth();
  return (
    <>
      <AppHeader />
      <main className="app-main">
        <h1>Welcome, {user.fullName}</h1>
        <p className="subtitle">The equipment catalogue and borrowing requests will appear here.</p>
      </main>
    </>
  );
}
