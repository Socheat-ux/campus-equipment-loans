import { useCallback, useEffect, useState } from "react";
import DashboardLayout from "../layouts/DashboardLayout.jsx";
import Toast from "../components/equipment/Toast.jsx";
import { ErrorText } from "../auth/AuthUI.jsx";
import { formatDate } from "../equipment/cards.js";
import { REJECTION_REASON_MAX, todayISO } from "../../server/rules.js";
import {
  approveBorrowRequest,
  cancelBorrowRequestAdmin,
  listAdminBorrowRequests,
  rejectBorrowRequest,
  returnBorrowRequest,
} from "../borrowRequests/adminApi.js";

const FILTERS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "cancelled", label: "Cancelled" },
];

const EMPTY_COUNTS = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };

export default function AdminBorrowRequests() {
  const [status, setStatus] = useState("pending");
  const [data, setData] = useState({ requests: [], counts: EMPTY_COUNTS });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState(null);
  const [review, setReview] = useState(null);
  const [stage, setStage] = useState("review");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [adminCancel, setAdminCancel] = useState(null); // { id, requesterName, equipmentName }
  const [adminCancelReason, setAdminCancelReason] = useState("");
  const [adminCancelError, setAdminCancelError] = useState("");
  // A pending request whose start date is before today (Cambodia day from the server) can only be rejected.
  const startPassed = (request) => request.status === "pending" && request.borrowDate < (data.today ?? todayISO());

  const load = useCallback(async (nextStatus) => {
    setLoading(true);
    setError("");
    try {
      setData(await listAdminBorrowRequests(nextStatus));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(status);
  }, [load, status]);

  const closeReview = () => {
    if (busy) return;
    setReview(null);
    setStage("review");
    setReason("");
  };

  const openReview = (request) => {
    setReview(request);
    setStage("review");
    setReason("");
  };

  const decide = async (decision) => {
    if (!review || busy) return;
    const trimmed = reason.trim();
    if (decision === "reject" && !trimmed) {
      setToast({ type: "error", message: "A reason is required." });
      return;
    }
    setBusy(true);
    try {
      if (decision === "approve") await approveBorrowRequest(review.id);
      else await rejectBorrowRequest(review.id, trimmed);
      setToast({ type: "success", message: decision === "approve" ? "Request approved." : "Request rejected." });
      setReview(null);
      setStage("review");
      setReason("");
      await load(status);
    } catch (err) {
      setToast({ type: "error", message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const markReturned = async (request) => {
    if (busy) return;
    setBusy(true);
    try {
      await returnBorrowRequest(request.id);
      setToast({ type: "success", message: "Equipment return recorded." });
      await load(status);
    } catch (err) {
      setToast({ type: "error", message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const pending = data.counts.pending ?? 0;

  return (
    <DashboardLayout active="requests">
      <div className="dash-page">
        <nav className="dash-breadcrumb" aria-label="Breadcrumb">
          <span>Home</span>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Borrow requests</span>
        </nav>

        <div className="dash-page-head">
          <div>
            <h1>Borrow requests</h1>
            <p>{pending} requests are waiting for your review.</p>
          </div>
        </div>

        <section className="dash-panel dash-requests-panel" aria-labelledby="borrow-requests-title">
          <div className="dash-panel-head">
            <div>
              <h2 id="borrow-requests-title">Requests</h2>
              <p>
                {status === "cancelled"
                  ? "Cancelled requests with reason (when provided)."
                  : "Approve or reject equipment loans submitted by students and faculty."}
              </p>
            </div>
            <div className="dash-request-filters" role="group" aria-label="Filter requests by status">
              {FILTERS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`dash-filter-pill${status === key ? " is-active" : ""}`}
                  aria-pressed={status === key}
                  onClick={() => {
                    setStatus(key);
                    closeReview();
                  }}
                >
                  {label}
                  <span>{data.counts[key] ?? 0}</span>
                </button>
              ))}
            </div>
          </div>

          {loading && <p className="dash-empty">Loading requests…</p>}

          {!loading && error && (
            <div className="dash-empty">
              <ErrorText>{error}</ErrorText>
              <button type="button" className="dash-clear-btn" onClick={() => load(status)}>
                Try again
              </button>
            </div>
          )}

          {!loading && !error && data.requests.length === 0 && (
            <p className="dash-empty">No {status} requests.</p>
          )}

          {!loading && !error && data.requests.length > 0 && (
            <div className="dash-table-wrap">
              <table className="dash-table dash-requests-table">
                <thead>
                  <tr>
                    <th scope="col">Requester</th>
                    <th scope="col">Item</th>
                    <th scope="col">Borrow date</th>
                    {status === "cancelled" ? (
                      <th scope="col">Reason for cancelling</th>
                    ) : (
                      <>
                        <th scope="col">Return by</th>
                        <th scope="col">Stock</th>
                      </>
                    )}
                    {status !== "cancelled" && <th scope="col" className="dash-actions-col">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.requests.map((request) => (
                    <tr key={request.id}>
                      <td>
                        <strong>{request.requesterName}</strong>
                        <small>{request.requesterRole}</small>
                      </td>
                      <td>
                        <strong>{request.equipmentName}</strong>
                        <small>{request.equipmentAssetId}</small>
                      </td>
                      <td>{formatDate(request.borrowDate)}</td>
                      {status === "cancelled" ? (
                        <td>{request.decisionReason || "—"}</td>
                      ) : (
                        <>
                          <td>{formatDate(request.returnDate)}</td>
                          <td>{request.stock} of {request.total} available</td>
                        </>
                      )}
                      {status !== "cancelled" && (
                        <td className="dash-actions-col">
                          {request.status === "pending" ? (
                            <div className="dash-request-actions">
                              {startPassed(request) && <span className="dash-status is-out">Start date passed</span>}
                              <button type="button" className="dash-reject-btn" disabled={busy} onClick={() => openReview(request)}>
                                Reject
                              </button>
                              {!startPassed(request) && (
                                <button type="button" className="btn-primary dash-save-btn" disabled={busy} onClick={() => openReview(request)}>
                                  Approve
                                </button>
                              )}
                            </div>
                          ) : (request.status === "approved" || request.status === "rejected") ? (
                            <div className="dash-request-actions">
                              {request.status === "approved" && (
                                <button type="button" className="btn-primary dash-save-btn" disabled={busy} onClick={() => markReturned(request)}>
                                  Record return
                                </button>
                              )}
                              <button
                                type="button"
                                className="dash-reject-btn"
                                disabled={busy}
                                onClick={() => {
                                  if (busy) return;
                                  setAdminCancel({ id: request.id, requesterName: request.requesterName, equipmentName: request.equipmentName });
                                  setAdminCancelReason("");
                                  setAdminCancelError("");
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : null}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {review && (
        <div
          className="dash-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeReview();
          }}
        >
          <section className="dash-review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title">
            <div className="dash-drawer-head">
              <div>
                <h2 id="review-title">Review request</h2>
                <p>{review.requesterName} · {review.equipmentName}</p>
              </div>
              <button type="button" className="dash-drawer-close" aria-label="Close review dialog" onClick={closeReview} disabled={busy}>
                ×
              </button>
            </div>

            <div className="dash-drawer-body">
              {stage === "review" ? (
                <>
                  <dl className="dash-review-details">
                    <div><dt>Requester</dt><dd>{review.requesterName}</dd></div>
                    <div><dt>Item</dt><dd>{review.equipmentName} ({review.equipmentAssetId})</dd></div>
                    <div><dt>Borrow date</dt><dd>{formatDate(review.borrowDate)}</dd></div>
                    <div><dt>Return by</dt><dd>{formatDate(review.returnDate)}</dd></div>
                    <div><dt>Purpose</dt><dd>{review.purpose || "—"}</dd></div>
                  </dl>
                  <p className="dash-review-note">
                    {startPassed(review)
                      ? "Start date passed. Reject this request so the student can send a new one."
                      : `${review.stock} of ${review.total} available. Approving reserves this item for the borrow dates.`}
                  </p>
                </>
              ) : (
                <>
                  <p className="dash-review-note">Rejecting {review.equipmentName} for {review.requesterName}.</p>
                  <div className="field dash-reason-field">
                    <label htmlFor="reject-reason">Reason for rejection (shown to the student)</label>
                    <textarea
                      id="reject-reason"
                      value={reason}
                      maxLength={REJECTION_REASON_MAX}
                      rows={5}
                      required
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="dash-drawer-foot">
              {stage === "review" ? (
                <>
                  <button type="button" className="btn-outline" onClick={closeReview} disabled={busy}>Cancel</button>
                  <button type="button" className="dash-reject-btn" onClick={() => setStage("reject")} disabled={busy}>Reject</button>
                  {!startPassed(review) && (
                    <button type="button" className="btn-primary dash-save-btn" onClick={() => decide("approve")} disabled={busy}>
                      Approve request
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button type="button" className="btn-outline" onClick={() => setStage("review")} disabled={busy}>Back</button>
                  <button
                    type="button"
                    className="dash-danger-btn"
                    onClick={() => decide("reject")}
                    disabled={busy || !reason.trim()}
                  >
                    Confirm rejection
                  </button>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {adminCancel && (
        <div
          className="dash-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setAdminCancel(null);
              setAdminCancelReason("");
              setAdminCancelError("");
            }
          }}
        >
          <section className="dash-review-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-cancel-title">
            <div className="dash-drawer-head">
              <div>
                <h2 id="admin-cancel-title">Cancel request (admin)</h2>
                <p>{adminCancel.requesterName} · {adminCancel.equipmentName}</p>
              </div>
              <button
                type="button"
                className="dash-drawer-close"
                aria-label="Close cancel dialog"
                onClick={() => {
                  if (busy) return;
                  setAdminCancel(null);
                  setAdminCancelReason("");
                  setAdminCancelError("");
                }}
                disabled={busy}
              >
                ×
              </button>
            </div>
            <div className="dash-drawer-body">
              <p className="dash-review-note">Optional reason (shown to the requester). Max 300 characters.</p>
              <div className="field dash-reason-field">
                <label htmlFor="admin-cancel-reason">Reason for cancelling</label>
                <textarea
                  id="admin-cancel-reason"
                  value={adminCancelReason}
                  maxLength={300}
                  rows={4}
                  onChange={(event) => setAdminCancelReason(event.target.value)}
                />
              </div>
              {adminCancelError && <ErrorText>{adminCancelError}</ErrorText>}
            </div>
            <div className="dash-drawer-foot">
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  if (busy) return;
                  setAdminCancel(null);
                  setAdminCancelReason("");
                  setAdminCancelError("");
                }}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="dash-danger-btn"
                disabled={busy}
                onClick={async () => {
                  const trimmed = adminCancelReason.trim();
                  if (trimmed.length > 300) {
                    setAdminCancelError("Reason must be 300 characters or fewer.");
                    return;
                  }
                  setAdminCancelError("");
                  setBusy(true);
                  try {
                    await cancelBorrowRequestAdmin(adminCancel.id, trimmed || undefined);
                    setToast({ type: "success", message: "Request cancelled." });
                    setAdminCancel(null);
                    setAdminCancelReason("");
                    await load(status);
                  } catch (err) {
                    setToast({ type: "error", message: err.message });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Cancelling..." : "Confirm cancellation"}
              </button>
            </div>
          </section>
        </div>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </DashboardLayout>
  );
}
