import type { ReactNode } from "react";
import { useNav } from "@/app/navStore";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { usePluginHost } from "@/plugins/host";
import { HeartIcon, HomeIcon, LibraryIcon, LogoMark, PlugIcon, SearchIcon, SettingsIcon } from "./icons";

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

/** Slim icon rail: core views, then a page per plugin, settings at the bottom. */
export function Sidebar() {
  const { route, navigate } = useNav();
  const showSettings = useSettingsModal((s) => s.show);
  const sidebarItems = usePluginHost((s) => s.contributions.sidebar);

  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-logo" aria-hidden>
        <LogoMark size={34} />
      </div>
      <RailButton active={route.kind === "home"} icon={<HomeIcon size={22} />} label="Home" onClick={() => navigate({ kind: "home" })} />
      <RailButton active={route.kind === "search"} icon={<SearchIcon size={22} />} label="Search" onClick={() => navigate({ kind: "search" })} />
      <RailButton active={route.kind === "library"} icon={<LibraryIcon size={22} />} label="Library" onClick={() => navigate({ kind: "library" })} />
      <RailButton active={route.kind === "liked"} icon={<HeartIcon size={22} />} label="Liked Songs" onClick={() => navigate({ kind: "liked" })} />

      {sidebarItems.length > 0 && <div className="rail-divider" />}
      {sidebarItems.map((item) => (
        <RailButton
          key={item.id}
          active={route.kind === "plugin" && route.itemId === item.id}
          icon={item.icon ?? <PlugIcon size={22} />}
          label={item.label}
          onClick={() => navigate({ kind: "plugin", itemId: item.id })}
        />
      ))}

      <div className="rail-spacer" />
      <RailButton icon={<SettingsIcon size={22} />} label="Settings" onClick={() => showSettings()} />
    </nav>
  );
}
