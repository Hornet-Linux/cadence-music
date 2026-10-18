import { useEffect } from "react";
import { usePluginHost } from "@/plugins/host";
import { allRegisterablePlugins } from "@/plugins/builtins";
import { HomeView } from "@/features/home/HomeView";
import { SearchView } from "@/features/search/SearchView";
import { LibraryView } from "@/features/library/LibraryView";
import { SettingsView } from "@/features/settings/SettingsView";
import { Sidebar } from "@/ui/Sidebar";
import { TitleBar } from "@/ui/TitleBar";
import { PlayerBar } from "@/ui/PlayerBar";
import { useNav } from "./navStore";

function MainView() {
  const route = useNav((s) => s.route);
  const sidebarItems = usePluginHost((s) => s.contributions.sidebar);

  switch (route.kind) {
    case "home":
      return <HomeView />;
    case "search":
      return <SearchView />;
    case "library":
      return <LibraryView />;
    case "settings":
      return <SettingsView />;
    case "plugin": {
      const item = sidebarItems.find((i) => i.id === route.itemId);
      return item ? (
        <>{item.render()}</>
      ) : (
        <div className="view">
          <p className="empty">This plugin page is no longer available.</p>
        </div>
      );
    }
  }
}

export function App() {
  const register = usePluginHost((s) => s.register);

  useEffect(() => {
    for (const plugin of allRegisterablePlugins) register(plugin);
  }, [register]);

  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        <Sidebar />
        <main className="main">
          <MainView />
        </main>
      </div>
      <PlayerBar />
    </div>
  );
}
