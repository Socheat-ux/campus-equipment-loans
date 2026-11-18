export const STATUS_LABELS = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  returned: "Returned",
  cancelled: "Cancelled",
};

export default function StatusBadge({ status }) {
  const key = STATUS_LABELS[status] ? status : "pending";
  return <span className={`status-badge status-${key}`}>{STATUS_LABELS[key]}</span>;
}
