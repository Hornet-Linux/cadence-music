import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useHistory } from "@/features/history/historyStore";
import { useOnboarding } from "@/features/onboarding/onboardingStore";
import { ACCENTS, usePrefs } from "@/features/preferences/prefsStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { usePluginHost } from "@/plugins/host";
import { CloseIcon, InfoIcon, PaletteIcon, PlugIcon, SearchIcon, SlidersIcon } from "@/ui/icons";
import { Segmented, SettingRow, Toggle } from "./controls";
import { useSettingsModal } from "./settingsStore";

interface Section {
  id: string;
  group: "Preferences" | "Services" | "Application";
  title: string;
  description?: string;
  icon: ReactNode;
  keywords: string[];
  render: () => ReactNode;
}

function PlaybackSection() {
  const prefs = usePrefs();
  return (
    <>
      <SettingRow title="Double-click on a song" description="What happens when you double-click a song in a list.">
        <Segmented
          label="Double-click on a song"
          value={prefs.doubleClick}
          onChange={(v) => prefs.set("doubleClick", v)}
          options={[
            { value: "play", label: "Play now" },
            { value: "queue", label: "Add to queue" },
          ]}
        />
      </SettingRow>
      <SettingRow title="On start-up" description="Pick up your last queue where you left off, or start fresh.">
        <Segmented
          label="On start-up"
          value={prefs.startup}
          onChange={(v) => prefs.set("startup", v)}
          options={[
            { value: "resume", label: "Resume last queue" },
            { value: "empty", label: "Start empty" },
          ]}
        />
      </SettingRow>
      <SettingRow
        title="Pause on device change"
        description="Pause when the audio output changes, e.g. when you unplug headphones."
      >
        <Toggle
          label="Pause on device change"
          on={prefs.pauseOnDeviceChange}
          onChange={(v) => prefs.set("pauseOnDeviceChange", v)}
        />
      </SettingRow>
    </>
  );
}

function AppearanceSection() {
  const prefs = usePrefs();
  return (
    <>
      <SettingRow title="Accent colour" description="Used for buttons, progress and highlights.">
        <div className="swatches" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={prefs.accent === a.id}
              aria-label={a.label}
              data-tip={a.label}
              className={`swatch${prefs.accent === a.id ? " on" : ""}${a.id === "artwork" ? " artwork" : ""}`}
              style={{ background: `linear-gradient(135deg, ${a.from}, ${a.to})` }}
              onClick={() => prefs.set("accent", a.id)}
            />
          ))}
        </div>
      </SettingRow>
      <SettingRow title="Ambient background" description="Tint the app with colours from the artwork that's playing.">
        <Toggle
          label="Ambient background"
          on={prefs.ambientBackground}
          onChange={(v) => prefs.set("ambientBackground", v)}
        />
      </SettingRow>
      <SettingRow title="Reduce motion" description="Turn off animations and transitions.">
        <Toggle label="Reduce motion" on={prefs.reduceMotion} onChange={(v) => prefs.set("reduceMotion", v)} />
      </SettingRow>
    </>
  );
}

function PluginsSection() {
  const plugins = usePluginHost((s) => s.plugins);
  const setEnabled = usePluginHost((s) => s.setEnabled);
  return (
    <>
      {plugins.map(({ plugin, enabled }) => {
        const m = plugin.manifest;
        return (
          <div className="plugin-card" key={m.id}>
            <div className="pic">
              <PlugIcon size={20} />
            </div>
            <div className="pbody">
              <div className="pname">
                {m.name}
                <span className="muted small">v{m.version}</span>
                {m.builtin && <span className="badge builtin">Built-in</span>}
              </div>
              {m.description && <p className="muted small">{m.description}</p>}
              {m.capabilities.length > 0 && (
                <div className="caps">
                  {m.capabilities.map((c) => (
                    <span className="cap" key={c}>
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <Toggle label={`Enable ${m.name}`} on={enabled} onChange={(v) => void setEnabled(m.id, v)} />
          </div>
        );
      })}
      <p className="muted small section-note">
        Enabling a plugin grants it the capabilities listed. See docs/PLUGINS.md to write your own.
      </p>
    </>
  );
}

function AboutSection() {
  const startSetup = useOnboarding((s) => s.start);
  const close = useSettingsModal((s) => s.close);
  const clearHistory = useHistory((s) => s.clear);
  const playCount = useHistory((s) => s.plays.length);
  return (
    <>
      <SettingRow title="Unnamed Music App" description="Self-hostable, plugin-first music player. Version 0.1.0.">
        <span />
      </SettingRow>
      <SettingRow title="Setup wizard" description="Walk through connecting your server and services again.">
        <button
          className="btn"
          onClick={() => {
            close();
            startSetup();
          }}
        >
          Run setup
        </button>
      </SettingRow>
      <SettingRow
        title="Listening history"
        description={`${playCount} plays stored on this computer. Clearing doesn't touch your server.`}
      >
        <button className="btn ghost" onClick={clearHistory} disabled={playCount === 0}>
          Clear
        </button>
      </SettingRow>
      <div className="shortcuts">
        <div className="setting-title">Keyboard shortcuts</div>
        <dl>
          <dt>Space</dt>
          <dd>Play / pause</dd>
          <dt>Ctrl + → / ←</dt>
          <dd>Next / previous track</dd>
          <dt>Ctrl + ↑ / ↓</dt>
          <dd>Volume up / down</dd>
          <dt>Esc</dt>
          <dd>Close this window</dd>
        </dl>
      </div>
    </>
  );
}

function AccountFooter({ onOpenServer }: { onOpenServer: () => void }) {
  const user = useServer((s) => s.user);
  const status = useServer((s) => s.status);
  const logout = useServer((s) => s.logout);
  if (!user) {
    return (
      <button className="account account-empty" onClick={onOpenServer}>
        <span className="avatar">?</span>
        <span className="account-names">
          <span className="strong">Not signed in</span>
          <span className="muted small">Connect your server</span>
        </span>
      </button>
    );
  }
  const name = user.displayName ?? user.username;
  return (
    <div className="account">
      <span className={`avatar${status === "online" ? " online" : ""}`}>{name[0]?.toUpperCase()}</span>
      <span className="account-names">
        <span className="strong">{name}</span>
        <span className="muted small">@{user.username}</span>
      </span>
      <button className="icon-btn" onClick={() => void logout()} aria-label="Sign out" data-tip="Sign out">
        ⎋
      </button>
    </div>
  );
}

export function SettingsModal() {
  const { open, section, close, select } = useSettingsModal();
  const panels = usePluginHost((s) => s.contributions.settings);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const sections: Section[] = useMemo(
    () => [
      {
        id: "playback",
        group: "Preferences",
        title: "Playback",
        description: "Queue behaviour, clicks and audio output.",
        icon: <SlidersIcon size={19} />,
        keywords: ["queue", "double-click", "resume", "startup", "device", "headphones", "pause"],
        render: () => <PlaybackSection />,
      },
      {
        id: "appearance",
        group: "Preferences",
        title: "Appearance",
        description: "Colours, background and motion.",
        icon: <PaletteIcon size={19} />,
        keywords: ["accent", "colour", "color", "theme", "background", "ambient", "motion", "animation"],
        render: () => <AppearanceSection />,
      },
      ...panels.map<Section>((p) => ({
        id: p.id,
        group: "Services",
        title: p.title,
        description: p.description,
        icon: p.icon ?? <PlugIcon size={19} />,
        keywords: p.keywords ?? [],
        render: p.render,
      })),
      {
        id: "plugins",
        group: "Application",
        title: "Plugins",
        description: "Turn plugins on and off and see what they can access.",
        icon: <PlugIcon size={19} />,
        keywords: ["extensions", "capabilities", "permissions"],
        render: () => <PluginsSection />,
      },
      {
        id: "about",
        group: "Application",
        title: "About",
        description: "Version, setup and shortcuts.",
        icon: <InfoIcon size={19} />,
        keywords: ["version", "setup", "wizard", "shortcuts", "keyboard", "history", "clear"],
        render: () => <AboutSection />,
      },
    ],
    [panels],
  );

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const visible = q
    ? sections.filter((s) => [s.title, s.description ?? "", ...s.keywords].some((t) => t.toLowerCase().includes(q)))
    : sections;
  const active = visible.find((s) => s.id === section) ?? visible[0] ?? sections[0];
  const groups = (["Preferences", "Services", "Application"] as const)
    .map((g) => ({ name: g, items: visible.filter((s) => s.group === g) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <aside className="settings-nav">
          <label className="settings-search">
            <SearchIcon size={16} />
            <input
              placeholder="Search settings…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search settings"
            />
          </label>
          <div className="settings-groups">
            {groups.map((g) => (
              <div key={g.name} className="settings-group">
                <div className="settings-group-label">{g.name}</div>
                {g.items.map((s) => (
                  <button
                    key={s.id}
                    className={`settings-link${s.id === active.id ? " active" : ""}`}
                    onClick={() => select(s.id)}
                  >
                    {s.icon}
                    {s.title}
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && <p className="empty">No settings match “{query}”.</p>}
          </div>
          <AccountFooter onOpenServer={() => select("server")} />
        </aside>
        <section className="settings-pane">
          <header className="settings-head">
            <div>
              <h1 id="settings-title">{active.title}</h1>
              {active.description && <p className="muted">{active.description}</p>}
            </div>
            <button className="icon-btn" onClick={close} aria-label="Close settings">
              <CloseIcon />
            </button>
          </header>
          <div className="settings-body" key={active.id}>
            {active.render()}
          </div>
        </section>
      </div>
    </div>
  );
}
