const API = "https://api.spotify.com/v1/";

export async function spotifyAccessToken(): Promise<string | null> {
  const token = await window.host?.spotify.token().catch(() => null);
  return token?.accessToken ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Call the Spotify Web API with the current access token. */
export async function spotifyFetch<T>(route: string, init: RequestInit = {}): Promise<T> {
  const url = route.startsWith("https://") ? route : API + route.replace(/^\/+/, "");
  for (let attempt = 0; ; attempt++) {
    const token = await spotifyAccessToken();
    if (!token) throw new Error("Not signed in to Spotify");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const res = await fetch(url, { ...init, headers });

    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get("retry-after") ?? "1");
      await sleep(Math.min(Number.isFinite(wait) ? wait : 1, 10) * 1000);
      continue;
    }
    if (!res.ok) {
      let message = "";
      try {
        message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? "";
      } catch {
        // Not JSON.
      }
      throw new Error(`Spotify request failed (${res.status})${message ? `: ${message}` : ""}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
