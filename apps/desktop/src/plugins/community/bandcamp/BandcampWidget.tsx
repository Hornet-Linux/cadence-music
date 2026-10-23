import { useState } from "react";
import { addItem, embedSrc, parseBandcampInput, type BandcampItem } from "./parse";
import "./style.css";

const DOCS = "https://github.com/Hornet-Linux/cadence-music/blob/main/docs/BANDCAMP.md";

/** The player stays unloaded until it is asked for, so nothing is fetched from Bandcamp just by opening Home. */
function Embed({ item }: { item: Extract<BandcampItem, { kind: "embed" }> }) {
  const [shown, setShown] = useState(false);
  return shown ? (
    <iframe
      className="bc-frame"
      title={`Bandcamp player: ${item.title}`}
      src={embedSrc(item.type, item.id)}
      loading="lazy"
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    />
  ) : (
    <button className="btn" onClick={() => setShown(true)}>
      Show Bandcamp player
    </button>
  );
}

export function BandcampWidget({ items, onChange }: { items: BandcampItem[]; onChange: (items: BandcampItem[]) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add() {
    const result = parseBandcampInput(text);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError(null);
    onChange(addItem(items, result.item));
    setText("");
  }

  return (
    <div className="stack bc-root">
      <p className="muted small">
        Bandcamp doesn&apos;t let other apps play your collection. You can keep albums here to open on Bandcamp, or paste an album&apos;s
        official embed code (Share, then Embed on its Bandcamp page) to play it right here. Music you bought and downloaded plays from your
        library like any other files.{" "}
        <a href={DOCS} target="_blank" rel="noreferrer">
          How it works
        </a>
      </p>
      <form
        className="bc-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label className="field-label" htmlFor="bc-input">
          Bandcamp link or embed code
        </label>
        <textarea
          id="bc-input"
          className="text-input bc-input"
          rows={2}
          value={text}
          placeholder="https://artist.bandcamp.com/album/name"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <div>
          <button className="btn primary" type="submit" disabled={!text.trim()}>
            Add
          </button>
        </div>
      </form>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {items.length === 0 ? (
        <p className="muted small">Nothing saved yet.</p>
      ) : (
        <ul className="bc-list">
          {items.map((item) => {
            const key = item.kind === "embed" ? `${item.type}-${item.id}` : item.url;
            return (
              <li key={key} className="bc-item">
                <div className="bc-head">
                  <div className="bc-text">
                    <div className="strong bc-title">{item.title}</div>
                    <div className="muted small">{item.kind === "link" ? item.artist : item.type === "album" ? "Album" : "Track"}</div>
                  </div>
                  <button className="btn ghost" onClick={() => onChange(items.filter((x) => x !== item))} aria-label={`Remove ${item.title}`}>
                    Remove
                  </button>
                </div>
                {item.kind === "embed" && <Embed item={item} />}
                {(item.kind === "link" || item.pageUrl) && (
                  <a className="btn bc-open" href={item.kind === "link" ? item.url : item.pageUrl} target="_blank" rel="noopener noreferrer">
                    Open on Bandcamp
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
