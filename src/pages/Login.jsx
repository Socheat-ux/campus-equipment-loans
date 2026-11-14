import { useId, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { AuthShell, Field, PasswordField, ErrorText } from "../auth/AuthUI.jsx";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const from = useLocation().state?.from;
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
      // Only paths inside this app, never "//other.site".
      navigate(typeof from === "string" && from.startsWith("/") && !from.startsWith("//") ? from : "/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Log in to your account" subtitle="Use your CADT email to borrow and return equipment.">
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
        New here? <Link to="/signup">Create an account</Link>
      </p>
    </AuthShell>
  );
}
