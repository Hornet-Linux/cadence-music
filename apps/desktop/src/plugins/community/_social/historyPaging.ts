import type { HistoryResponse, Play } from "@uma/shared";
import { serverApi } from "./serverApi";

export const HISTORY_PAGE = 500;

export interface PagedHistory {
  plays: Play[];
  /** True when there was more history than we were willing to load. */
  truncated: boolean;
}

/**
 * Read the history API page by page, newest first, until it runs out, `stopBefore` is passed or
 * `maxPlays` is reached. `getPage(before)` returns plays strictly older than `before`.
 */
export async function pageHistory(
  getPage: (before: number | undefined) => Promise<Play[]>,
  options: { maxPlays?: number; stopBefore?: number } = {},
): Promise<PagedHistory> {
  const maxPlays = options.maxPlays ?? 40_000;
  const plays: Play[] = [];
  const seen = new Set<string>();
  let before: number | undefined;
  for (;;) {
    const page = await getPage(before);
    if (page.length === 0) return { plays, truncated: false };
    for (const p of page) {
      const key = `${p.track.id}@${p.playedAt}`;
      if (!seen.has(key)) {
        seen.add(key);
        plays.push(p);
      }
    }
    const oldest = page[page.length - 1].playedAt;
    if (page.length < HISTORY_PAGE) return { plays, truncated: false };
    if (options.stopBefore !== undefined && oldest < options.stopBefore) return { plays, truncated: false };
    if (plays.length >= maxPlays) return { plays, truncated: true };
    if (before !== undefined && oldest >= before) return { plays, truncated: true }; // no progress
    before = oldest;
  }
}

/** The signed-in person's history from the server. */
export function fetchServerHistory(options?: { maxPlays?: number; stopBefore?: number }): Promise<PagedHistory> {
  return pageHistory(async (before) => {
    const qs = new URLSearchParams({ limit: String(HISTORY_PAGE) });
    if (before !== undefined) qs.set("before", String(before));
    return (await serverApi<HistoryResponse>(`api/me/history?${qs}`)).items;
  }, options);
}