import { useRef, type RefObject } from "react";
import { useActiveLine, useAutoScroll } from "./hooks";
import { isInstrumental } from "./lrc";
import { canControlPlayer, seekTo, useLyricsView } from "./lyricsStore";

/** The lines of the current lyrics, with the active line highlighted and followed. */
export function LyricsBody({ variant, container }: { variant: "page" | "karaoke"; container?: RefObject<HTMLElement | null> }) {
  const lyrics = useLyricsView((s) => s.lyrics);
  const translated = useLyricsView((s) => s.translatedLines);
  const translateOn = useLyricsView((s) => s.translateOn);
  const scale = useLyricsView((s) => s.fontScale);
  const listRef = useRef<HTMLOListElement>(null);
  const active = useActiveLine(lyrics);
  useAutoScroll(listRef, active, { anchor: variant === "karaoke" ? 0.42 : 0.38, container });

  if (!lyrics) return null;
  if (isInstrumental(lyrics)) {
    return (
      <p className="lv-note" role="status">
        This track is instrumental. There are no lyrics.
      </p>
    );
  }

  const tappable = lyrics.synced && canControlPlayer();
  return (
    <ol ref={listRef} className={`lv-lines lv-${variant}`} aria-label="Lyrics" style={{ ["--lv-scale" as string]: scale }}>
      {lyrics.lines.map((line, i) => {
        const state = !lyrics.synced ? "plain" : i === active ? "active" : i < active ? "past" : "next";
        const gap = line.text === "";
        const extra = translateOn && translated?.[i] ? translated[i] : "";
        const content = gap ? (
          <span className="lv-gap" aria-hidden>
            {state === "active" ? "♪" : ""}
          </span>
        ) : (
          <>
            <span className="lv-text">{line.text}</span>
            {extra && <span className="lv-translation">{extra}</span>}
          </>
        );
        return (
          <li key={i} data-i={i} data-state={state} className={`lv-line${gap ? " gap" : ""}`} aria-current={state === "active" ? "true" : undefined}>
            {tappable && line.timeSec !== undefined && !gap ? (
              <button type="button" className="lv-line-btn" onClick={() => seekTo(line.timeSec!)}>
                {content}
              </button>
            ) : (
              <div className="lv-line-static">{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
