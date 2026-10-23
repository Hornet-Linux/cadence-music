import { useEffect, useState } from "react";
import { create } from "zustand";
import { usePlayer } from "@/player/playerStore";
import { primaryArtist, type Track } from "@/shared/types";
import { copyImage, downloadBlob, shareImage } from "../_social/canvasCard";
import { Notice, Page, Tabs } from "../_social/ui";
import { cardText, FORMATS, renderTrackCard, type CardFormat } from "./trackCard";
import "./style.css";

export const SHARE_ITEM_ID = "share-card";

/** The track a card was requested for from a track menu; otherwise the page uses what is playing. */
export const useShareCard = create<{ track: Track | null; set: (t: Track | null) => void }>((set) => ({
  track: null,
  set: (track) => set({ track }),
}));

export function SharePage() {
  const requested = useShareCard((s) => s.track);
  const current = usePlayer((s) => s.current);
  const track = requested ?? current;
  const [format, setFormat] = useState<CardFormat>("portrait");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!track) {
      setBlob(null);
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setError(null);
    setMessage(null);
    renderTrackCard(track, format)
      .then((b) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b);
        setBlob(b);
        setUrl(objectUrl);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [track, format]);

  const text = track ? cardText(track) : null;

  return (
    <Page
      title="Share card"
      subtitle="Make a clean picture of what you are listening to. It is drawn on your device; nothing is uploaded."
    >
      {!track || !text ? (
        <div className="sx-card">
          <p>Nothing is playing.</p>
          <p className="muted small">Start a song, or choose Share card from a track menu, and its card appears here.</p>
        </div>
      ) : (
        <div className="sc-layout">
          <div className="sc-preview">
            {error && <Notice kind="error">{error}</Notice>}
            {url ? (
              <img className={`sc-img ${format}`} src={url} alt={`Card for ${track.title} by ${primaryArtist(track)}`} width={FORMATS[format].width} height={FORMATS[format].height} />
            ) : (
              !error && <div className={`sc-img sc-skeleton ${format}`} aria-busy />
            )}
          </div>
          <div className="sx-stack sc-controls">
            <div>
              <div className="title strong">{text.title}</div>
              <div className="muted">{text.artist}</div>
            </div>
            <Tabs
              label="Card shape"
              value={format}
              onChange={setFormat}
              options={(Object.keys(FORMATS) as CardFormat[]).map((f) => ({ id: f, label: FORMATS[f].label }))}
            />
            <div className="sx-row">
              <button className="btn" disabled={!blob} onClick={() => blob && downloadBlob(blob, text.fileName)}>
                Download
              </button>
              <button
                className="btn"
                disabled={!blob}
                onClick={async () => {
                  if (!blob) return;
                  const r = await shareImage(blob, text.fileName, `${text.title} - ${text.artist}`, `${text.title} by ${text.artist}`);
                  setMessage(r === "unsupported" ? "Sharing isn't available here. Download or copy the image instead." : r === "shared" ? "Shared." : null);
                }}
              >
                Share
              </button>
              <button
                className="btn"
                disabled={!blob}
                onClick={async () => {
                  if (!blob) return;
                  setMessage((await copyImage(blob)) ? "Copied to the clipboard." : "Copying images isn't supported here. Download it instead.");
                }}
              >
                Copy
              </button>
            </div>
            <p className="muted small" aria-live="polite">
              {message ?? (track.artwork ? "If the cover can't be read from its source, a plain placeholder is drawn instead." : "This track has no cover art, so a plain placeholder is drawn.")}
            </p>
          </div>
        </div>
      )}
    </Page>
  );
}