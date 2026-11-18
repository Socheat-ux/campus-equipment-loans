import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import StudentHeader from "../components/StudentHeader.jsx";
import StatusBadge from "../borrowRequests/StatusBadge.jsx";
import { getBorrowRequest } from "../borrowRequests/api.js";
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
          </section>
        )}
      </main>
    </div>
  );
}
