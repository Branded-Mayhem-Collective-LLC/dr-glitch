import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import authClient from "../auth/client";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../brand";
import ProcessAction from "../components/ProcessAction";

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
      <main className="auth-card" aria-labelledby="signup-title">
        <header className="auth-header">
          <p className="auth-kicker">Four plates. One proof.</p>
          <h1 className="auth-wordmark glitch" data-text={PRODUCT_NAME}>
            {PRODUCT_NAME}
          </h1>
          <p className="auth-product-line">{PRODUCT_TAGLINE}</p>
        </header>
        <form onSubmit={onSubmit} className="auth-form" aria-busy={busy}>
          <div className="auth-form-heading">
            <h2 id="signup-title">Create an account</h2>
            <p className="auth-subtitle">Save projects and pick up where you left off.</p>
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
          <div>
            <label>
              Password
              <input
                type="password"
                required
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                aria-describedby="password-requirement"
              />
            </label>
            <p className="auth-field-hint" id="password-requirement">
              12 characters minimum
            </p>
          </div>
          {error ? <p role="alert">{error}</p> : null}
          <ProcessAction
            type="submit"
            disabled={busy}
            busy={busy}
            busyLabel="Creating account"
          >
            Create account
          </ProcessAction>
        </form>
        <p className="auth-switch">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </main>
    </div>
  );
}
