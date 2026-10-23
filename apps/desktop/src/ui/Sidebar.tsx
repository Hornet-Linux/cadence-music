import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useNav, type Route } from "@/app/navStore";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { sidebarItemOwner, usePluginHost } from "@/plugins/host";
import type { SidebarContribution } from "@/plugins/types";
import { HeartIcon, HomeIcon, LibraryIcon, ListIcon, LogoMark, MoreIcon, PlugIcon, SearchIcon, SettingsIcon } from "./icons";
import {
  groupNavItems,
  loadClosedGroups,
  loadCollapsed,
  saveClosedGroups,
  saveCollapsed,
} from "./navGroups";

/** The four pages everyone uses. On phones everything else lives behind "More". */
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

/** Above this many plugin pages the More sheet gets a find box. */
export const MORE_SEARCH_AT = 9;

/** Alphabetical (so pages are easy to find among many plugins), filtered by label. */
export function filterMoreItems(items: SidebarContribution[], query: string): SidebarContribution[] {
  const q = query.trim().toLowerCase();
  return items
    .filter((i) => !q || i.label.toLowerCase().includes(q))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
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
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterMoreItems(items, query), [items, query]);

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
      const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input")];
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
        {items.length > MORE_SEARCH_AT && (
          <input
            className="more-search"
            type="search"
            placeholder={`Find a page (${items.length})`}
            aria-label="Find a page"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <div className="more-list">
          {shown.length === 0 && <p className="more-empty muted small">No pages match.</p>}
          {shown.map((item) => {
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

type NavMode = "wide" | "tablet" | "phone";

const WIDE_QUERY = "(min-width: 1024px)";
const PHONE_QUERY = "(max-width: 760px)";

function currentMode(): NavMode {
  if (typeof matchMedia !== "function") return "wide";
  if (matchMedia(WIDE_QUERY).matches) return "wide";
  if (matchMedia(PHONE_QUERY).matches) return "phone";
  return "tablet";
}

/** wide ≥ 1024px: full sidebar; tablet 761–1023px: icon rail; phone: bottom tab bar. */
function useNavMode(): NavMode {
  const [mode, setMode] = useState<NavMode>(currentMode);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const lists = [matchMedia(WIDE_QUERY), matchMedia(PHONE_QUERY)];
    const on = () => setMode(currentMode());
    lists.forEach((l) => l.addEventListener("change", on));
    return () => lists.forEach((l) => l.removeEventListener("change", on));
  }, []);
  return mode;
}

interface Tip {
  label: string;
  top: number;
  left: number;
}

function NavItem({
  active,
  icon,
  label,
  iconOnly,
  onClick,
  onTip,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  iconOnly: boolean;
  onClick: () => void;
  onTip: (tip: Tip | null) => void;
}) {
  const showTip = (el: HTMLElement) => {
    if (!iconOnly) return;
    const r = el.getBoundingClientRect();
    onTip({ label, top: r.top + r.height / 2, left: r.right + 10 });
  };
  return (
    <button
      className={`nav-item${active ? " active" : ""}`}
      onClick={onClick}
      aria-label={iconOnly ? label : undefined}
      aria-current={active ? "page" : undefined}
      onMouseEnter={(e) => showTip(e.currentTarget)}
      onFocus={(e) => showTip(e.currentTarget)}
      onMouseLeave={() => onTip(null)}
      onBlur={() => onTip(null)}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </button>
  );
}

/**
 * Navigation.
 * - Wide (≥ 1024px): a full sidebar listing every page, grouped like Settings >
 *   Plugins, with a find box, foldable groups and a fold-to-icons toggle.
 * - Tablet (761–1023px): the same list as an icon rail; the toggle opens it
 *   full-width as a flyout over the page.
 * - Phones: a bottom tab bar of five and the More sheet.
 */
export function Sidebar() {
  const { route, navigate } = useNav();
  const showSettings = useSettingsModal((s) => s.show);
  const sidebarItems = usePluginHost((s) => s.contributions.sidebar);
  const plugins = usePluginHost((s) => s.plugins);
  const user = useServer((s) => s.user);
  const mode = useNavMode();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [flyout, setFlyout] = useState(false);
  const [closed, setClosed] = useState<string[]>(loadClosedGroups);
  const [query, setQuery] = useState("");
  const [tip, setTip] = useState<Tip | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [anchorY, setAnchorY] = useState(80);

  const expanded = mode === "wide" ? !collapsed : mode === "tablet" && flyout;
  const iconOnly = !expanded;

  useEffect(() => {
    if (mode !== "tablet") setFlyout(false);
    if (mode !== "phone") setMoreOpen(false);
  }, [mode]);
  useEffect(() => {
    if (!flyout) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setFlyout(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flyout]);
  useEffect(() => setTip(null), [expanded]);

  const manifests = useMemo(() => new Map(plugins.map((p) => [p.plugin.manifest.id, p.plugin.manifest])), [plugins]);
  const searchable = expanded && sidebarItems.length > MORE_SEARCH_AT;
  const q = searchable ? query : "";
  const groups = useMemo(
    () =>
      groupNavItems(
        sidebarItems,
        (id) => {
          const owner = sidebarItemOwner(id);
          return owner ? manifests.get(owner) : undefined;
        },
        q,
      ),
    [sidebarItems, manifests, q],
  );
  const mainPages = MAIN_PAGES.filter((p) => !q.trim() || p.label.toLowerCase().includes(q.trim().toLowerCase()));

  const go = (r: Route) => {
    navigate(r);
    setFlyout(false);
  };
  const toggleGroup = (g: string) => {
    const next = closed.includes(g) ? closed.filter((x) => x !== g) : [...closed, g];
    setClosed(next);
    saveClosedGroups(next);
  };
  const toggleExpanded = () => {
    if (mode === "wide") {
      setCollapsed(!collapsed);
      saveCollapsed(!collapsed);
    } else {
      setFlyout(!flyout);
    }
  };

  const openMore = (el: HTMLElement) => {
    setAnchorY(Math.round(el.getBoundingClientRect().top));
    setMoreOpen(true);
  };
  const closeMore = () => setMoreOpen(false);
  const moreActive = route.kind === "plugin";
  const toggleLabel = expanded ? "Collapse sidebar" : "Expand sidebar";

  return (
    <>
      {flyout && <div className="rail-scrim" onMouseDown={() => setFlyout(false)} aria-hidden />}
      <nav className={`rail${expanded ? " expanded" : " icons"}${flyout ? " flyout" : ""}`} aria-label="Main">
        <div className="rail-top">
          <div className="rail-logo" aria-hidden>
            <LogoMark size={32} />
            <span className="rail-wordmark">Cadence</span>
          </div>
          <button
            className="rail-toggle"
            onClick={toggleExpanded}
            aria-label={toggleLabel}
            aria-expanded={expanded}
            onMouseEnter={(e) => {
              if (!iconOnly) return;
              const r = e.currentTarget.getBoundingClientRect();
              setTip({ label: toggleLabel, top: r.top + r.height / 2, left: r.right + 10 });
            }}
            onMouseLeave={() => setTip(null)}
          >
            <ListIcon size={18} />
          </button>
        </div>
        {searchable && (
          <label className="rail-search">
            <SearchIcon size={15} />
            <input
              type="search"
              placeholder={`Find a page (${sidebarItems.length + MAIN_PAGES.length})`}
              aria-label="Find a page"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
        <div className="rail-scroll">
          <NavSection title="Library" iconOnly={iconOnly} open={!closed.includes("Library") || !!q} onToggle={toggleGroup}>
            {mainPages.map((p) => (
              <NavItem
                key={p.kind}
                active={route.kind === p.kind}
                icon={p.icon(20)}
                label={p.label}
                iconOnly={iconOnly}
                onClick={() => go({ kind: p.kind })}
                onTip={setTip}
              />
            ))}
          </NavSection>
          {groups.map(({ group, items }) => (
            <NavSection
              key={group}
              title={group}
              iconOnly={iconOnly}
              open={!closed.includes(group) || !!q}
              onToggle={toggleGroup}
            >
              {items.map((item) => (
                <NavItem
                  key={item.id}
                  active={route.kind === "plugin" && route.itemId === item.id}
                  icon={item.icon ?? <PlugIcon size={20} />}
                  label={item.label}
                  iconOnly={iconOnly}
                  onClick={() => go({ kind: "plugin", itemId: item.id })}
                  onTip={setTip}
                />
              ))}
            </NavSection>
          ))}
          {q && mainPages.length === 0 && groups.length === 0 && <p className="rail-empty muted small">No pages match.</p>}
        </div>
        <div className="rail-bottom">
          {user && expanded && (
            <button className="nav-item rail-account" onClick={() => showSettings("server")}>
              <span className="nav-icon rail-avatar" aria-hidden>
                {(user.displayName ?? user.username).slice(0, 1).toUpperCase()}
              </span>
              <span className="nav-label">{user.displayName ?? user.username}</span>
            </button>
          )}
          <NavItem
            icon={<SettingsIcon size={20} />}
            label="Settings"
            iconOnly={iconOnly}
            onClick={() => {
              setFlyout(false);
              showSettings();
            }}
            onTip={setTip}
          />
        </div>
      </nav>
      {tip && (
        <div className="rail-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
          {tip.label}
        </div>
      )}

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

/** A titled, foldable group of pages. In the icon rail it is just a thin divider. */
function NavSection({
  title,
  iconOnly,
  open,
  onToggle,
  children,
}: {
  title: string;
  iconOnly: boolean;
  open: boolean;
  onToggle: (title: string) => void;
  children: ReactNode;
}) {
  if (iconOnly) {
    return (
      <div className="nav-section" role="group" aria-label={title}>
        {children}
      </div>
    );
  }
  return (
    <div className="nav-section" role="group" aria-label={title}>
      <button className="nav-heading" aria-expanded={open} onClick={() => onToggle(title)}>
        <span>{title}</span>
        <span className={`nav-caret${open ? " open" : ""}`} aria-hidden>
          ›
        </span>
      </button>
      {open && <div className="nav-items">{children}</div>}
    </div>
  );
}
