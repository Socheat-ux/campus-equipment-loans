import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listEquipment } from "../equipment/api.js";
import { asCard } from "../equipment/cards.js";
import StudentHeader from "../components/StudentHeader.jsx";

export default function HomePage() {
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

  return (
    <div className="student-home">
      <StudentHeader active="catalog" />

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
                      ? `${item.stock} of ${item.total} available`
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

                  {item.available ? (
                    <Link className="borrow-button" to={`/requests/new?equipmentId=${item.id}`}>
                      ✓ Request Borrow
                    </Link>
                  ) : (
                    <button className="borrow-button" type="button" disabled>
                      Currently Unavailable
                    </button>
                  )}
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
