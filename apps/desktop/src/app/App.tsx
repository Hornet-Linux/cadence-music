import { useEffect, useRef } from "react";
import { usePluginHost } from "@/plugins/host";
import { allRegisterablePlugins } from "@/plugins/builtins";
import { startHistoryTracking } from "@/features/history/historyStore";
import { HomeView } from "@/features/home/HomeView";
import { SetupWizard } from "@/features/onboarding/SetupWizard";
import { SearchView } from "@/features/search/SearchView";
import { LibraryView } from "@/features/library/LibraryView";
import { SettingsModal } from "@/features/settings/SettingsModal";
import { startPlayerIntegrations } from "@/player/integrations";
import { Sidebar } from "@/ui/Sidebar";
import { TitleBar } from "@/ui/TitleBar";
import { PlayerBar } from "@/ui/PlayerBar";
import { QueueDrawer } from "@/ui/QueueDrawer";
import { useNav, type Route } from "./navStore";
import { useTheme } from "./theme";

function MainView({ route }: { route: Route }) {
  const sidebarItems = usePluginHost((s) => s.contributions.sidebar);

  switch (route.kind) {
    case "home":
      return <HomeView />;
    case "search":
      return <SearchView />;
    case "library":
      return <LibraryView />;
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
  const route = useNav((s) => s.route);
  const mainRef = useRef<HTMLElement>(null);
  useTheme();

  useEffect(() => {
    for (const plugin of allRegisterablePlugins) register(plugin);
    startPlayerIntegrations();
    startHistoryTracking();
  }, [register]);

  // Each page starts at the top.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [route]);

  return (
    <div className="app">
      <Sidebar />
      <div className="stage">
        <div className="ambient" aria-hidden />
        <TitleBar />
        <main className="main" ref={mainRef}>
          <MainView route={route} />
        </main>
        <QueueDrawer />
        <PlayerBar />
      </div>
      <SettingsModal />
      <SetupWizard />
    </div>
  );
}
