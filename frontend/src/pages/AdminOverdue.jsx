import { useCallback, useEffect, useState } from "react";
import DashboardLayout from "../layouts/DashboardLayout.jsx";
import { ErrorText } from "../auth/AuthUI.jsx";
import { formatDate } from "../equipment/cards.js";
import { listOverdueLoans } from "../borrowRequests/overdueApi.js";

export default function AdminOverdue() {
  const [data, setData] = useState({ overdue: [], today: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await listOverdueLoans());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <DashboardLayout active="overdue">
      <div className="dash-page">
        <nav className="dash-breadcrumb" aria-label="Breadcrumb">
          <span>Home</span><span aria-hidden="true">/</span><span aria-current="page">Overdue loans</span>
        </nav>
        <div className="dash-page-head">
          <div>
            <h1>Overdue loans</h1>
            <p>Approved equipment loans that have passed their return date.</p>
          </div>
          <button type="button" className="dash-clear-btn" onClick={load} disabled={loading}>Refresh</button>
        </div>
        <section className="dash-panel" aria-labelledby="overdue-title">
          <div className="dash-panel-head">
            <div><h2 id="overdue-title">Equipment to follow up</h2><p>As of {formatDate(data.today)}</p></div>
            <strong className="overdue-count">{data.overdue.length} overdue</strong>
          </div>
          {loading && <p className="dash-empty">Loading overdue loans…</p>}
          {!loading && error && <div className="dash-empty"><ErrorText>{error}</ErrorText><button type="button" className="dash-clear-btn" onClick={load}>Try again</button></div>}
          {!loading && !error && data.overdue.length === 0 && <p className="dash-empty">No equipment is overdue.</p>}
          {!loading && !error && data.overdue.length > 0 && (
            <div className="dash-table-wrap">
              <table className="dash-table">
                <thead><tr><th scope="col">Equipment</th><th scope="col">Borrower</th><th scope="col">Borrowed</th><th scope="col">Return by</th><th scope="col">Late</th><th scope="col">Location</th></tr></thead>
                <tbody>{data.overdue.map((loan) => (
                  <tr key={loan.id}>
                    <td><strong>{loan.equipmentName}</strong><small>{loan.equipmentAssetId} · {loan.equipmentCategory}</small></td>
                    <td><strong>{loan.requesterName}</strong><small>{loan.requesterEmail}</small></td>
                    <td>{formatDate(loan.borrowDate)}</td>
                    <td>{formatDate(loan.returnDate)}</td>
                    <td><span className="overdue-late">{loan.daysOverdue} {loan.daysOverdue === 1 ? "day" : "days"}</span></td>
                    <td>{loan.equipmentLocation}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
