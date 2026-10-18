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
  if (src && failed !== src) {
    return (
      <img
        className="cover cover-img"
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
      {showInitial && (label?.[0]?.toUpperCase() ?? "")}
    </div>
  );
}
