// "A newer version is available" for the desktop app. The desktop app has no
// auto-updater (it is an unsigned installer), so this only tells people a newer
// release exists and links to the release page; they download and install it
// themselves. It looks at GitHub's latest *stable* release (never the rolling
// Nightly pre-release) at most once a day, and each version can be dismissed.

export const LATEST_RELEASE_API = "https://api.github.com/repos/Hornet-Linux/cadence-music/releases/latest";
export const RELEASES_PAGE = "https://github.com/Hornet-Linux/cadence-music/releases/latest";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const LAST_CHECK_KEY = "update:lastCheck";
const LATEST_KEY = "update:latest";
const DISMISSED_KEY = "update:dismissed";

export interface ReleaseInfo {
  tag: string;
  url: string;
}

/** Numeric parts of "v1.2.3" or "1.2.3-beta.1" (the suffix is ignored); null for anything else, such as "nightly". */
export function parseVersion(version: string): number[] | null {
  const core = version.trim().replace(/^[vV]/, "").split(/[-+]/)[0] ?? "";
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return core.split(".").map(Number);
}

/** True only when both are versions and `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** At most one network check per day; a clock that went backwards also counts as due. */
export function shouldCheck(now: number, lastCheck: number): boolean {
  return !(lastCheck > 0) || now < lastCheck || now - lastCheck >= CHECK_INTERVAL_MS;
}

/** Reads GitHub's "latest release" answer. Null for drafts, pre-releases and anything malformed. */
export function parseRelease(body: unknown): ReleaseInfo | null {
  if (!body || typeof body !== "object") return null;
  const r = body as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== "string" || !r.tag_name.trim()) return null;
  const url = typeof r.html_url === "string" && r.html_url.startsWith("https://github.com/") ? r.html_url : RELEASES_PAGE;
  return { tag: r.tag_name.trim(), url };
}

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function read(store: Store, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function write(store: Store, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Without storage the check simply runs on every launch.
  }
}

function remembered(store: Store): ReleaseInfo | null {
  try {
    return parseRelease(JSON.parse(read(store, LATEST_KEY) ?? "null"));
  } catch {
    return null;
  }
}

/** The release to offer, or null: nothing newer, already dismissed, or the check failed (silently). */
export async function pendingUpdate(opts: {
  current: string;
  store: Store;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<ReleaseInfo | null> {
  const { current, store } = opts;
  const now = (opts.now ?? Date.now)();
  let latest = remembered(store);
  if (shouldCheck(now, Number(read(store, LAST_CHECK_KEY)) || 0)) {
    // Record the attempt first so a failing network is not retried on every launch.
    write(store, LAST_CHECK_KEY, String(now));
    try {
      const res = await (opts.fetchFn ?? fetch)(LATEST_RELEASE_API, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        latest = parseRelease(await res.json());
        write(store, LATEST_KEY, JSON.stringify(latest ? { tag_name: latest.tag, html_url: latest.url } : null));
      }
    } catch {
      // Offline or rate limited: keep whatever we knew.
    }
  }
  if (!latest || !isNewer(latest.tag, current)) return null;
  return read(store, DISMISSED_KEY) === latest.tag ? null : latest;
}

export function dismissUpdate(store: Store, tag: string): void {
  write(store, DISMISSED_KEY, tag);
}
