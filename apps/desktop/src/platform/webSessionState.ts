/**
 * Whether the web player has a Cadence session. The session cookie is
 * HttpOnly, so the page can't look at it; the server store keeps this up to
 * date, and the web host skips account calls (Spotify) while signed out.
 */
export const webSessionState = { signedIn: false };
