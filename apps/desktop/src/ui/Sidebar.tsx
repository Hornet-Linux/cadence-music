import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useNav, type Route } from "@/app/navStore";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { usePluginHost } from "@/plugins/host";
import type { SidebarContribution } from "@/plugins/types";
import { HeartIcon, HomeIcon, LibraryIcon, LogoMark, MoreIcon, PlugIcon, SearchIcon, SettingsIcon } from "./icons";

/** The four pages everyone uses. Everything else (plugin pages, settings) lives behind "More". */
export const MAIN_PAGES: {
  kind: Exclude<Route["kind"], "playlist" | "plugin">;
  label: string;
  icon: (size: number) => ReactNode;
}[] = [
  { kind: "home", label: "Home", icon: (s) => <HomeIcon size={s} /> },
  { kind: "search", label: "Search", icon: (s) => <SearchIcon size={s} /> },
  { kind: "library", label: "Library", icon: (s) => <LibraryIcon size={s} /> },
  { kind: "liked", label: "Favourites", icon: (s) => <HeartIcon size={s} /> },
];

function RailButton({
  active,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`rail-btn${active ? " active" : ""}`}
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      data-tip={label}
    >
      {icon}
    </button>
  );
}

/**
 * Bottom sheet on phones, small popover beside the rail on desktop: the
 * pages plugins add, and Settings. Every plugin page stays reachable here.
 */
export function MoreSheet({
  items,
  route,
  anchorY,
  onPick,
  onSettings,
  onClose,
}: {
  items: SidebarContribution[];
  route: Route;
  anchorY: number;
  onPick: (item: SidebarContribution) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);

  // Move focus in, and give it back to whatever opened the sheet.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    sheetRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab" && sheetRef.current) {
      // Keep Tab inside the sheet while it is open.
      const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  return (
    <div className="more-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKeyDown}>
      <div
        className="more-sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="More"
        style={{ "--pop-y": `${anchorY}px` } as CSSProperties}
      >
        <div className="more-grab" aria-hidden />
        <div className="more-title">More</div>
        <div className="more-list">
          {items.map((item) => {
            const active = route.kind === "plugin" && route.itemId === item.id;
            return (
              <button
                key={item.id}
                className={`more-item${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => onPick(item)}
              >
                {item.icon ?? <PlugIcon size={22} />}
                <span className="label">{item.label}</span>
              </button>
            );
          })}
          <button className="more-item phone-only" onClick={onSettings}>
            <SettingsIcon size={22} />
            <span className="label">Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Navigation. Desktop and wide web: a slim icon rail (Home, Search, Library,
 * Favourites, one "More" button for plugin pages, Settings). Phones: a bottom
 * tab bar of five (Home, Search, Library, Favourites, More). The CSS decides
 * which of the two is visible.
 */
export function Sidebar() {
  const { route, navigate } = useNav();
  const showSettings = useSettingsModal((s) => s.show);
  const sidebarItems = usePluginHost((s) => s.contributions.sidebar);
  const [moreOpen, setMoreOpen] = useState(false);
  const [anchorY, setAnchorY] = useState(80);

  const openMore = (el: HTMLElement) => {
    setAnchorY(Math.round(el.getBoundingClientRect().top));
    setMoreOpen(true);
  };
  const closeMore = () => setMoreOpen(false);
  const moreActive = route.kind === "plugin";

  return (
    <>
      <nav className="rail" aria-label="Main">
        <div className="rail-logo" aria-hidden>
          <LogoMark size={32} />
        </div>
        {MAIN_PAGES.map((p) => (
          <RailButton
            key={p.kind}
            active={route.kind === p.kind}
            icon={p.icon(22)}
            label={p.label}
            onClick={() => navigate({ kind: p.kind })}
          />
        ))}
        {sidebarItems.length > 0 && (
          <button
            className={`rail-btn${moreActive || moreOpen ? " active" : ""}`}
            aria-label="More"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            data-tip="More"
            onClick={(e) => openMore(e.currentTarget)}
          >
            <MoreIcon size={22} />
          </button>
        )}
        <div className="rail-spacer" />
        <RailButton icon={<SettingsIcon size={22} />} label="Settings" onClick={() => showSettings()} />
      </nav>

      <nav className="tabbar" aria-label="Main">
        {MAIN_PAGES.map((p) => (
          <button
            key={p.kind}
            className={`tab${route.kind === p.kind ? " active" : ""}`}
            aria-current={route.kind === p.kind ? "page" : undefined}
            onClick={() => navigate({ kind: p.kind })}
          >
            {p.icon(22)}
            <span>{p.label}</span>
          </button>
        ))}
        <button
          className={`tab${moreActive || moreOpen ? " active" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={(e) => openMore(e.currentTarget)}
        >
          <MoreIcon size={22} />
          <span>More</span>
        </button>
      </nav>

      {moreOpen && (
        <MoreSheet
          items={sidebarItems}
          route={route}
          anchorY={anchorY}
          onPick={(item) => {
            navigate({ kind: "plugin", itemId: item.id });
            closeMore();
          }}
          onSettings={() => {
            closeMore();
            showSettings();
          }}
          onClose={closeMore}
        />
      )}
    </>
  );
}
