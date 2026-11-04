
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

const equipmentData = [
  {
    id: 1,
    name: "Apple MacBook Pro 16” M3 Max",
    category: "Laptops",
    image:
      "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800",
    description: "36GB Unified RAM • 1TB High-speed SSD • MagSafe Charger",
    assetId: "MBP-084-LAB",
    location: "Locker B-04",
    available: true,
    stock: 5,
    maxDays: 7,
  },
  {
    id: 2,
    name: "Sony Alpha FX3 Cinema Camera Kit",
    category: "Cameras",
    image:
      "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=800",
    description: "4K 120p • 24–70mm Lens • 2x 160GB CFexpress cards",
    assetId: "CAM-FX3-02",
    location: "Desk Cage 2",
    available: true,
    stock: 3,
    maxDays: 3,
  },
  {
    id: 3,
    name: "Epson Pro EX9240 Wireless 1080p",
    category: "Projectors",
    image:
      "https://images.unsplash.com/photo-1535016120720-40c646be5580?w=800",
    description: "4,000 Lumens • Full HD 1080p • HDMI • Miracast",
    assetId: "PRJ-EPS-11",
    location: "Locker A-09",
    available: true,
    stock: 4,
    maxDays: 2,
  },
  {
    id: 4,
    name: "Dell Precision 7680 Workstation",
    category: "Laptops",
    image:
      "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800",
    description: "NVIDIA RTX 4080 • 64GB RAM • SolidWorks",
    assetId: "DELL-7680-01",
    location: "Locker B-02",
    available: false,
    stock: 0,
    maxDays: 5,
  },
];

const categories = [
  "All Equipment",
  "Laptops",
  "Cameras",
  "Projectors",
  "Other",
];

function HomePage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All Equipment");
  const [availableOnly, setAvailableOnly] = useState(false);

  const filteredEquipment = useMemo(() => {
    return equipmentData.filter((item) => {
      const matchesSearch =
        item.name.toLowerCase().includes(search.toLowerCase()) ||
        item.category.toLowerCase().includes(search.toLowerCase());

      const matchesCategory =
        category === "All Equipment" || item.category === category;

      const matchesAvailability =
        !availableOnly || item.available;

      return matchesSearch && matchesCategory && matchesAvailability;
    });
  }, [search, category, availableOnly]);

  const handleBorrow = (item) => {
    alert(`Borrow request started for: ${item.name}`);
  };

  return (
    <div className="student-home">

      {/* HEADER */}
      <header className="home-header">
        <div className="header-brand">
          <div className="brand-logo">CG</div>
          <div>
            <h2>Campus Gear </h2>
            <p>Equipment Loan System</p>
          </div>
        </div>

        <nav className="header-nav">
          <a href="/" className="active">Catalog</a>
          <Link to="/my-requests">My Requests</Link>
          <Link to="/history">History</Link>
        </nav>

        <div className="header-profile">
          <Link className="profile-link" to="/login">Log in</Link>
          <Link className="profile-signup" to="/signup">Create account</Link>
        </div>
      </header>

      {/* MAIN CONTENT */}
      <main className="home-container">

        {/* WELCOME */}
        <section className="welcome-section">
          <div>
            <span className="welcome-label">STUDENT PORTAL</span>
            <h1>Find your next equipment.</h1>
            <p>
              Explore campus equipment and borrow what you need
              for your studies and projects.
            </p>
          </div>
        </section>

        {/* SEARCH */}
        <section className="search-section">
          <span className="search-icon">⌕</span>
          <input
            type="text"
            placeholder="Search laptops, cameras, projectors..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="search-button">Search</button>
        </section>

        {/* CATEGORY FILTERS */}
        <section className="filter-section">
          <div className="category-list">
            {categories.map((item) => (
              <button
                key={item}
                className={
                  category === item
                    ? "category-btn selected"
                    : "category-btn"
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

        {/* ANNOUNCEMENT */}
        <section className="announcement">
          <div className="announcement-icon">▣</div>
          <div className="announcement-content">
            <strong>LIBRARY TECH HUB</strong>
            <p>
              Open until 8:00 PM · Fast 1-tap QR pickup
              upon admin check-out approval.
            </p>
          </div>
          <span className="announcement-arrow">→</span>
        </section>

        {/* EQUIPMENT */}
        <section className="equipment-section">
          <div className="section-heading">
            <div>
              <h2>Available Devices</h2>
              <p>{filteredEquipment.length} equipment found</p>
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

                  <span className="equipment-category">
                    {item.category}
                  </span>

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
                    <span className="max-days">
                      Max {item.maxDays} Days
                    </span>
                  </div>

                  <p className="equipment-description">
                    {item.description}
                  </p>

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

          {filteredEquipment.length === 0 && (
            <div className="empty-state">
              <h3>No equipment found</h3>
              <p>Try another search or category.</p>
            </div>
          )}
        </section>

      </main>
    </div>
  );
}

export default HomePage;
