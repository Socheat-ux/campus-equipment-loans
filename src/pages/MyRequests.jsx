import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import StudentHeader from "../components/StudentHeader.jsx";
import StatusBadge from "../borrowRequests/StatusBadge.jsx";
import { listBorrowRequests, cancelBorrowRequest } from "../borrowRequests/api.js";
import { formatDate } from "../equipment/cards.js";
import { ErrorText } from "../auth/AuthUI.jsx";
import { CheckCircleIcon } from "../components/Icons.jsx";

export default function MyRequests() {
  const location = useLocation();
  const submittedName = location.state?.submittedName;
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cancellingId, setCancellingId] = useState(null);
  const [cancelError, setCancelError] = useState("");
  const [cancelledName, setCancelledName] = useState("");
  const [cancelModal, setCancelModal] = useState(null); // { id, equipmentName }
  const [cancelReason, setCancelReason] = useState("");
  const [cancelReasonError, setCancelReasonError] = useState("");

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

  const openCancelModal = (request) => {
    setCancelModal({ id: request.id, equipmentName: request.equipmentName });
    setCancelReason("");
    setCancelReasonError("");
    setCancelError("");
  };

  const closeCancelModal = () => {
    if (cancellingId) return;
    setCancelModal(null);
    setCancelReason("");
    setCancelReasonError("");
  };

  const onCancelSubmit = async (e) => {
    e.preventDefault();
    const reason = cancelReason.trim();
    if (!reason) {
      setCancelReasonError("Reason is required.");
      return;
    }
    if (reason.length > 300) {
      setCancelReasonError("Reason must be 300 characters or fewer.");
      return;
    }
    setCancelReasonError("");
    setCancelError("");
    setCancelledName("");
    setCancellingId(cancelModal.id);
    try {
      const updated = await cancelBorrowRequest(cancelModal.id, reason);
      setRequests((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setCancelledName(updated.equipmentName || cancelModal.equipmentName);
      setCancelModal(null);
      setCancelReason("");
    } catch (err) {
      setCancelError(err.message || "Could not cancel request.");
    } finally {
      setCancellingId(null);
    }
  };

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

        {cancelledName && (
          <p className="request-banner" role="status">
            <CheckCircleIcon size={20} />
            <span>Request for {cancelledName} cancelled.</span>
          </p>
        )}

        {cancelError && (
          <section className="request-card">
            <ErrorText>{cancelError}</ErrorText>
          </section>
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
                  <th scope="col">Action</th>
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
                          Pick up at {request.equipmentLocation} on {formatDate(request.borrowDate)}. {remainingTime(request.returnDate)}
                        </small>
                      )}
                      {request.status === "returned" && request.returnedAt && <small className="request-status-note">Returned on {formatDate(request.returnedAt.slice(0, 10))}.</small>}
                      {request.status === "rejected" && request.decisionReason && (
                        <small className="request-status-note">Reason: {request.decisionReason}</small>
                      )}
                    </td>
                    <td data-label="Action">
                      {request.status === "pending" ? (
                        <button
                          type="button"
                          className="btn-request-secondary"
                          onClick={() => openCancelModal(request)}
                          disabled={cancellingId === request.id}
                        >
                          Cancel
                        </button>
                      ) : (
                        <span className="request-note">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {cancelModal && (
        <div className="request-card" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="request-card" style={{ maxWidth: 480, width: "100%", background: "#fff" }}>
            <h2 style={{ marginTop: 0 }}>Cancel request</h2>
            <p className="request-note">Provide a reason for cancelling your request for <strong>{cancelModal.equipmentName}</strong>.</p>
            <form onSubmit={onCancelSubmit}>
              <label className="field-label" htmlFor="cancel-reason">Reason</label>
              <textarea
                id="cancel-reason"
                className="request-textarea"
                rows={4}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                maxLength={300}
                placeholder="Enter a reason for cancelling"
              />
              {cancelReasonError && <ErrorText>{cancelReasonError}</ErrorText>}
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button type="submit" className="btn-request-primary" disabled={cancellingId === cancelModal.id}>
                  {cancellingId === cancelModal.id ? "Cancelling..." : "Submit cancellation"}
                </button>
                <button type="button" className="btn-request-secondary" onClick={closeCancelModal} disabled={cancellingId === cancelModal.id}>
                  Keep request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function remainingTime(returnDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${returnDate}T00:00:00`);
  const days = Math.ceil((due - today) / 86400000);
  if (days < 0) return `Overdue by ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"}.`;
  if (days === 0) return "Due today.";
  return `${days} ${days === 1 ? "day" : "days"} remaining.`;
}
