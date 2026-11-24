import { useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { roleName } from "../auth/access.js";
import NotificationBell from "../notifications/NotificationBell.jsx";

export default function StudentHeader({ active = "catalog" }) {
  const { user, logout } = useAuth();
  const catalogActive = active === "catalog";
  const requestsActive = active === "requests";
  const canBorrow = user && user.role !== "admin";
  const requestsPath = user?.role === "admin" ? "/admin/requests" : "/requests";
  const requestsLinkRef = useRef(null);
  const goToRequests = () => {
    if (requestsLinkRef.current?.click) return requestsLinkRef.current.click();
    if (typeof window !== "undefined" && window.location?.assign) window.location.assign(requestsPath);
  };

  return (
    <header className="home-header">
      <div className="header-brand">
        <div className="brand-logo">CG</div>
        <div>
          <h2>Campus Gear</h2>
          <p>Equipment Loan System</p>
        </div>
      </div>

      <nav className="header-nav">
        <Link to="/" className={catalogActive ? "active" : undefined}>
          Catalog
        </Link>
        {canBorrow && (
          <Link to="/requests" className={requestsActive ? "active" : undefined}>
            My requests
          </Link>
        )}
        {user?.role === "admin" && <Link to="/admin/requests">Requests</Link>}
        {user?.role === "admin" && <Link to="/dashboard">Dashboard</Link>}
      </nav>

      <div className="header-profile">
        {user ? (
          <>
            {canBorrow && <NotificationBell onNavigate={goToRequests} />}
            <span className="header-profile-text">
              <strong>{user.fullName}</strong>
              <small>{roleName(user.role)}</small>
            </span>
            <button type="button" className="profile-link profile-logout" onClick={() => logout().catch(() => {})}>
              Log out
            </button>
          </>
        ) : (
          <>
            <Link className="profile-link" to="/login">
              Log in
            </Link>
            <Link className="profile-signup" to="/signup">
              Create account
            </Link>
          </>
        )}
      </div>
      {canBorrow && <Link ref={requestsLinkRef} to={requestsPath} className="sr-only" tabIndex={-1} aria-hidden="true" />}
    </header>
  );
}
