import { useEffect, useRef, useState, type ReactNode } from "react";
import "./panel.css";

/** A status line with a small coloured dot: ok (muted green), warn (muted amber), off (grey). */
export function StatusLine({ tone, children }: { tone: "ok" | "warn" | "off"; children: ReactNode }) {
  return (
    <div className={`di-status di-${tone}`} role="status">
      <span className="di-dot" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/** Copy text to the clipboard and say so for a moment. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      className="btn ghost di-btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="di-code">{children}</code>;
}

/** A block of text or commands the person may want to copy. */
export function CodeBlock({ children }: { children: string }) {
  return (
    <div className="di-block">
      <pre>{children}</pre>
      <CopyButton text={children} />
    </div>
  );
}

export function Help({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="di-help">
      <summary>{title}</summary>
      <div className="di-help-body">{children}</div>
    </details>
  );
}
