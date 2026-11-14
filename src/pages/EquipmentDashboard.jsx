import { useCallback, useEffect, useMemo, useState } from "react";
import { createEquipment, listEquipment, updateEquipment } from "../equipment/api.js";
import { EQUIPMENT_CATEGORIES } from "../../server/rules.js";
import { useAuth } from "../auth/AuthContext.jsx";
import DashboardLayout from "../layouts/DashboardLayout.jsx";
import EquipmentDrawer from "../components/equipment/EquipmentDrawer.jsx";
import Toast from "../components/equipment/Toast.jsx";
import {
  CategoryIcon,
  CheckCircleIcon,
  EditIcon,
  EquipmentIcon,
  PlusIcon,
  SearchIcon,
} from "../components/Icons.jsx";

const PAGE_SIZE = 8;

function StatCard({ Icon, label, value, note }) {
  return (
    <article className="dash-stat">
      <span className="dash-stat-icon"><Icon size={24} /></span>
      <div>
        <span className="dash-stat-label">{label}</span>
        <strong className="dash-stat-value">{value}</strong>
        <span className="dash-stat-note">{note}</span>
      </div>
    </article>
  );
}

// With `initialEquipment` the page runs on that data (design preview); without it, it loads /api/equipment.
export default function EquipmentDashboard({ initialEquipment, user: userProp, onLogout }) {
  const preview = initialEquipment !== undefined;
  const { user: sessionUser } = useAuth();
  const user = userProp ?? sessionUser;
  const isAdmin = user?.role === "admin";

  const [items, setItems] = useState(initialEquipment ?? []);
  const [loading, setLoading] = useState(!preview);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [drawer, setDrawer] = useState(null);
  const [toast, setToast] = useState(null);

  const closeToast = useCallback(() => setToast(null), []);
  const closeDrawer = useCallback(() => setDrawer(null), []);

  useEffect(() => {
    setPage(1);
  }, [search, category, status]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setItems(await listEquipment());
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!preview) load();
  }, [preview, load]);

  const categories = useMemo(
    () =>
      [...new Set([...EQUIPMENT_CATEGORIES, ...items.map((item) => item.category)])].sort((a, b) =>
        a.localeCompare(b),
      ),
    [items],
  );

  const filtersActive = search.trim() !== "" || category !== "all" || status !== "all";
  const clearFilters = () => {
    setSearch("");
    setCategory("all");
    setStatus("all");
  };

  // Every word typed must appear in the item's name or category, so "dell laptop" finds "Dell XPS 13 Laptop".
  const filtered = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      const haystack = `${item.name} ${item.category}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return false;
      if (category !== "all" && item.category !== category) return false;
      if (status === "available" && item.quantity <= 0) return false;
      if (status === "out" && item.quantity > 0) return false;
      return true;
    });
  }, [items, search, category, status]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const rangeStart = filtered.length === 0 ? 0 : start + 1;
  const rangeEnd = Math.min(start + PAGE_SIZE, filtered.length);

  const totalRecords = items.length;
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  // Only categories that have equipment, not the full list of choices offered in the form.
  const categoryCount = new Set(items.map((item) => item.category)).size;

  // Throws on a server error so the drawer can show it and stay open.
  async function handleSave(values, mode) {
    if (mode === "edit" && drawer?.item) {
      const saved = preview ? { ...drawer.item, ...values } : await updateEquipment(drawer.item.id, values);
      setItems((previous) => previous.map((item) => (item.id === saved.id ? saved : item)));
      setToast({ type: "success", message: "Equipment updated successfully." });
    } else {
      const nextId = items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
      const saved = preview ? { id: nextId, ...values } : await createEquipment(values);
      setItems((previous) => [saved, ...previous]);
      setPage(1);
      setToast({ type: "success", message: `“${values.name}” was added to the catalogue.` });
    }
    setDrawer(null);
  }

  return (
    <DashboardLayout user={user} onLogout={onLogout}>
      <div className="dash-page">
        <nav className="dash-breadcrumb" aria-label="Breadcrumb">
          <span>Home</span>
          <span aria-hidden="true">/</span>
          <span>Inventory</span>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Equipment</span>
        </nav>

        <div className="dash-page-head">
          <div>
            <h1>Equipment Management</h1>
            <p>Manage the university equipment catalogue and available quantities.</p>
          </div>
          {isAdmin && (
            <button
              type="button"
              className="btn-primary dash-add-btn"
              onClick={() => setDrawer({ mode: "add" })}
            >
              <PlusIcon size={18} />
              Add equipment
            </button>
          )}
        </div>

        <section className="dash-stats" aria-label="Equipment summary">
          <StatCard
            Icon={EquipmentIcon}
            label="Total Equipment"
            value={totalRecords}
            note="Equipment records"
          />
          <StatCard
            Icon={CheckCircleIcon}
            label="Available Items"
            value={totalQuantity}
            note="Total quantity in stock"
          />
          <StatCard
            Icon={CategoryIcon}
            label="Categories"
            value={categoryCount}
            note="Distinct categories"
          />
        </section>

        <section className="dash-panel" aria-labelledby="catalogue-title">
          <div className="dash-panel-head">
            <div>
              <h2 id="catalogue-title">Equipment Catalogue</h2>
              <p>Search, filter, and maintain every record in the inventory.</p>
            </div>
            <div className="dash-filters">
              <label className="dash-search">
                <SearchIcon size={17} />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Enter name or category"
                  aria-label="Search equipment"
                />
              </label>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                aria-label="Filter by category"
              >
                <option value="all">All categories</option>
                {categories.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                aria-label="Filter by status"
              >
                <option value="all">All statuses</option>
                <option value="available">Available</option>
                <option value="out">Out of stock</option>
              </select>
              {filtersActive && (
                <button type="button" className="dash-clear-btn" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          </div>

          <div className="dash-table-wrap">
            <table className="dash-table" aria-label="Equipment catalogue">
              <thead>
                <tr>
                  <th>Equipment</th>
                  <th>Category</th>
                  <th>Total Quantity</th>
                  <th>Available</th>
                  <th>Status</th>
                  {isAdmin && <th className="dash-actions-col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="dash-equipment-cell">
                        <span className="dash-thumb"><EquipmentIcon size={19} /></span>
                        <div>
                          <strong>{item.name}</strong>
                          <span>ID #{item.id}</span>
                        </div>
                      </div>
                    </td>
                    <td><span className="dash-category">{item.category}</span></td>
                    <td>{item.quantity}</td>
                    <td>{item.quantity}</td>
                    <td>
                      <span className={`dash-status ${item.quantity > 0 ? "is-available" : "is-out"}`}>
                        <span className="dot" />
                        {item.quantity > 0 ? "Available" : "Out of stock"}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="dash-actions-col">
                        <button
                          type="button"
                          className="dash-edit-btn"
                          onClick={() => setDrawer({ mode: "edit", item })}
                        >
                          <EditIcon size={15} />
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td className="dash-empty" colSpan={isAdmin ? 6 : 5}>
                      {loading
                        ? "Loading equipment..."
                        : loadError ? (
                          <>
                            {loadError}{" "}
                            <button type="button" className="dash-clear-btn" onClick={load}>Try again</button>
                          </>
                        ) : filtersActive
                          ? "No equipment matches the current search and filters."
                          : "No equipment yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="dash-panel-foot">
            <span aria-live="polite">
              Showing {rangeStart}–{rangeEnd} of {filtered.length} records
              {filtersActive && items.length !== filtered.length ? ` (filtered from ${items.length})` : ""}
            </span>
            {pageCount > 1 && (
              <div className="dash-pagination" aria-label="Pagination">
                <button
                  type="button"
                  disabled={currentPage === 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  Previous
                </button>
                {Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => (
                  <button
                    key={number}
                    type="button"
                    className={number === currentPage ? "is-current" : undefined}
                    aria-current={number === currentPage ? "page" : undefined}
                    onClick={() => setPage(number)}
                  >
                    {number}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={currentPage === pageCount}
                  onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      {isAdmin && drawer && (
        <EquipmentDrawer
          mode={drawer.mode}
          item={drawer.item}
          onClose={closeDrawer}
          onSave={handleSave}
        />
      )}

      <Toast toast={toast} onClose={closeToast} />
    </DashboardLayout>
  );
}
