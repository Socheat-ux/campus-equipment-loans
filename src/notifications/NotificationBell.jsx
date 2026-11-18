import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { BellIcon } from "../components/Icons.jsx";
import { listNotifications, markAllNotificationsRead, markNotificationRead, markNotificationsRead } from "./api.js";

const POLL_MS = 30_000;
const REQUEST_TYPES = new Set(["request_submitted", "request_approved", "request_rejected", "due_soon", "request_returned", "request_cancelled"]);
const LABELS = {
  request_submitted: "Submitted",
  request_approved: "Approved",
  request_rejected: "Rejected",
  due_soon: "Due soon",
  request_returned: "Returned",
  request_cancelled: "Cancelled",
};
const TITLES = {
  request_submitted: "Request submitted",
  request_approved: "Request approved",
  request_rejected: "Request rejected",
  due_soon: "Return due tomorrow",
  request_returned: "Equipment returned",
  request_cancelled: "Request cancelled",
};
const UNITS = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  for (const [unit, size] of UNITS) {
    const count = Math.floor(seconds / size);
    if (count >= 1) return relative.format(-(unit === "month" ? Math.min(count, 11) : count), unit);
  }
  return "just now";
}

export default function NotificationBell({ onNavigate }) {
  const { user } = useAuth();
  return user ? <Bell key={user.id} onNavigate={onNavigate} /> : null;
}

function Bell({ onNavigate }) {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [status, setStatus] = useState("loading");
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  const [top, setTop] = useState(0);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const highestId = useRef(null);
  const flip = useRef(false);
  const requestSeq = useRef(0);
  const panelId = useId();

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const data = await listNotifications();
      if (seq !== requestSeq.current) return;
      setItems(data.notifications);
      setUnread(data.unread);
      setStatus("ready");
      const newest = data.notifications[0]?.id ?? 0;
      if (highestId.current !== null && newest > highestId.current) {
        flip.current = !flip.current;
        const added = data.notifications.filter((item) => item.id > highestId.current).length;
        const what = added > 1 ? `${added} new notifications.` : "New notification.";
        setAnnouncement(`${what} ${data.unread} unread.${flip.current ? "\u00a0" : ""}`);
      }
      highestId.current = Math.max(highestId.current ?? 0, newest);
    } catch {
      if (seq !== requestSeq.current) return;
      setStatus((current) => (current === "ready" ? current : "error"));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  function closePanel(returnFocus = true) {
    setOpen(false);
    setFresh(new Set());
    if (returnFocus) buttonRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onPointer = (event) => {
      if (rootRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return;
      closePanel();
    };
    const onKey = (event) => {
      if (event.key === "Escape") closePanel();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  function toggle() {
    if (open) return closePanel();
    setTop(buttonRef.current.getBoundingClientRect().bottom + 8);
    const ids = items.filter((item) => !item.read).map((item) => item.id);
    setFresh(new Set(ids));
    setOpen(true);
    setAnnouncement("");
    if (!items.length) return;
    const target = unread > ids.length ? "all" : ids;
    if (target !== "all" && ids.length === 0) return;
    requestSeq.current++;
    markNotificationsRead(target, highestId.current)
      .then((data) => {
        setUnread(data.unread);
        setItems((previous) => previous.map((item) => (ids.includes(item.id) ? { ...item, read: true } : item)));
        if (data.unread > (target === "all" ? 0 : unread - ids.length)) load();
      })
      .catch(() => {});
  }

  async function markOne(item) {
    requestSeq.current++;
    try {
      const data = await markNotificationRead(item.id);
      setUnread(data.unread);
      setItems((previous) => previous.map((entry) => (entry.id === item.id ? { ...entry, read: true } : entry)));
      setFresh((previous) => {
        if (!previous.has(item.id)) return previous;
        const next = new Set(previous);
        next.delete(item.id);
        return next;
      });
      if (data.unread > 0) load();
    } catch {}
  }

  async function markAll() {
    requestSeq.current++;
    try {
      const data = await markAllNotificationsRead();
      setUnread(data.unread);
      setItems((previous) => previous.map((item) => ({ ...item, read: true })));
      setFresh(new Set());
      if (data.unread > 0) load();
    } catch {}
  }

  async function openItem(item) {
    if (!item.read || fresh.has(item.id)) await markOne(item);
    closePanel();
    if (REQUEST_TYPES.has(item.type)) onNavigate?.();
  }

  function retry() {
    setStatus("loading");
    load();
  }

  let body;
  if (status === "loading") {
    body = <p className="notif-note">Loading notifications</p>;
  } else if (status === "error" && items.length === 0) {
    body = (
      <div className="notif-note">
        <p>Could not load notifications.</p>
        <button type="button" className="notif-retry" onClick={retry}>
          Try again
        </button>
      </div>
    );
  } else if (items.length === 0) {
    body = <p className="notif-note">No notifications yet.</p>;
  } else {
    body = (
      <ul className="notif-list">
        {items.map((item) => (
          <li key={item.id} className={fresh.has(item.id) ? "notif-item is-new" : "notif-item"}>
            <button type="button" className="notif-item-button" onClick={() => openItem(item)}>
              <span className="notif-item-title">{TITLES[item.type] ?? "Update"}</span>
              <span className="notif-meta">
                <span className={`notif-chip notif-chip-${item.type}`}>{LABELS[item.type] ?? "Update"}</span>
                <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
                  {timeAgo(item.createdAt)}
                </time>
                {fresh.has(item.id) && <span className="sr-only">New.</span>}
              </span>
              <span className="notif-message">{item.message}</span>
              {item.reason && (
                <span className="notif-reason">
                  <span>Reason:</span> {item.reason}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="notif" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="notif-bell"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Notifications, ${unread} unread`}
        onClick={toggle}
      >
        <BellIcon size={20} />
        {unread > 0 && (
          <span className="notif-count" aria-hidden="true">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {open && (
        <section
          id={panelId}
          ref={panelRef}
          className="notif-panel"
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          style={{ "--notif-top": `${top}px` }}
        >
          <div className="notif-panel-head">
            <h2 className="notif-title">Notifications</h2>
            <button type="button" className="notif-close" aria-label="Close notifications" onClick={() => closePanel()}>
              ×
            </button>
          </div>
          <div className="notif-mark-row">
            <button type="button" className="notif-mark-all" onClick={markAll}>
              Mark all as read
            </button>
          </div>
          <div className="notif-scroll">{body}</div>
        </section>
      )}
    </div>
  );
}
