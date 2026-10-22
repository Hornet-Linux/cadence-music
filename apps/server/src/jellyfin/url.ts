/**
 * The Jellyfin address is set by the server owner only (JELLYFIN_URL or the
 * admin API), never by ordinary users: a URL a user could supply is a URL the
 * server would fetch on their behalf.
 *
 * Accepts http(s) addresses with an optional path (Jellyfin behind a reverse
 * proxy at /jellyfin). Credentials, query strings and fragments are never what
 * an owner means, so they are refused. Returns the address without a trailing slash.
 */
export function parseJellyfinUrl(raw: string): string {
  const text = raw.trim();
  if (!text || text.length > 2048 || /\s/.test(text)) throw new Error("Enter the address of your Jellyfin server");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("That isn't a valid address. Use a form like http://jellyfin:8096");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The address must start with http:// or https://");
  if (url.username || url.password) throw new Error("The address must not contain a user name or password");
  if (url.search || url.hash || text.includes("?") || text.includes("#")) {
    throw new Error("The address must not contain a query string or fragment");
  }
  if (!url.hostname) throw new Error("The address needs a host name");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}
