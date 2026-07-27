import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import authClient from "../auth/client";

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: signinError } = await authClient.signIn.email({ email, password });
      if (signinError) {
        setError(
          signinError.message ??
            `Sign-in failed (${signinError.status} ${signinError.statusText}).`,
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
          <h1>Sign in</h1>
          <p className="auth-subtitle">Welcome back.</p>
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" disabled={busy}>
            {busy ? "Signing in" : "Sign in"}
          </button>
        </form>
        <p className="auth-switch">
          Need an account? <Link to="/signup">Create one</Link>
        </p>
      </div>
    </div>
  );
}
