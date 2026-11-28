import { useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import StudentHeader from "../components/StudentHeader.jsx";
import { getEquipment } from "../equipment/api.js";
import { asCard } from "../equipment/cards.js";
import { createBorrowRequest } from "../borrowRequests/api.js";
import { ErrorText } from "../auth/AuthUI.jsx";
import {
  addDaysISO,
  borrowRequestInput,
  BORROW_MAX_ADVANCE_DAYS,
  BORROW_MAX_DAYS,
  PURPOSE_MAX,
  todayISO,
} from "../../../shared/rules.js";

export default function BorrowRequestNew() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const equipmentId = Number(params.get("equipmentId"));
  const today = todayISO();
  const latestBorrowDate = addDaysISO(today, BORROW_MAX_ADVANCE_DAYS);

  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [borrowDate, setBorrowDate] = useState(today);
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState("");
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const [existingRequestId, setExistingRequestId] = useState(null); // set when the server says a pending request already exists

  const errorId = useId();
  const dateFieldId = useId();
  const returnFieldId = useId();
  const purposeFieldId = useId();
  const datesHintId = useId();
  const equipmentErrorId = useId();

  useEffect(() => {
    if (!Number.isInteger(equipmentId) || equipmentId < 1) {
      setLoadError("Choose an item from the catalog to start a request.");
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setLoadError("");
    getEquipment(equipmentId)
      .then((raw) => {
        if (live) setItem(asCard(raw));
      })
      .catch((err) => {
        if (live) setLoadError(err.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [equipmentId]);

  // Memoised so ErrorText (which refocuses when its children change) does not refocus on every keystroke.
  const alertContent = useMemo(
    () => (error && existingRequestId ? <>{error} <Link to="/requests">View my requests</Link></> : error),
    [error, existingRequestId],
  );

  const returnDate = borrowDate ? addDaysISO(borrowDate, item?.maxDays ?? BORROW_MAX_DAYS) : "";
  const unavailable = Boolean(item && !item.available);
  const borrowFieldError = fields.borrowDate;

  async function submit(event) {
    event.preventDefault();
    setError("");
    setFields({});
    setExistingRequestId(null);

    if (!item) {
      setError(loadError || "Choose an item from the catalog to start a request.");
      return;
    }
    if (unavailable) {
      const message = "This item is no longer available.";
      setError(message);
      setFields({ equipmentId: message });
      return;
    }

    const check = borrowRequestInput({ equipmentId: item.id, borrowDate, purpose }, today);
    setFields(check.fields);
    if (Object.keys(check.fields).length) {
      setError("Please fix the fields below.");
      return;
    }

    setBusy(true);
    try {
      const request = await createBorrowRequest({
        equipmentId: item.id,
        borrowDate: check.value.borrowDate,
        purpose,
      });
      navigate(`/requests/${request.id}/confirmation`, { replace: true, state: { request } });
    } catch (err) {
      setError(err.message);
      setFields(err.fields || {});
      setExistingRequestId(err.existingRequestId ?? null);
      setBusy(false);
    }
  }

  return (
    <div className="student-home">
      <StudentHeader active="catalog" />

      <main className="request-container">
        <Link className="back-link" to="/">
          <span aria-hidden="true">←</span> Back to catalog
        </Link>
        <h1 className="request-title">Request to borrow</h1>

        {loading && <p className="request-note">Loading item…</p>}

        {!loading && loadError && (
          <section className="request-card">
            <ErrorText id={errorId}>{loadError}</ErrorText>
            <p className="request-note">
              <Link className="back-link" to="/">
                Return to the catalog
              </Link>
            </p>
          </section>
        )}

        {!loading && !loadError && item && (
          <div className="request-grid">
            <section className="request-card" aria-labelledby="borrow-details-title">
              <h2 id="borrow-details-title" className="request-card-title">
                Borrow details
              </h2>

              <form onSubmit={submit} noValidate>
                <div className="field">
                  <label htmlFor={dateFieldId}>Borrow date</label>
                  <input
                    id={dateFieldId}
                    type="date"
                    required
                    min={today}
                    max={latestBorrowDate}
                    value={borrowDate}
                    onChange={(event) => setBorrowDate(event.target.value)}
                    aria-invalid={borrowFieldError ? true : undefined}
                    aria-describedby={`${datesHintId}${borrowFieldError ? ` ${errorId}` : ""}`}
                  />
                  {borrowFieldError && <p className="field-error">{borrowFieldError}</p>}
                </div>

                <div className="field">
                  <label htmlFor={returnFieldId}>Return by</label>
                  <input
                    id={returnFieldId}
                    type="date"
                    min={returnDate || undefined}
                    max={returnDate || undefined}
                    value={returnDate}
                    onChange={() => {}}
                    aria-readonly="true"
                    aria-describedby={datesHintId}
                  />
                </div>
                <p className="hint" id={datesHintId}>
                  Pick a date from today up to {BORROW_MAX_ADVANCE_DAYS} days ahead. Return date is set automatically (max {item.maxDays} days).
                </p>

                <div className="field">
                  <label htmlFor={purposeFieldId}>
                    Purpose <span className="field-optional">(optional)</span>
                  </label>
                  <textarea
                    id={purposeFieldId}
                    rows={4}
                    maxLength={PURPOSE_MAX}
                    value={purpose}
                    onChange={(event) => setPurpose(event.target.value)}
                    placeholder="Enter the purpose of your loan"
                  />
                  {fields.purpose && <p className="field-error">{fields.purpose}</p>}
                </div>

                {(fields.equipmentId || unavailable) && (
                  <p className="field-error" id={equipmentErrorId}>
                    {fields.equipmentId || "This item is no longer available."}
                  </p>
                )}

                <ErrorText id={errorId}>{alertContent}</ErrorText>

                <div className="request-actions">
                  <Link className="btn-request-secondary" to="/">
                    Cancel
                  </Link>
                  <button className="btn-request-primary" type="submit" disabled={busy || unavailable}>
                    {busy ? "Submitting…" : "Submit request"}
                  </button>
                </div>
              </form>
            </section>

            <aside className="selected-item-card" aria-labelledby="selected-item-title">
              <img className="selected-item-image" src={item.image} alt="" />
              <div className="selected-item-body">
                <span className="selected-item-label">Selected item</span>
                <h2 id="selected-item-title">{item.name}</h2>
                <span
                  className={item.available ? "availability-pill in-stock" : "availability-pill out-stock"}
                >
                  {`${item.stock} of ${item.total} available`}
                </span>

                <dl className="selected-item-details">
                  <div>
                    <dt>Asset ID</dt>
                    <dd>{item.assetId}</dd>
                  </div>
                  <div>
                    <dt>Location</dt>
                    <dd>{item.location}</dd>
                  </div>
                </dl>

                <p className="max-loan-note">Max loan: {item.maxDays} days</p>
              </div>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
