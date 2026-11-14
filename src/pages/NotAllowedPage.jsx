import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { AuthShell } from "../auth/AuthUI.jsx";
import { rolesLabel } from "../auth/access.js";

// Shown instead of a page the signed-in user's role may not open. It explains why and offers a way back.
export default function NotAllowedPage({ roles }) {
  const { user } = useAuth();
  return (
    <AuthShell
      title="You don't have access to this page"
      subtitle={`This page is for ${rolesLabel(roles)}. You are signed in as ${user.fullName} (${user.role}).`}
    >
      <p className="switch">If you need access, ask a CADT equipment administrator.</p>
      <Link className="btn-primary" to="/">
        Back to the catalogue
      </Link>
    </AuthShell>
  );
}
