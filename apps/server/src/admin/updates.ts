import type { FetchFn } from "../auth/oidc.js";

export const RELEASES_REPO = "Hornet-Linux/cadence-music";

export interface UpdateStatus {
  current: string;
  latest: string | null;
  url: string | null;
  publishedAt: string | null;
  /** null when the versions can't be compared (a tag that isn't a version number). */
  upToDate: boolean | null;
  checkedAt: number;
  error: string | null;
}

function parts(version: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 if a is older than b, 1 if newer, 0 if equal, null if either isn't a version number. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i]! < y[i]!) return -1;
    if (x[i]! > y[i]!) return 1;
  }
  return 0;
}

/** Looks up the latest GitHub release when asked (never in the background) and remembers the answer. */
export class UpdateChecker {
  private last: UpdateStatus | null = null;

  constructor(
    private readonly current: string,
    private readonly fetchFn: FetchFn = fetch as FetchFn,
    private readonly now: () => number = Date.now,
  ) {}

  cached(): UpdateStatus | null {
    return this.last;
  }

  async check(): Promise<UpdateStatus> {
    const base = { current: this.current, checkedAt: this.now() };
    try {
      const res = await this.fetchFn(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": `cadence-server/${this.current}` },
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 404) {
        return (this.last = { ...base, latest: null, url: null, publishedAt: null, upToDate: null, error: "No release has been published yet." });
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { tag_name?: string; html_url?: string; published_at?: string };
      const tag = typeof body.tag_name === "string" ? body.tag_name : null;
      const cmp = tag ? compareVersions(this.current, tag) : null;
      const url = typeof body.html_url === "string" && body.html_url.startsWith(`https://github.com/${RELEASES_REPO}/`) ? body.html_url : null;
      return (this.last = {
        ...base,
        latest: tag,
        url,
        publishedAt: typeof body.published_at === "string" ? body.published_at : null,
        upToDate: cmp === null ? null : cmp >= 0,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return (this.last = { ...base, latest: null, url: null, publishedAt: null, upToDate: null, error: `Couldn't reach GitHub (${message}).` });
    }
  }
}
