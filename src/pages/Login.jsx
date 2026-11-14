import { useId, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { AuthShell, Field, PasswordField, ErrorText } from "../auth/AuthUI.jsx";
import { safeReturnPath } from "../auth/access.js";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { state } = useLocation();
  const from = state?.from;
  // Set by the not-allowed page after "Log out and use another account".
  const notice = typeof state?.notice === "string" ? state.notice : "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const shown = error ? errorId : undefined;

  async function submit(e) {
    e.preventDefault();
    flushSync(() => setError("")); // remount the message so it takes focus even when the text is unchanged
    if (!email.trim() || !password) return setError("Enter your CADT email and password.");
    setBusy(true);
    try {
      await login({ email: email.trim(), password });
      navigate(safeReturnPath(from), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Log in to your account" subtitle="Use your CADT email to borrow and return equipment.">
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <form onSubmit={submit} noValidate>
        <Field
          label="CADT email"
          type="email"
          name="email"
          errorId={shown}
          autoComplete="username"
          placeholder="Enter your CADT email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordField
          label="Password"
          name="password"
          errorId={shown}
          autoComplete="current-password"
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorText id={errorId}>{error}</ErrorText>
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Signing in" : "Sign in"}
        </button>
      </form>
      <p className="switch">
        New here? <Link to="/signup" state={{ from }}>Create an account</Link>
      </p>
    </AuthShell>
  );
}
