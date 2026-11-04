import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import {
  BellIcon,
  ChevronDownIcon,
  DashboardIcon,
  EquipmentIcon,
  HistoryIcon,
  LogoutIcon,
  MenuIcon,
  ReportsIcon,
  RequestsIcon,
  SettingsIcon,
  UsersIcon,
} from "../components/Icons.jsx";
import "../dashboard.css";

const NAV_ITEMS = [
  { key: "dashboard", label: "Dashboard", Icon: DashboardIcon },
  { key: "equipment", label: "Equipment", Icon: EquipmentIcon, active: true },
  { key: "requests", label: "Borrow Requests", Icon: RequestsIcon },
  { key: "history", label: "Loan History", Icon: HistoryIcon },
  { key: "users", label: "Users", Icon: UsersIcon },
  { key: "reports", label: "Reports", Icon: ReportsIcon },
  { key: "settings", label: "Settings", Icon: SettingsIcon },
];

const roleLabel = (role) => {
  if (role === "admin") return "Administrator";
  if (role === "faculty") return "Faculty";
  return "Student";
};

const initials = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "AU";

export default function DashboardLayout({ user: userProp, onLogout, children }) {
  const { user: sessionUser, logout } = useAuth();
  const user = userProp ?? sessionUser ?? { fullName: "Admin User", role: "admin" };
  const navigate = useNavigate();
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
          {NAV_ITEMS.map(({ key, label, Icon, active }) => (
            <button
              key={key}
              type="button"
              className={`dash-nav-item${active ? " is-active" : ""}`}
              disabled={!active}
              aria-current={active ? "page" : undefined}
              onClick={() => setSidebarOpen(false)}
            >
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="dash-profile">
          <span className="dash-profile-icon"><UsersIcon size={18} /></span>
          <span className="dash-profile-info">
            <strong>{user.fullName}</strong>
            <span>{roleLabel(user.role)}</span>
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

          <button type="button" className="dash-icon-btn" aria-label="Notifications">
            <BellIcon size={20} />
            <span className="dash-notif-dot" />
          </button>

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
                <span>{roleLabel(user.role)}</span>
              </span>
              <ChevronDownIcon size={16} />
            </button>

            {menuOpen && (
              <div className="dash-menu" role="menu">
                <div className="dash-menu-user">
                  <strong>{user.fullName}</strong>
                  <span>{roleLabel(user.role)}</span>
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
