import { useEffect, useRef, useState } from "react";
import { CoverArt } from "@/ui/CoverArt";
import { CloseIcon } from "@/ui/icons";
import { useServer } from "../../builtins/server/serverStore";
import { artistsKey, useTopArtists } from "../_metadata/artists";
import type { MetadataClient } from "../_metadata/client";
import type { ReleaseGroupInfo } from "../_metadata/types";
import type { PluginStorage } from "../../types";
import { findNewReleases, isFresh, WINDOW_DAYS, withoutDismissed, type ReleasesResult, type StoredReleases } from "./releases";
import "./style.css";

const TOP_ARTISTS = 12;
const DISMISSED_KEY = "dismissed";
const CACHE_KEY = "results";

function dayLabel(date: string): string {
  const d = new Date(date + "T12:00:00");
  return Number.isNaN(d.getTime()) ? date : d.toLocaleString("en", { month: "short", day: "numeric" });
}

function ReleaseRow({ item, onDismiss }: { item: ReleaseGroupInfo; onDismiss: () => void }) {
  return (
    <li className="release-row">
      <a
        className="release-art"
        href={"https://musicbrainz.org/release-group/" + item.mbid}
        target="_blank"
        rel="noreferrer"
        aria-label={"Details for " + item.title}
      >
        <CoverArt src={item.coverUrl} seed={item.title} label={item.title} showInitial={false} />
      </a>
      <div className="release-body">
        <div className="strong release-title">{item.title}</div>
        <div className="muted small release-sub">
          {item.artist} · {item.type} · {dayLabel(item.date)}
        </div>
      </div>
      <button className="icon-btn release-dismiss" onClick={onDismiss} aria-label={"Dismiss " + item.title} title="Dismiss">
        <CloseIcon size={16} />
      </button>
    </li>
  );
}

/** New albums, EPs and singles from the artists you listen to, from the last 90 days. */
export function NewReleases({ client, storage }: { client: MetadataClient; storage: PluginStorage }) {
  const signedIn = useServer((s) => s.user !== null);
  const artists = useTopArtists(TOP_ARTISTS);
  const key = artistsKey(artists);
  const [dismissed, setDismissed] = useState<string[]>(() => storage.get<string[]>(DISMISSED_KEY) ?? []);
  const [result, setResult] = useState<{ key: string; value: ReleasesResult } | null>(null);
  const artistsRef = useRef(artists);
  artistsRef.current = artists;

  useEffect(() => {
    if (!signedIn || artistsRef.current.length === 0) return;
    const stored = storage.get<StoredReleases>(CACHE_KEY);
    if (isFresh(stored, key, Date.now())) {
      setResult({ key, value: { items: stored.items, checked: artistsRef.current.length, failed: 0 } });
      return;
    }
    const controller = new AbortController();
    void findNewReleases(client, artistsRef.current, {
      signal: controller.signal,
      onProgress: (value) => {
        if (!controller.signal.aborted) setResult({ key, value });
      },
    })
      .then((final) => {
        // Only remember a complete lookup; a partial one would hide releases for hours.
        if (!controller.signal.aborted && final.failed === 0) {
          try {
            storage.set(CACHE_KEY, { key, at: Date.now(), items: final.items } satisfies StoredReleases);
          } catch {
            // Storage full: the lookup simply repeats next time.
          }
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, storage, key, signedIn]);

  if (!signedIn) return <p className="muted small">Sign in to your Cadence server to see new music from your artists.</p>;
  if (artists.length === 0) return <p className="muted small">Play some music and new releases from your favourite artists will appear here.</p>;

  const current = result && result.key === key ? result.value : null;
  const loading = !current || current.checked < artists.length;
  const shown = current ? withoutDismissed(current.items, dismissed) : [];
  const hiddenCount = current ? current.items.filter((i) => dismissed.includes(i.mbid)).length : 0;

  const updateDismissed = (next: string[]) => {
    setDismissed(next);
    storage.set(DISMISSED_KEY, next.slice(-200));
  };

  return (
    <div className="stack releases">
      {shown.length > 0 && (
        <ul className="release-list">
          {shown.map((item) => (
            <ReleaseRow key={item.mbid} item={item} onDismiss={() => updateDismissed([...dismissed, item.mbid])} />
          ))}
        </ul>
      )}
      {loading && (
        <p className="muted small">
          Checking {artists.length} artists… {current ? current.checked + " done" : ""}
        </p>
      )}
      {!loading && shown.length === 0 && (
        <p className="muted small">
          {hiddenCount > 0
            ? "You have dismissed everything new."
            : "Nothing new in the last " + WINDOW_DAYS + " days from your top " + artists.length + " artists."}
        </p>
      )}
      {!loading && current && current.failed > 0 && (
        <p className="muted small">{current.failed} artists could not be checked right now. They will be tried again later.</p>
      )}
      {hiddenCount > 0 && (
        <div>
          <button className="btn ghost release-reset" onClick={() => updateDismissed([])}>
            Show {hiddenCount} dismissed
          </button>
        </div>
      )}
    </div>
  );
}
