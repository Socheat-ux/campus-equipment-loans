import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import StudentHeader from "../components/StudentHeader.jsx";
import StatusBadge from "../borrowRequests/StatusBadge.jsx";
import { listBorrowRequests } from "../borrowRequests/api.js";
import { formatDate } from "../equipment/cards.js";
import { ErrorText } from "../auth/AuthUI.jsx";
import { CheckCircleIcon } from "../components/Icons.jsx";

export default function MyRequests() {
  const location = useLocation();
  const submittedName = location.state?.submittedName;
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRequests(await listBorrowRequests());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="student-home">
      <StudentHeader active="requests" />

      <main className="requests-container">
        <div className="requests-heading">
          <div>
            <h1>My requests</h1>
            <p>Borrowing requests you have sent to campus staff.</p>
          </div>
          <Link className="btn-request-primary requests-new-link" to="/">
            Browse catalog
          </Link>
        </div>

        {submittedName && (
          <p className="request-banner" role="status">
            <CheckCircleIcon size={20} />
            <span>Request for {submittedName} submitted. Awaiting approval.</span>
          </p>
        )}

        {loading && <p className="request-note">Loading your requests…</p>}

        {!loading && error && (
          <section className="request-card">
            <ErrorText>{error}</ErrorText>
            <button className="btn-request-secondary" type="button" onClick={load}>
              Try again
            </button>
          </section>
        )}

        {!loading && !error && requests.length === 0 && (
          <section className="request-card empty-requests">
            <h2>No requests yet</h2>
            <p>Pick an available item from the catalog to send your first borrowing request.</p>
            <Link className="btn-request-primary" to="/">
              Browse catalog
            </Link>
          </section>
        )}

        {!loading && !error && requests.length > 0 && (
          <div className="requests-table-wrap">
            <table className="requests-table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Borrow date</th>
                  <th scope="col">Return by</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td data-label="Item">
                      <strong>{request.equipmentName}</strong>
                      <small>{request.equipmentCategory}</small>
                    </td>
                    <td data-label="Borrow date">{formatDate(request.borrowDate)}</td>
                    <td data-label="Return by">{formatDate(request.returnDate)}</td>
                    <td data-label="Status">
                      <StatusBadge status={request.status} />
                      {request.status === "approved" && (
                        <small className="request-status-note">
                          Pick up at {request.equipmentLocation} on {formatDate(request.borrowDate)}.
                        </small>
                      )}
                      {request.status === "rejected" && request.decisionReason && (
                        <small className="request-status-note">Reason: {request.decisionReason}</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
