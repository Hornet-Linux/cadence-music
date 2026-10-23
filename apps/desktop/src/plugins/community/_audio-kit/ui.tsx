import type { ReactNode } from "react";
import "./style.css";

/** A labelled range slider with a 44px-tall touch target. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (v) => String(v),
  disabled,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className={`ax-slider${disabled ? " off" : ""}`}>
      <span className="ax-slider-head">
        <span>{label}</span>
        <output>{format(value)}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <span className="ax-hint">{hint}</span>}
    </label>
  );
}

/** A wrapping row of single-choice buttons (presets, durations...). */
export function Chips<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="ax-chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`ax-chip${value === o.value ? " on" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A quiet block of explanatory text. */
export function Note({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return <p className={`ax-note${tone === "warn" ? " warn" : ""}`}>{children}</p>;
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="ax-section">
      {title && <h3 className="ax-title">{title}</h3>}
      {children}
    </section>
  );
}

/** Title + description on the left, control on the right; wraps on phones. */
export function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="ax-row">
      <div className="ax-row-text">
        <div className="ax-row-title">{title}</div>
        {description && <div className="ax-hint">{description}</div>}
      </div>
      <div className="ax-row-control">{children}</div>
    </div>
  );
}
