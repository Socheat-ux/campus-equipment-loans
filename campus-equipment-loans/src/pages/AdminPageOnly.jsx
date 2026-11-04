
import { Link, useLocation } from "react-router-dom";

function AdminOnlyPage() {
  const location = useLocation();

  const isHistory = location.pathname === "/history";

  const pageTitle = isHistory
    ? "Borrowing History"
    : "Request Management";

  return (
    <div className="restricted-page">

      <header className="restricted-header">
        <Link to="/" className="restricted-brand">
          <span className="restricted-logo">CG</span>
          <span>
            <strong>Campus Gear Hub</strong>
            <small>Equipment Loan System</small>
          </span>
        </Link>

        <Link to="/" className="back-home">
          Back to Catalog
        </Link>
      </header>

      <main className="restricted-container">

        <div className="restricted-card">

          <div className="restricted-icon">
            <span>🔒</span>
          </div>

          <span className="restricted-label">
            ACCESS RESTRICTED
          </span>

          <h1>{pageTitle}</h1>

          <p className="restricted-message">
            This section is exclusively available to
            administrators.
          </p>

          <p className="restricted-description">
            {isHistory
              ? "Borrowing history contains transaction records, equipment return information, and administrative records. Only authorized administrators can access and manage this information."
              : "Request management is reserved for administrators who review, approve, reject, and manage student equipment borrowing requests."}
          </p>

          <div className="restricted-notice">
            <span>ⓘ</span>
            <p>
              As a student, you can browse available equipment
              and submit borrowing requests through the catalog.
            </p>
          </div>

          <Link to="/" className="return-catalog">
            Return to Equipment Catalog
          </Link>

        </div>

      </main>

    </div>
  );
}

export default AdminOnlyPage;
