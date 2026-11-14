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
    try {
      await logout();
      navigate("/login", { replace: true, state: { from: pathname + search + hash } });
    } catch (err) {
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
        Back to the Catalog
      </Link>
      <ErrorText>{error}</ErrorText>
      <p className="switch">
        <button className="btn-outline" type="button" onClick={switchUser}>
          Sign in as someone else
        </button>
      </p>
    </AuthShell>
  );
}
