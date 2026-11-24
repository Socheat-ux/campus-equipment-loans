import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import StudentHeader from "../components/StudentHeader.jsx";
import StatusBadge from "../borrowRequests/StatusBadge.jsx";
import { getBorrowRequest, cancelBorrowRequest } from "../borrowRequests/api.js";
import { formatDate } from "../equipment/cards.js";
import { CheckCircleIcon } from "../components/Icons.jsx";
import { ErrorText } from "../auth/AuthUI.jsx";

export default function BorrowRequestConfirmation() {
  const { id } = useParams();
  const location = useLocation();
  const stateRequest = location.state?.request;
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelReasonError, setCancelReasonError] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    getBorrowRequest(id)
      .then((data) => {
        if (live) setRequest(data);
      })
      .catch((err) => {
        if (live && stateRequest && String(stateRequest.id) === String(id)) setRequest(stateRequest);
        else if (live) setError(err.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // stateRequest is only a fallback after a failed load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const submitCancel = async (e) => {
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
    setCancelling(true);
    try {
      const updated = await cancelBorrowRequest(id, reason);
      setRequest(updated);
      setCancelOpen(false);
      setCancelReason("");
    } catch (err) {
      setCancelError(err.message || "Could not cancel request.");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="student-home">
      <StudentHeader active="requests" />

      <main className="confirmation-container">
        {loading && <p className="request-note">Loading your request…</p>}

        {!loading && error && (
          <section className="confirmation-card">
            <ErrorText>{error}</ErrorText>
            <p className="request-note">
              <Link className="back-link" to="/">
                Return to the catalog
              </Link>
            </p>
          </section>
        )}

        {!loading && request && (
          <section className="confirmation-card">
            <span className="confirmation-icon" aria-hidden="true">
              <CheckCircleIcon size={34} />
            </span>
            <h1>Request submitted</h1>
            <p className="confirmation-text">
              Your request is waiting for staff approval. We will notify you here when it is reviewed.
            </p>

            <dl className="confirmation-summary">
              <div>
                <dt>Item</dt>
                <dd>{request.equipmentName}</dd>
              </div>
              <div>
                <dt>Borrow date</dt>
                <dd>{formatDate(request.borrowDate)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={request.status} />
                </dd>
              </div>
            </dl>

            {request.status === "pending" && (
              <div className="confirmation-actions" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn-request-secondary"
                  onClick={() => {
                    setCancelOpen(true);
                    setCancelReason("");
                    setCancelReasonError("");
                    setCancelError("");
                  }}
                >
                  Cancel request
                </button>
              </div>
            )}
            {cancelError && <p className="request-note"><ErrorText>{cancelError}</ErrorText></p>}

            <div className="confirmation-actions">
              <Link className="btn-request-secondary" to="/">
                Back to catalog
              </Link>
              <Link
                className="btn-request-primary"
                to="/requests"
                state={{ submittedName: request.equipmentName }}
              >
                View my requests
              </Link>
            </div>

            {cancelOpen && (
              <div className="request-card" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
                <div className="request-card" style={{ maxWidth: 480, width: "100%", background: "#fff" }}>
                  <h2 style={{ marginTop: 0 }}>Cancel request</h2>
                  <p className="request-note">Why do you want to cancel this request for <strong>{request.equipmentName}</strong>?</p>
                  <form onSubmit={submitCancel}>
                    <label className="field-label" htmlFor="cancel-reason-confirm">Reason</label>
                    <textarea
                      id="cancel-reason-confirm"
                      className="request-textarea"
                      rows={4}
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      maxLength={300}
                      placeholder="Enter reason"
                    />
                    {cancelReasonError && <ErrorText>{cancelReasonError}</ErrorText>}
                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                      <button type="submit" className="btn-request-primary" disabled={cancelling}>
                        {cancelling ? "Cancelling..." : "Submit cancellation"}
                      </button>
                      <button type="button" className="btn-request-secondary" onClick={() => setCancelOpen(false)} disabled={cancelling}>
                        Keep request
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
