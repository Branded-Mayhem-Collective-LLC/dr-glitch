import { cloudflareClient } from "better-auth-cloudflare/client";
import { createAuthClient } from "better-auth/react";

// The installed better-auth version requires an absolute baseURL when one
// is explicitly provided (a bare "/api/auth" throws "Invalid base URL" at
// runtime). Omitting it lets better-auth resolve
// `${window.location.origin}/api/auth` itself, which matches where
// worker/index.ts mounts the auth handler.
const authClient = createAuthClient({
  plugins: [cloudflareClient()],
});

export default authClient;
