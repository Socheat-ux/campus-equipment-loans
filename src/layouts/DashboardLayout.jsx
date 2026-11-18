import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { roleName } from "../auth/access.js";
import {
  ChevronDownIcon,
  DashboardIcon,
  EquipmentIcon,
  HomeIcon,
  LogoutIcon,
  MenuIcon,
  RequestsIcon,
  UsersIcon,
} from "../components/Icons.jsx";
import "../dashboard.css";

const NAV_ITEMS = [
  { key: "home", label: "Back to Home", Icon: HomeIcon, to: "/" },
  { key: "dashboard", label: "Dashboard", Icon: DashboardIcon, to: "/dashboard" },
  { key: "equipment", label: "Equipment", Icon: EquipmentIcon, to: "/dashboard" },
  { key: "requests", label: "Borrow Requests", Icon: RequestsIcon, to: "/admin/requests" },
  { key: "users", label: "Users", Icon: UsersIcon, to: "/users" },
];

const initials = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "?";

export default function DashboardLayout({ user: userProp, onLogout, children, active }) {
  const { user: sessionUser, logout } = useAuth();
  const user = userProp ?? sessionUser ?? {};
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeKey = active ?? (pathname.startsWith("/admin/requests") ? "requests" : "equipment");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const accountRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event) => {
      if (!accountRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const handleLogout = () => {
    setMenuOpen(false);
    if (onLogout) {
      onLogout();
      return;
    }
    navigate("/", { replace: true });
    logout().catch(() => {});
  };

  return (
    <div className="dashboard">
      <aside className={`dash-sidebar${sidebarOpen ? " is-open" : ""}`}>
        <div className="dash-brand">
          <p className="dash-brand-name">CADT</p>
          <p className="dash-brand-sub">Campus Equipment Loans</p>
        </div>

        <nav className="dash-nav" aria-label="Dashboard navigation">
          {NAV_ITEMS.map(({ key, label, Icon, to }) => {
            const isActive = key === activeKey;
            return (
              <button
                key={key}
                type="button"
                className={`dash-nav-item${isActive ? " is-active" : ""}`}
                disabled={!isActive && !to}
                aria-current={isActive ? "page" : undefined}
                onClick={() => {
                  setSidebarOpen(false);
                  if (to) navigate(to);
                }}
              >
                <Icon size={19} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="dash-profile">
          <span className="dash-profile-icon"><UsersIcon size={18} /></span>
          <span className="dash-profile-info">
            <strong>{user.fullName}</strong>
            <span>{roleName(user.role)}</span>
          </span>
        </div>
      </aside>

      <button
        type="button"
        className={`dash-sidebar-scrim${sidebarOpen ? " is-visible" : ""}`}
        aria-label="Close navigation"
        onClick={() => setSidebarOpen(false)}
      />

      <div className="dash-shell">
        <header className="dash-topbar">
          <button
            type="button"
            className="dash-menu-btn"
            aria-label="Open navigation"
            onClick={() => setSidebarOpen(true)}
          >
            <MenuIcon size={21} />
          </button>
          <div className="dash-topbar-spacer" />

          <div className="dash-account" ref={accountRef}>
            <button
              type="button"
              className="dash-account-btn"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="dash-avatar">{initials(user.fullName)}</span>
              <span className="dash-account-text">
                <strong>{user.fullName}</strong>
                <span>{roleName(user.role)}</span>
              </span>
              <ChevronDownIcon size={16} />
            </button>

            {menuOpen && (
              <div className="dash-menu" role="menu">
                <div className="dash-menu-user">
                  <strong>{user.fullName}</strong>
                  <span>{roleName(user.role)}</span>
                </div>
                <button type="button" role="menuitem" onClick={handleLogout}>
                  <LogoutIcon size={17} />
                  Log out
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="dash-main">{children}</main>
      </div>
    </div>
  );
}
