import type { ReactNode, SVGProps } from "react";
import "./base.css";

/** Shared page frame and small controls for the social and fun plugins. Calm, phone-first. */

export function Page({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`view sx-page ${className}`}>
      <header className="view-header sx-head">
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {actions && <div className="sx-head-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="segmented sx-tabs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "error"; children: ReactNode }) {
  return (
    <div className={`notice sx-notice${kind === "info" ? "" : ` ${kind}`}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/** A big number with a caption. */
export function Stat({ value, label, hint }: { value: ReactNode; label: string; hint?: string }) {
  return (
    <div className="sx-stat">
      <div className="sx-stat-value">{value}</div>
      <div className="sx-stat-label">{label}</div>
      {hint && <div className="sx-stat-hint">{hint}</div>}
    </div>
  );
}

type IconProps = SVGProps<SVGSVGElement> & { size?: number };
function Svg({ size = 22, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  );
}

export const ChartIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Svg>
);
export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Svg>
);
export const RoomIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <rect x="3" y="14" width="4" height="6" rx="1.5" />
    <rect x="17" y="14" width="4" height="6" rx="1.5" />
  </Svg>
);
export const UsersIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
    <path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.8c1.8.7 3 2.3 3 5.2" />
  </Svg>
);
export const CardIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="3.5" width="16" height="17" rx="3" />
    <circle cx="12" cy="10" r="3" />
    <path d="M8 17h8" />
  </Svg>
);
export const QuizIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.8.4-1.1.9-1.1 1.8M12 17h.01" />
  </Svg>
);
export const ShelfIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 20h18M5 20V8h4v12M11 20V5h4v15M17 20v-9h2.5v9" />
  </Svg>
);
export const LoopIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4" />
  </Svg>
);
export const CloudIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 9a4.5 4.5 0 0 1 .5 9H7Z" />
  </Svg>
);
export const ThumbIcon = ({ down, ...p }: IconProps & { down?: boolean }) => (
  <Svg {...p} style={down ? { transform: "rotate(180deg)" } : undefined}>
    <path d="M7 11v9H4v-9h3Zm0 0 4-8c1.7 0 2.5 1.2 2.2 2.6L12.7 9H19a2 2 0 0 1 2 2.4l-1.2 6A2 2 0 0 1 17.8 19H7" />
  </Svg>
);