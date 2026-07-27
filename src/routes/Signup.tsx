import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import authClient from "../auth/client";

export default function Signup() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const signupSource = document.cookie
      .split("; ")
      .find((part) => part.startsWith("hw_src="))
      ?.slice("hw_src=".length);

    try {
      const { error: signupError } = await authClient.signUp.email({
        email,
        password,
        name: email.split("@")[0],
        ...(signupSource ? { signupSource: decodeURIComponent(signupSource) } : {}),
      });
      if (signupError) {
        setError(
          signupError.message ??
            `Could not create that account (${signupError.status} ${signupError.statusText}).`,
        );
        return;
      }
      navigate("/");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>DRC Halftone</strong>
            <span>CMYK Studio</span>
          </div>
        </div>
        <form onSubmit={onSubmit} className="auth-form">
          <h1>Create an account</h1>
          <p className="auth-subtitle">Save projects and pick up where you left off.</p>
          <label>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" disabled={busy}>
            {busy ? "Creating account" : "Create account"}
          </button>
        </form>
        <p className="auth-switch">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
