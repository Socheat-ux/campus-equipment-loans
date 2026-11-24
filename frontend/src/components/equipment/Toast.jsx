import { useEffect } from "react";
import { AlertIcon, CheckCircleIcon, CloseIcon } from "../Icons.jsx";

export default function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onClose, 4200);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  const Icon = toast.type === "error" ? AlertIcon : CheckCircleIcon;

  return (
    <div className={`dash-toast${toast.type === "error" ? " is-error" : ""}`} role="status">
      <Icon size={19} />
      <span>{toast.message}</span>
      <button type="button" aria-label="Dismiss notification" onClick={onClose}>
        <CloseIcon size={15} />
      </button>
    </div>
  );
}
