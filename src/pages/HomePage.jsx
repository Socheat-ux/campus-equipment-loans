import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { listEquipment } from "../equipment/api.js";
import NotificationBell from "../notifications/NotificationBell.jsx";

const CATEGORY_IMAGES = {
  Laptop: "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800",
  Camera: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=800",
  Projector: "https://images.unsplash.com/photo-1535016120720-40c646be5580?w=800",
  Audio: "https://images.unsplash.com/photo-1590602847861-f357a9332bbc?w=800",
  Networking: "https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=800",
  Lab: "https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?w=800",
  Accessories: "https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=800",
  Other: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800",
};

// The catalogue only stores name, category and quantity, so the card details
// that the design calls for are derived here.
function asCard(item) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    image: CATEGORY_IMAGES[item.category] ?? CATEGORY_IMAGES.Other,
    description: `${item.category} equipment available for student borrowing.`,
    assetId: `EQ-${String(item.id).padStart(4, "0")}`,
    location: "Library Tech Hub",
    available: item.quantity > 0,
    stock: item.quantity,
    maxDays: 7,
  };
}

export default function HomePage() {
  const { user, logout } = useAuth();
  const [equipment, setEquipment] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All Equipment");
  const [availableOnly, setAvailableOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rows = await listEquipment();
      setEquipment(rows.map(asCard));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const categories = useMemo(() => {
    const values = [...new Set(equipment.map((item) => item.category))].sort((a, b) =>
      a.localeCompare(b),
    );
    return ["All Equipment", ...values];
  }, [equipment]);

  const filteredEquipment = useMemo(() => {
    return equipment.filter((item) => {
      const matchesSearch =
        item.name.toLowerCase().includes(search.toLowerCase()) ||
        item.category.toLowerCase().includes(search.toLowerCase());

      const matchesCategory =
        category === "All Equipment" || item.category === category;

      const matchesAvailability = !availableOnly || item.available;

      return matchesSearch && matchesCategory && matchesAvailability;
    });
  }, [equipment, search, category, availableOnly]);

  const handleBorrow = (item) => {
    alert(`Borrow request started for: ${item.name}`);
  };

  return (
    <div className="student-home">
      <header className="home-header">
        <div className="header-brand">
          <div className="brand-logo">CG</div>
          <div>
            <h2>Campus Gear</h2>
            <p>Equipment Loan System</p>
          </div>
        </div>

        <nav className="header-nav">
          <Link to="/" className="active">
            Catalog
          </Link>
          {user && <Link to="/dashboard">Dashboard</Link>}
        </nav>

        <div className="header-profile">
          {user ? (
            <>
              <NotificationBell />
              <span className="header-profile-text">
                <strong>{user.fullName}</strong>
                <small>{user.role}</small>
              </span>
              <button
                type="button"
                className="profile-link profile-logout"
                onClick={() => logout().catch(() => {})}
              >
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
      </header>

      <main className="home-container">
        <section className="welcome-section">
          <div>
            <span className="welcome-label">STUDENT PORTAL</span>
            <h1>Find your next equipment.</h1>
            <p>
              Explore campus equipment and borrow what you need for your
              studies and projects.
            </p>
          </div>
        </section>

        <section className="search-section">
          <span className="search-icon">⌕</span>
          <input
            type="text"
            placeholder="Enter equipment name or category"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="search-button">Search</button>
        </section>

        <section className="filter-section">
          <div className="category-list">
            {categories.map((item) => (
              <button
                key={item}
                className={
                  category === item ? "category-btn selected" : "category-btn"
                }
                onClick={() => setCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>

          <label className="availability-toggle">
            <input
              type="checkbox"
              checked={availableOnly}
              onChange={(e) => setAvailableOnly(e.target.checked)}
            />
            <span>Available Now</span>
          </label>
        </section>

        <section className="equipment-section">
          <div className="section-heading">
            <div>
              <h2>Available Devices</h2>
              <p>
                {loading
                  ? "Loading equipment..."
                  : `${filteredEquipment.length} equipment found`}
              </p>
            </div>

            <select className="sort-select" defaultValue="popular">
              <option value="popular">Sort: Popular</option>
              <option value="name">Name: A-Z</option>
            </select>
          </div>

          <div className="equipment-grid">
            {filteredEquipment.map((item) => (
              <article className="equipment-card" key={item.id}>
                <div className="equipment-image">
                  <img src={item.image} alt={item.name} />

                  <span className="equipment-category">{item.category}</span>

                  <span
                    className={
                      item.available
                        ? "stock-badge in-stock"
                        : "stock-badge out-stock"
                    }
                  >
                    {item.available
                      ? `Available (${item.stock} in stock)`
                      : "Checked Out"}
                  </span>
                </div>

                <div className="equipment-info">
                  <div className="equipment-title-row">
                    <h3>{item.name}</h3>
                    <span className="max-days">Max {item.maxDays} Days</span>
                  </div>

                  <p className="equipment-description">{item.description}</p>

                  <div className="equipment-details">
                    <div>
                      <small>ASSET ID</small>
                      <strong>{item.assetId}</strong>
                    </div>

                    <div>
                      <small>LOCATION</small>
                      <strong>{item.location}</strong>
                    </div>
                  </div>

                  <button
                    className="borrow-button"
                    disabled={!item.available}
                    onClick={() => handleBorrow(item)}
                  >
                    {item.available
                      ? "✓ Request Borrow"
                      : "Currently Unavailable"}
                  </button>
                </div>
              </article>
            ))}
          </div>

          {!loading && error && (
            <div className="empty-state">
              <h3>Could not load equipment</h3>
              <p>{error}</p>
              <button className="borrow-button" type="button" onClick={load}>
                Try again
              </button>
            </div>
          )}

          {!loading && !error && filteredEquipment.length === 0 && (
            <div className="empty-state">
              <h3>No equipment found</h3>
              <p>
                {equipment.length === 0
                  ? "No equipment has been added yet."
                  : "Try another search or category."}
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
