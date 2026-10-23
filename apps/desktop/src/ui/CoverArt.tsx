import { useState } from "react";
import { fallbackPair, hashString } from "./color";

interface Props {
  /** Artwork URL, when the source provides one. */
  src?: string;
  /** Seed for the generated fallback (album or title). */
  seed: string;
  label?: string;
  showInitial?: boolean;
}

/**
 * Real artwork when available, otherwise a generated gradient so nothing
 * ever looks broken or empty.
 */
export function CoverArt({ src, seed, label, showInitial = true }: Props) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  if (src && failed !== src) {
    // Fades in once decoded instead of popping in line by line.
    return (
      <img
        className={`cover cover-img${loaded === src ? " loaded" : ""}`}
        ref={(img) => {
          if (img?.complete && img.naturalWidth > 0 && loaded !== src) setLoaded(src);
        }}
        onLoad={() => setLoaded(src)}
        src={src}
        alt={label ?? ""}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(src)}
      />
    );
  }
  const [a, b] = fallbackPair(seed);
  const angle = (hashString(seed) % 8) * 45;
  return (
    <div className="cover" style={{ background: `linear-gradient(${angle}deg, ${a}, ${b})` }} aria-label={label}>
      {showInitial && coverInitial(label)}
    </div>
  );
}

/**
 * The letter shown on a generated cover: the first letter of the label,
 * skipping leading digits and punctuation ("01 Intro" → "I", "(Live)" → "L").
 * Labels without any letter get a quiet note glyph instead of a stray "0".
 */
export function coverInitial(label?: string): string {
  if (!label) return "";
  const m = label.match(/\p{L}/u);
  return m ? m[0].toLocaleUpperCase() : "♪";
}
