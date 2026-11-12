import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { BellIcon } from "../components/Icons.jsx";
import { listNotifications, markNotificationsRead } from "./api.js";

const POLL_MS = 30_000;
const LABELS = { request_approved: "Approved", request_rejected: "Rejected" };
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
  // Clamp to the past: a browser clock behind the server must not show "in 3 minutes".
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  for (const [unit, size] of UNITS) {
    const count = Math.floor(seconds / size); // floor, so 59.5 minutes is not "60 minutes ago"
    // Months stop at 11: a month is 30 days, so days 360 to 364 would otherwise read "12 months ago".
    if (count >= 1) return relative.format(-(unit === "month" ? Math.min(count, 11) : count), unit);
  }
  return "just now";
}

// Shows nothing for guests and design previews, so only a real session ever polls.
export default function NotificationBell() {
  const { user } = useAuth();
  return user ? <Bell key={user.id} /> : null;
}

function Bell() {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [status, setStatus] = useState("loading"); // loading, ready or error
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState(() => new Set()); // unread when the panel opened, highlighted until it closes
  const [announcement, setAnnouncement] = useState("");
  const [top, setTop] = useState(0);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const highestId = useRef(null); // newest notification id seen so far, null before the first load
  const flip = useRef(false);
  const requestSeq = useRef(0); // only the newest poll may update state
  const panelId = useId();

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const data = await listNotifications();
      if (seq !== requestSeq.current) return; // a newer poll or a mark-read has overtaken this one
      setItems(data.notifications);
      setUnread(data.unread);
      setStatus("ready");
      // The list is newest first. An id above the highest seen is new, whatever the unread count did.
      const newest = data.notifications[0]?.id ?? 0;
      if (highestId.current !== null && newest > highestId.current) {
        // A trailing no-break space alternates, so identical text still changes the DOM and is read out again.
        flip.current = !flip.current;
        const added = data.notifications.filter((item) => item.id > highestId.current).length;
        const what = added > 1 ? `${added} new notifications.` : "New notification.";
        setAnnouncement(`${what} ${data.unread} unread.${flip.current ? " " : ""}`);
      }
      highestId.current = Math.max(highestId.current ?? 0, newest);
    } catch {
      if (seq !== requestSeq.current) return;
      // After a good load, keep showing the last list through a short network blip.
      setStatus((current) => (current === "ready" ? current : "error"));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    // pointerdown, not mousedown: iOS Safari does not fire mouse events for a tap on a non-clickable area.
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (open) return setOpen(false);
    setTop(buttonRef.current.getBoundingClientRect().bottom + 8);
    const ids = items.filter((item) => !item.read).map((item) => item.id);
    setFresh(new Set(ids));
    setOpen(true);
    setAnnouncement(""); // so the next new notification is announced even if the text repeats
    if (!ids.length) return;
    // Past the list limit some unread notices are off screen, so mark all up to the newest id seen; otherwise only
    // those shown. Anything newer, such as a notice that arrived since the last poll, stays unread.
    requestSeq.current++; // a poll already in flight would restore the old unread state
    markNotificationsRead(unread > items.length ? "all" : ids, highestId.current)
      .then((data) => {
        setUnread(data.unread);
        setItems((previous) => previous.map((item) => (ids.includes(item.id) ? { ...item, read: true } : item)));
        // More unread than the list explains means a notice arrived after the last poll; list it so the badge matches the panel.
        if (data.unread > (unread > items.length ? 0 : unread - ids.length)) load();
      })
      .catch(() => {}); // they stay unread and the next poll shows the true count
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
    body = <p className="notif-note">No notifications yet. Updates on your borrow requests will appear here.</p>;
  } else {
    body = (
      <ul className="notif-list">
        {items.map((item) => (
          <li key={item.id} className={fresh.has(item.id) ? "notif-item is-new" : "notif-item"}>
            <div className="notif-meta">
              <span className={`notif-chip notif-chip-${item.type}`}>{LABELS[item.type] ?? "Update"}</span>
              <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
                {timeAgo(item.createdAt)}
              </time>
              {fresh.has(item.id) && <span className="sr-only">New.</span>}
            </div>
            <p className="notif-message">{item.message}</p>
            {item.reason && (
              <p className="notif-reason">
                <span>Reason:</span> {item.reason}
              </p>
            )}
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
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
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
        <section id={panelId} className="notif-panel" aria-label="Notifications" style={{ "--notif-top": `${top}px` }}>
          <h2 className="notif-title">Notifications</h2>
          {body}
        </section>
      )}
    </div>
  );
}
