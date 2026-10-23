import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  );
}

export const RadioIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="8" width="18" height="12" rx="2.5" />
    <path d="m7 8 9-5" />
    <circle cx="9" cy="14" r="2.5" />
    <path d="M15 12.5h3M15 15.5h3" />
  </Svg>
);
export const MicIcon = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </Svg>
);
export const BookIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
    <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3" />
  </Svg>
);
export const ArchiveIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 4h17v4h-17zM5 8v11.5h14V8" />
    <path d="M10 12.5h4" />
  </Svg>
);
export const Back15Icon = (p: P) => (
  <Svg {...p}>
    <path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5" />
    <path d="M4 4v4.5h4.5" />
    <path d="M10 10v4.5M13.5 10h-2v2h1.4a1.2 1.2 0 0 1 0 2.5H11.4" strokeWidth={1.5} />
  </Svg>
);
export const Fwd30Icon = (p: P) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9L20 8.5" />
    <path d="M20 4v4.5h-4.5" />
    <path d="M8.6 10.3h2.2a1 1 0 0 1 0 2h-1m1 0a1 1 0 0 1 0 2H8.6M14 10.3h2a1 1 0 0 1 1 1v2.4a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-2.4a1 1 0 0 1 1-1z" strokeWidth={1.4} />
  </Svg>
);
export const MoonIcon = (p: P) => (
  <Svg {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const BookmarkIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 3.5h11v17L12 16.5l-5.5 4z" />
  </Svg>
);
export const DownloadIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5v12M7 11l5 5 5-5M5 20.5h14" />
  </Svg>
);
export const UploadIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 16.5v-12M7 9.5l5-5 5 5M5 20.5h14" />
  </Svg>
);
/** A storage bucket, for S3-compatible storage. */
export const BucketIcon = (p: P) => (
  <Svg {...p}>
    <ellipse cx="12" cy="6" rx="8" ry="2.5" />
    <path d="M4 6l1.6 12.2C5.8 19.8 8.6 21 12 21s6.2-1.2 6.4-2.8L20 6" />
  </Svg>
);

/** A cloud, for Google Drive and OneDrive. */
export const CloudIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7 18.5Z" />
  </Svg>
);
