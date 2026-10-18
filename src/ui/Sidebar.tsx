import { useNav, type Route } from "@/app/navStore";
import { usePluginHost } from "@/plugins/host";
import { mockPlaylists } from "@/shared/mock";
import { HomeIcon, LibraryIcon, PlugIcon, SearchIcon, SettingsIcon } from "./icons";

function NavItem({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={`nav-item${active ? " active" : ""}`} onClick={onClick}>
      <span className="icon">{icon}</span>
      {label}
    </button>
  );
}

export function Sidebar() {
  const { route, navigate } = useNav();
  const sidebarItems = usePluginHost((s) => s.contributions.sidebar);

  const is = (kind: Route["kind"]) => route.kind === kind;

  return (
    <nav className="sidebar">
      <div className="nav-group">
        <NavItem active={is("home")} icon={<HomeIcon />} label="Home" onClick={() => navigate({ kind: "home" })} />
        <NavItem active={is("search")} icon={<SearchIcon />} label="Search" onClick={() => navigate({ kind: "search" })} />
        <NavItem active={is("library")} icon={<LibraryIcon />} label="Library" onClick={() => navigate({ kind: "library" })} />
      </div>

      {sidebarItems.length > 0 && (
        <div className="nav-group">
          <div className="nav-label">Plugins</div>
          {sidebarItems.map((item) => (
            <NavItem
              key={item.id}
              active={route.kind === "plugin" && route.itemId === item.id}
              icon={item.icon ?? <PlugIcon />}
              label={item.label}
              onClick={() => navigate({ kind: "plugin", itemId: item.id })}
            />
          ))}
        </div>
      )}

      <div className="nav-group" style={{ flex: 1, minHeight: 0 }}>
        <div className="nav-label">Playlists</div>
        <div className="playlist-list">
          {mockPlaylists.map((pl) => (
            <button key={pl.id} className="playlist-item" title={pl.name}>
              {pl.name}
            </button>
          ))}
        </div>
      </div>

      <div className="nav-group">
        <NavItem active={is("settings")} icon={<SettingsIcon />} label="Settings" onClick={() => navigate({ kind: "settings" })} />
      </div>
    </nav>
  );
}
