import type { AuthResponse } from "@uma/shared";
import { createPkce, loopbackAuthorize, randomState } from "./loopback";

// Sign in to the self-hosted server through its OIDC provider (e.g.
// Authentik). The server talks to the provider; the app only receives a
// one-time code bound to its own PKCE challenge.

function apiUrl(base: string, route: string): URL {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(route.replace(/^\/+/, ""), root);
}

let inProgress = false;

export async function oidcLogin(serverUrl: string): Promise<AuthResponse> {
  const base = new URL(serverUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("Server URL must start with http:// or https://");
  }
  if (inProgress) throw new Error("A sign-in is already in progress");
  inProgress = true;
  try {
    const state = randomState();
    const pkce = createPkce();
    const code = await loopbackAuthorize({
      port: 0,
      state,
      authorizeUrl: (redirectUri) => {
        const start = apiUrl(base.toString(), "api/auth/oidc/start");
        start.searchParams.set("redirect_uri", redirectUri);
        start.searchParams.set("state", state);
        start.searchParams.set("code_challenge", pkce.challenge);
        return start.toString();
      },
    });
    const res = await fetch(apiUrl(base.toString(), "api/auth/exchange"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: pkce.verifier }),
    });
    if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
    return (await res.json()) as AuthResponse;
  } finally {
    inProgress = false;
  }
}
