import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
  </Svg>
);
export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Svg>
);
export const LibraryIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 5v14M9 5v14" />
    <path d="m14 5 5 14" />
  </Svg>
);
export const SettingsIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1l-.3-2.5H9.4l-.3 2.5a7 7 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.3 2.5h4.2l.3-2.5a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" />
  </Svg>
);
export const PlugIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 2v6M15 2v6" />
    <path d="M7 8h10v3a5 5 0 0 1-10 0V8Z" />
    <path d="M12 16v6" />
  </Svg>
);
export const PlayIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 4.5v15l12-7.5-12-7.5Z" fill="currentColor" stroke="none" />
  </Svg>
);
export const PauseIcon = (p: P) => (
  <Svg {...p}>
    <rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);
export const PrevIcon = (p: P) => (
  <Svg {...p}>
    <path d="M18 5v14l-10-7 10-7Z" fill="currentColor" stroke="none" />
    <rect x="5" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);
export const NextIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 5v14l10-7L6 5Z" fill="currentColor" stroke="none" />
    <rect x="16.6" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);
export const ShuffleIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 5h4l10 14h4" />
    <path d="M17 5h4v4M21 5l-6 6M3 19h4l3-4" />
  </Svg>
);
export const RepeatIcon = (p: P) => (
  <Svg {...p}>
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </Svg>
);
export const VolumeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" stroke="none" />
    <path d="M16 9a3 3 0 0 1 0 6M18.5 6.5a7 7 0 0 1 0 11" />
  </Svg>
);
export const MuteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" stroke="none" />
    <path d="m17 9 4 6M21 9l-4 6" />
  </Svg>
);
export const MinIcon = (p: P) => (
  <Svg {...p} size={14}>
    <path d="M5 12h14" />
  </Svg>
);
export const MaxIcon = (p: P) => (
  <Svg {...p} size={13}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </Svg>
);
export const CloseIcon = (p: P) => (
  <Svg {...p} size={14}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const ServerIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="6.5" rx="2" />
    <rect x="3.5" y="13.5" width="17" height="6.5" rx="2" />
    <path d="M7.5 7.25h.01M7.5 16.75h.01" strokeWidth={2.6} />
  </Svg>
);
export const WavesIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M7.5 9.5c3-1 6.5-.7 9.2.8M8 12.6c2.5-.7 5.2-.5 7.5.7M8.6 15.5c2-.5 4-.3 5.8.5" />
  </Svg>
);
export const NoteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 18V6.5l11-2.5v11.5" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17.5" cy="15.5" r="2.5" />
  </Svg>
);
export const FolderIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
  </Svg>
);
export const QueueIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h12M4 11h12M4 16h7" />
    <path d="M15.5 14.5v5l4-2.5-4-2.5Z" fill="currentColor" />
  </Svg>
);
export const LyricsIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7l-4 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z" />
    <path d="M8 10h8M8 13h5" />
  </Svg>
);
export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const SparkleIcon = (p: P) => (
  <Svg {...p}>
    <path
      d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15A2 2 0 0 0 9 13.8L3.5 12 9 10.2A2 2 0 0 0 10.2 9Z"
      fill="currentColor"
      stroke="none"
    />
  </Svg>
);
export const FlameIcon = (p: P) => (
  <Svg {...p}>
    <path
      d="M12 21c-4 0-6.5-2.7-6.5-6.2 0-3.6 2.6-5.6 3.8-8.8.4 2.1 1.7 3.2 2.7 3.6C12.5 6.5 13.6 4 15.8 3c-.4 2.8 2.7 5.2 2.7 10.8C18.5 18.3 16 21 12 21Z"
      fill="currentColor"
      stroke="none"
    />
  </Svg>
);
export const TrophyIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 4h8v5a4 4 0 0 1-8 0Z" fill="currentColor" stroke="none" />
    <path d="M8 6H5.5a2.5 2.5 0 0 0 2.6 3M16 6h2.5a2.5 2.5 0 0 1-2.6 3M12 13v4M8.5 20h7" />
  </Svg>
);
export const ClockIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const DiscIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2.2" />
  </Svg>
);
export const SlidersIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 6h8M17 6h2M5 12h2M11 12h8M5 18h10M19 18h0" />
    <circle cx="15" cy="6" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="17" cy="18" r="2" />
  </Svg>
);
export const PaletteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.4-1.9-.5-1.2.2-2.6 1.6-2.6h1.6a3.9 3.9 0 0 0 3.9-3.9c0-4.8-3.8-8.6-8.5-8.6Z" />
    <circle cx="7.8" cy="11" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="7.6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="14.8" cy="7.8" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);
export const InfoIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" strokeWidth={2.2} />
  </Svg>
);
/**
 * The app mark: a play button drawn with equaliser bars. The tile
 * follows the accent colour (flat, no gloss) with dark bars on top.
 * build/icon.png is the same mark with a fixed gradient
 * (see scripts/make-icon.ps1).
 */
export const LogoMark = (p: P) => (
  <Svg {...p} viewBox="0 0 24 24" stroke="none">
    <rect x="1" y="1" width="22" height="22" rx="7" fill="var(--accent-from)" />
    {/* Equaliser bars that shrink left to right, tracing a play triangle. */}
    <g fill="var(--accent-fg)">
      <rect x="5.75" y="6" width="1.9" height="12" rx="0.95" />
      <rect x="8.65" y="7.4" width="1.9" height="9.2" rx="0.95" />
      <rect x="11.55" y="8.8" width="1.9" height="6.4" rx="0.95" />
      <rect x="14.45" y="10.1" width="1.9" height="3.8" rx="0.95" />
      <rect x="17.35" y="11.05" width="1.9" height="1.9" rx="0.95" />
    </g>
  </Svg>
);
export const BackIcon = (p: P) => (
  <Svg {...p}>
    <path d="m15 5-7 7 7 7" />
  </Svg>
);
export const ForwardIcon = (p: P) => (
  <Svg {...p}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
);
export const HeartIcon = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p} fill={filled ? "currentColor" : "none"}>
    <path d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.7 3.9 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.7 1.1-1.6 2.7-2.7 4.7-2.7 3.4 0 5.7 3.2 4.5 6.6-1.7 4.8-9.2 9.4-9.2 9.4Z" />
  </Svg>
);
export const ListIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h12M4 12h12M4 18h8" />
    <path d="M19 15v6M16 18h6" />
  </Svg>
);
export const MoreIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" />
  </Svg>
);
export const TrashIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
);
