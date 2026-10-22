import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon } from "@/ui/icons";
import { primaryArtist } from "@/shared/types";
import { FontControls, TranslateControls, TranslateNote } from "./Controls";
import { useWakeLock } from "./hooks";
import { LyricsBody } from "./LyricsBody";
import { isInstrumental } from "./lrc";
import { playerControl, useLyricsView } from "./lyricsStore";

/** Full-screen karaoke mode: big text, the current line lit, play controls within reach. */
export function Karaoke() {
  const track = useLyricsView((s) => s.track);
  const lyrics = useLyricsView((s) => s.lyrics);
  const phase = useLyricsView((s) => s.phase);
  const isPlaying = useLyricsView((s) => s.isPlaying);
  const scale = useLyricsView((s) => s.fontScale);
  const close = useLyricsView((s) => s.setKaraoke);
  const scrollRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useWakeLock(true);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [close]);

  return createPortal(
    <div className="lv-karaoke" role="dialog" aria-modal="true" aria-label="Karaoke lyrics" style={{ ["--lv-scale" as string]: scale }}>
      <header className="lv-k-top">
        <button ref={closeRef} type="button" className="lv-btn icon" onClick={() => close(false)} aria-label="Close karaoke">
          <CloseIcon size={20} />
        </button>
        <div className="lv-k-title">
          <strong>{track?.title ?? "Nothing playing"}</strong>
          {track && <span>{primaryArtist(track)}</span>}
        </div>
        <FontControls />
      </header>
      <div className="lv-k-tools">
        <TranslateControls />
      </div>
      <TranslateNote />
      <div className="lv-k-scroll" ref={scrollRef}>
        {phase === "ready" && lyrics && !isInstrumental(lyrics) ? (
          <LyricsBody variant="karaoke" container={scrollRef} />
        ) : (
          <p className="lv-k-empty" role="status">
            {phase === "loading"
              ? "Finding lyrics…"
              : phase === "ready"
                ? "This track is instrumental."
                : !track
                  ? "Play a song to sing along."
                  : phase === "no-providers"
                    ? "No lyrics source is turned on. Enable one in Settings, Plugins."
                    : "No lyrics found for this track."}
          </p>
        )}
      </div>
      <footer className="lv-k-controls">
        <button type="button" className="lv-btn icon" onClick={() => playerControl("previous")} aria-label="Previous track">
          <PrevIcon size={22} />
        </button>
        <button type="button" className="lv-btn icon big" onClick={() => playerControl("toggle")} aria-label={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
        </button>
        <button type="button" className="lv-btn icon" onClick={() => playerControl("next")} aria-label="Next track">
          <NextIcon size={22} />
        </button>
      </footer>
    </div>,
    document.body,
  );
}
