import type { ReactNode } from "react";

/**
 * A calm "nothing here yet" panel: an icon, one line saying what is missing,
 * one line saying what to do about it, and at most one action.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state" role="status">
      <span className="empty-icon" aria-hidden>
        {icon}
      </span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
