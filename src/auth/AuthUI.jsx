import { useEffect, useId, useRef, useState } from "react";

export function AuthShell({ title, subtitle, wide = false, children }) {
  return (
    <main className="auth-page">
      <section className={wide ? "auth-card auth-card-wide" : "auth-card"}>
        <p className="brand">CADT</p>
        <p className="brand-sub">Campus Equipment Loans</p>
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
        {children}
      </section>
    </main>
  );
}

// Pass errorId (the id of the shown ErrorText) only while the form has an error.
const describe = (hintId, errorId) => ({
  "aria-describedby": [hintId, errorId].filter(Boolean).join(" ") || undefined,
  "aria-invalid": errorId ? true : undefined,
});

export function Field({ label, hint, error, errorId, ...inputProps }) {
  const id = useId();
  const hintId = hint && `${id}-hint`;
  const fieldErrorId = error && `${id}-error`;
  const describedBy = [fieldErrorId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...describe(hintId, describedBy)} {...inputProps} />
      {error && <p className="field-error" id={fieldErrorId}>{error}</p>}
      {hint && <p className="hint" id={hintId}>{hint}</p>}
    </div>
  );
}

export function SelectField({ label, hint, error, errorId, children, ...selectProps }) {
  const id = useId();
  const hintId = hint && `${id}-hint`;
  const fieldErrorId = error && `${id}-error`;
  const describedBy = [fieldErrorId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} {...describe(hintId, describedBy)} {...selectProps}>
        {children}
      </select>
      {error && <p className="field-error" id={fieldErrorId}>{error}</p>}
      {hint && <p className="hint" id={hintId}>{hint}</p>}
    </div>
  );
}

export function PasswordField({ label, hint, errorId, ...inputProps }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-wrap">
        <input id={id} type={shown ? "text" : "password"} {...describe(hint && `${id}-hint`, errorId)} {...inputProps} />
        <button
          type="button"
          className="toggle"
          aria-label="Show password"
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          Show
        </button>
      </div>
      {hint && <p className="hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

// Takes focus when it appears, so keyboard and screen reader users land on the problem.
export function ErrorText({ id, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (children) ref.current?.focus();
  }, [children]);
  return children ? <p className="error" id={id} ref={ref} tabIndex={-1} role="alert">{children}</p> : null;
}

// Announced politely after a save without moving focus away from the form.
export function SuccessText({ id, children }) {
  return children ? <p className="success" id={id} role="status">{children}</p> : null;
}
