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
