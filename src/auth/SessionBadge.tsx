import { useState } from "react";
import { Link } from "react-router";
import authClient from "./client";

/**
 * Small fixed-position overlay showing who is signed in. Intentionally
 * rendered inside the studio root so its focus treatment inherits the active
 * plate ink. It remains fully registered — no glitch effect is permitted this
 * close to the proof. Signed-out visitors see a "Sign in" link; the studio is
 * fully usable either way.
 */
export default function SessionBadge() {
  const { data, isPending } = authClient.useSession();
  const [signingOut, setSigningOut] = useState(false);

  if (isPending) return null;

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setSigningOut(false);
    }
  }

  if (!data?.user) {
    return (
      <div className="session-badge" data-testid="session-badge">
        <span className="session-badge-label">Guest proof</span>
        <Link
          className="session-badge-action"
          data-testid="session-badge-action"
          to="/login"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="session-badge" data-testid="session-badge">
      <span className="session-badge-email" title={data.user.email}>
        {data.user.email}
      </span>
      <button
        className="session-badge-action"
        data-testid="session-badge-action"
        onClick={handleSignOut}
        disabled={signingOut}
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
