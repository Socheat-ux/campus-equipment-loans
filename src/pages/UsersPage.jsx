import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { roleName } from "../auth/access.js";
import DashboardLayout from "../layouts/DashboardLayout.jsx";
import { SearchIcon, UsersIcon } from "../components/Icons.jsx";
import { listUsers } from "../users/api.js";

// Administrators only: the route is wrapped in RoleGate and the API checks again with requireAdmin.
export default function UsersPage({ user: userProp, onLogout }) {
  const { user: sessionUser } = useAuth();
  const user = userProp ?? sessionUser;

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setUsers(await listUsers());
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Every word typed must appear in the name, email or role, like the equipment catalogue search.
  const filtered = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return users.filter((person) =>
      words.every((word) => `${person.fullName} ${person.email} ${roleName(person.role)}`.toLowerCase().includes(word)),
    );
  }, [users, search]);

  return (
    <DashboardLayout user={user} onLogout={onLogout} active="users">
      <div className="dash-page">
        <nav className="dash-breadcrumb" aria-label="Breadcrumb">
          <span>Home</span>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Users</span>
        </nav>

        <div className="dash-page-head">
          <div>
            <h1>User Management</h1>
            <p>Each account is marked with its role. Only administrators can open the dashboard.</p>
          </div>
        </div>

        <section className="dash-panel" aria-labelledby="users-title">
          <div className="dash-panel-head">
            <div>
              <h2 id="users-title">Accounts</h2>
              <p>Roles are shown as marked on each account and cannot be changed here.</p>
            </div>
            <div className="dash-filters">
              <label className="dash-search">
                <SearchIcon size={17} />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Enter name or email"
                  aria-label="Search users"
                />
              </label>
              <button type="button" className="dash-edit-btn" onClick={load} disabled={loading}>
                Refresh
              </button>
            </div>
          </div>

          <div className="dash-table-wrap">
            <table className="dash-table" aria-label="Accounts">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <div className="dash-equipment-cell">
                        <span className="dash-thumb"><UsersIcon size={19} /></span>
                        <div>
                          <strong>{person.fullName}{person.id === user?.id ? " (you)" : ""}</strong>
                          <span>{person.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`dash-role dash-role-${person.role}`}>{roleName(person.role)}</span>
                    </td>
                    <td>{person.createdAt?.slice(0, 10) ?? "—"}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td className="dash-empty" colSpan={3}>
                      {loading
                        ? "Loading users..."
                        : loadError ? (
                          <>
                            {loadError}{" "}
                            <button type="button" className="dash-clear-btn" onClick={load}>Try again</button>
                          </>
                        ) : search.trim() ? "No users match that search."
                          : "No users yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="dash-panel-foot">
            <span aria-live="polite">
              Showing {filtered.length} of {users.length} accounts{search.trim() ? " (filtered)" : ""}
            </span>
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
