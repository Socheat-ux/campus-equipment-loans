import { useId, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { AuthShell, Field, PasswordField, ErrorText } from "../auth/AuthUI.jsx";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
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
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Log in to your account" subtitle="Use the email address you registered with.">
      <form onSubmit={submit} noValidate>
        <Field
          label="Email address"
          type="email"
          name="email"
          errorId={shown}
          autoComplete="username"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordField
          label="Password"
          name="password"
          errorId={shown}
          autoComplete="current-password"
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
