import { useId, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { AuthShell, Field, PasswordField, ErrorText } from "../auth/AuthUI.jsx";
import { roleFor, displayName, passwordError, EMAIL_HELP } from "../../server/rules.js";

export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const shown = error ? errorId : undefined;

  const normalized = email.trim().toLowerCase();
  const role = roleFor(normalized);

  async function submit(e) {
    e.preventDefault();
    flushSync(() => setError("")); // remount the message so it takes focus even when the text is unchanged
    const problem = (!role && "That is not a CADT email. Check the format under the email field.") || passwordError(password) || (password !== confirm && "Passwords do not match.");
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await signup({ email: normalized, password });
      navigate("/", { replace: true });
    } catch (err) {
      setError(
        err.status === 409 ? (
          <>
            An account with this email already exists. <Link to="/login">Log in instead</Link>.
          </>
        ) : (
          err.message
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="Your name comes from your CADT email, so you do not need to type it.">
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
          hint={role ? `You will be signed up as ${displayName(normalized)} (${role}).` : EMAIL_HELP}
        />
        <PasswordField
          label="Password"
          name="password"
          errorId={shown}
          hint="At least 8 characters, with a letter and a number."
          autoComplete="new-password"
          placeholder="Enter a password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <PasswordField
          label="Confirm password"
          name="confirm"
          errorId={shown}
          autoComplete="new-password"
          placeholder="Enter the password again"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <ErrorText id={errorId}>{error}</ErrorText>
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Creating account" : "Create account"}
        </button>
      </form>
      <p className="switch">
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </AuthShell>
  );
}
