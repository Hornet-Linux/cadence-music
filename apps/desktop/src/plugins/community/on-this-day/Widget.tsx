import { useEffect, useState } from "react";
import type { HistoryResponse, Play } from "@uma/shared";
import { useHistory } from "@/features/history/historyStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { primaryArtist, type Track } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { serverApi } from "../_social/serverApi";
import { collectOnThisDay, describeEntry, groupByYear, type DayEntry } from "./onThisDay";
import "./style.css";

const CACHE_MS = 30 * 60_000;
let cache: { key: string; at: number; entries: DayEntry[] } | null = null;

async function load(signedIn: boolean, now: Date): Promise<DayEntry[]> {
  const key = `${signedIn ? "server" : "device"}:${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.entries;
  let entries: DayEntry[];
  if (signedIn) {
    entries = await collectOnThisDay(async (before) => (await serverApi<HistoryResponse>(`api/me/history?limit=500&before=${before}`)).items as Play[], now);
  } else {
    entries = groupByYear(useHistory.getState().plays, now);
  }
  cache = { key, at: Date.now(), entries };
  return entries;
}

export function OnThisDayWidget({ play }: { play: (tracks: Track[], index: number) => void }) {
  const signedIn = useServer((s) => !!s.user);
  const [entries, setEntries] = useState<DayEntry[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    load(signedIn, new Date())
      .then((e) => !cancelled && setEntries(e))
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setEntries(groupByYear(useHistory.getState().plays, new Date()));
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  if (entries === null) return <p className="muted small">Looking through your past listening...</p>;
  if (entries.length === 0) {
    return (
      <p className="muted small">
        Nothing from earlier years yet. Come back after you have been listening for a while{error ? " (couldn't reach the server, so only this device was checked)" : ""}.
      </p>
    );
  }
  return (
    <div className="otd">
      {entries.slice(0, 3).map((entry) => {
        const tracks = entry.tracks.map((t) => t.track);
        return (
          <section key={entry.year} className="otd-year">
            <div className="sx-row otd-head">
              <h3 className="sx-grow">{describeEntry(entry)}</h3>
              <button className="btn ghost" onClick={() => play(tracks, 0)} aria-label={`Play everything from ${entry.year}`}>
                Play all
              </button>
            </div>
            <ul className="sx-list">
              {entry.tracks.slice(0, 5).map(({ track, plays }, i) => (
                <li key={track.id}>
                  <button className="otd-row" onClick={() => play(tracks, i)} aria-label={`Play ${track.title}`}>
                    <span className="sx-thumb">
                      <CoverArt src={track.artwork} seed={track.album ?? track.title} label={track.title} showInitial={false} />
                    </span>
                    <span className="sx-grow" style={{ textAlign: "left" }}>
                      <span className="sx-title" style={{ display: "block" }}>
                        {track.title}
                      </span>
                      <span className="sx-sub" style={{ display: "block" }}>
                        {primaryArtist(track)}
                        {plays > 1 ? ` · ${plays} plays` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}