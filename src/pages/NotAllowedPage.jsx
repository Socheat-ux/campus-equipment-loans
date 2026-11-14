import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { AuthShell, ErrorText } from "../auth/AuthUI.jsx";
import { rolesLabel, roleName } from "../auth/access.js";

// Shown instead of a page the signed-in user's role may not open. It explains why and offers a way back.
export default function NotAllowedPage({ roles, page = "This page" }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname, search, hash } = useLocation();
  const headingRef = useRef(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // This page replaces the one the user asked for, so tell screen readers: move focus to the heading and retitle the tab.
  useEffect(() => {
    const before = document.title;
    document.title = "Not allowed · Campus Equipment Loans";
    headingRef.current?.focus();
    return () => {
      document.title = before;
    };
  }, []);

  async function switchUser() {
    setError("");
    setBusy(true);
    try {
      await logout();
      // The login page shows this, so the user knows the sign-out was on purpose and what to do next.
      const notice = `You signed out. Sign in with an account for ${rolesLabel(roles)} to continue.`;
      navigate("/login", { replace: true, state: { from: pathname + search + hash, notice } });
    } catch (err) {
      setBusy(false);
      setError(err.message);
    }
  }

  return (
    <AuthShell
      headingRef={headingRef}
      title="You don't have access to this page"
      subtitle={`${page} is for ${rolesLabel(roles)}. You are signed in as ${user.fullName} (${roleName(user.role)}).`}
    >
      <Link className="btn-primary" to="/">
        Go to the catalogue
      </Link>
      {/* Kept quiet on purpose: most people here are students, and one click signs them out. */}
      <p className="switch">
        <button className="link-button" type="button" onClick={switchUser} disabled={busy}>
          {busy ? "Signing out…" : "Log out and use another account"}
        </button>
      </p>
      <ErrorText>{error}</ErrorText>
    </AuthShell>
  );
}
