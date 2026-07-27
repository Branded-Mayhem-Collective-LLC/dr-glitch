import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import authClient from "../auth/client";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../brand";
import ProcessAction from "../components/ProcessAction";

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
      <main className="auth-card" aria-labelledby="login-title">
        <header className="auth-header">
          <p className="auth-kicker">Four plates. One proof.</p>
          <h1 className="auth-wordmark glitch" data-text={PRODUCT_NAME}>
            {PRODUCT_NAME}
          </h1>
          <p className="auth-product-line">{PRODUCT_TAGLINE}</p>
        </header>
        <form onSubmit={onSubmit} className="auth-form" aria-busy={busy}>
          <div className="auth-form-heading">
            <h2 id="login-title">Sign in</h2>
            <p className="auth-subtitle">Return to the separation desk.</p>
          </div>
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
          <ProcessAction type="submit" disabled={busy} busy={busy} busyLabel="Signing in">
            Sign in
          </ProcessAction>
        </form>
        <p className="auth-switch">
          Need an account? <Link to="/signup">Create one</Link>
        </p>
      </main>
    </div>
  );
}
