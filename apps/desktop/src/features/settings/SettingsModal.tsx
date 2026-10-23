import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DjSettings } from "@/features/dj/DjSettings";
import { useHistory } from "@/features/history/historyStore";
import { useOnboarding } from "@/features/onboarding/onboardingStore";
import { ACCENTS, usePrefs } from "@/features/preferences/prefsStore";
import { readScale, setScale } from "@/app/uiScale";
import { isWeb } from "@/platform/webHost";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { usePluginHost } from "@/plugins/host";
import {
  BackIcon,
  CloseIcon,
  DiscIcon,
  ForwardIcon,
  HomeIcon,
  InfoIcon,
  NoteIcon,
  PaletteIcon,
  PlugIcon,
  QueueIcon,
  SearchIcon,
  ServerIcon,
  SlidersIcon,
  SparkleIcon,
  WavesIcon,
} from "@/ui/icons";
import { Segmented, SettingRow, Toggle } from "./controls";
import type { PluginManifest } from "@/plugins/types";
import { capabilityLabel, groupPlugins, type PluginFilter, type PluginGroup } from "./pluginGroups";
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

const SIZE_LABELS: [number, string][] = [
  [0.8, "Smaller"],
  [0.9, "Small"],
  [1, "Default"],
  [1.1, "Large"],
  [1.25, "Larger"],
  [1.5, "Largest"],
];

/** Desktop only: scales the whole interface (also Ctrl+= / Ctrl+- / Ctrl+0). */
function InterfaceSizeRow() {
  const [size, setSize] = useState(readScale);
  useEffect(() => {
    const on = (e: Event) => setSize((e as CustomEvent<number>).detail);
    window.addEventListener("ui-scale", on);
    return () => window.removeEventListener("ui-scale", on);
  }, []);
  if (!window.host?.ui || isWeb()) return null;
  return (
    <SettingRow title="Interface size" description="Make everything bigger or smaller. Shortcuts: Ctrl + plus, Ctrl + minus, Ctrl + 0.">
      <div className="segmented" role="radiogroup" aria-label="Interface size">
        {SIZE_LABELS.map(([value, label]) => (
          <button key={value} role="radio" aria-checked={size === value} className={size === value ? "on" : ""} onClick={() => setScale(value)}>
            {label}
          </button>
        ))}
      </div>
    </SettingRow>
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
      <InterfaceSizeRow />
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

const GROUP_ICONS: Record<PluginGroup, ReactNode> = {
  Sources: <DiscIcon size={20} />,
  Sound: <WavesIcon size={20} />,
  "Lyrics & info": <NoteIcon size={20} />,
  "Playback & queue": <QueueIcon size={20} />,
  "Devices & remotes": <ServerIcon size={20} />,
  "Home & pages": <HomeIcon size={20} />,
  Other: <PlugIcon size={20} />,
};

/** Compact row: icon, name, one-line description (tap to read more), switch. */
function PluginCard({
  manifest: m,
  enabled,
  icon,
  onToggle,
}: {
  manifest: PluginManifest;
  enabled: boolean;
  icon: ReactNode;
  onToggle: (on: boolean) => void;
}) {
  const [more, setMore] = useState(false);
  return (
    <div className={`plugin-card${enabled ? " on" : ""}${more ? " expanded" : ""}`}>
      <div className="pic" aria-hidden>
        {icon}
      </div>
      <div className="pbody">
        <div className="pname">
          <span className="ptitle">{m.name}</span>
          {m.builtin && <span className="badge builtin">Built-in</span>}
        </div>
        {m.description && (
          <button className="pdesc muted small" aria-expanded={more} onClick={() => setMore(!more)}>
            <span className="pdesc-text">{m.description}</span>
          </button>
        )}
        {more && (
          <div className="pmore">
            <span className="muted small">
              Version {m.version}
              {m.author ? ` · ${m.author}` : ""}
            </span>
            {m.capabilities.length > 0 && (
              <details className="paccess">
                <summary>What it can access</summary>
                <ul>
                  {m.capabilities.map((c) => (
                    <li key={c} title={c}>
                      {capabilityLabel(c)} <code className="muted">{c}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
      <Toggle label={`Enable ${m.name}`} on={enabled} onChange={onToggle} />
    </div>
  );
}

function PluginsSection() {
  const plugins = usePluginHost((s) => s.plugins);
  const setEnabled = usePluginHost((s) => s.setEnabled);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const rows = useMemo(() => plugins.map(({ plugin, enabled }) => ({ manifest: plugin.manifest, enabled })), [plugins]);
  const groups = useMemo(() => groupPlugins(rows, query, filter), [rows, query, filter]);
  const onCount = rows.filter((r) => r.enabled).length;
  return (
    <>
      <div className="plugin-tools">
        <label className="plugin-search">
          <SearchIcon size={16} />
          <input
            type="search"
            placeholder={`Search ${rows.length} plugins`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search plugins"
          />
        </label>
        <Segmented
          label="Show plugins"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "on", label: `On (${onCount})` },
            { value: "off", label: "Off" },
          ]}
        />
      </div>
      {groups.length === 0 && <p className="muted small section-note">No plugins match.</p>}
      {groups.map(({ group, rows: list }) => (
        <div className="plugin-group" key={group}>
          <h4 className="plugin-group-title">
            {group} <span className="muted small">{list.length}</span>
          </h4>
          {list.map(({ manifest: m, enabled }) => (
            <PluginCard
              key={m.id}
              manifest={m}
              enabled={enabled}
              icon={GROUP_ICONS[group]}
              onToggle={(v) => void setEnabled(m.id, v)}
            />
          ))}
        </div>
      ))}
      <p className="muted small section-note">
        Turning a plugin on lets it do what is listed under "What it can access". See docs/PLUGINS.md to write your own.
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
      <SettingRow title="Cadence" description="Self-hostable, plugin-first music player. Version 0.1.0.">
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

const PHONE_QUERY = "(max-width: 760px)";

/** True at phone width (the same breakpoint the stylesheet uses). */
function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

export function SettingsModal() {
  const { open, section, deep, close, select } = useSettingsModal();
  const panels = usePluginHost((s) => s.contributions.settings);
  const [query, setQuery] = useState("");
  const phone = usePhoneLayout();
  // Phones show the list of sections first and open one section full-screen.
  const [paneOpen, setPaneOpen] = useState(deep);
  useEffect(() => {
    if (open) setPaneOpen(deep);
  }, [open, deep]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (phone && paneOpen) setPaneOpen(false);
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, phone, paneOpen]);

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
      {
        id: "dj",
        group: "Services",
        title: "AI DJ",
        description: "Your personal DJ. Choose whether its model runs on the server, this device or another computer.",
        icon: <SparkleIcon size={19} />,
        keywords: ["dj", "ai", "ollama", "llm", "model", "voice", "intros", "speech"],
        render: () => <DjSettings />,
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
      <div className={`settings ${paneOpen ? "phone-pane" : "phone-list"}`} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <aside className="settings-nav">
          <header className="settings-list-head">
            <h1>Settings</h1>
            <button className="icon-btn" onClick={close} aria-label="Close settings">
              <CloseIcon />
            </button>
          </header>
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
                    onClick={() => {
                      select(s.id);
                      setPaneOpen(true);
                    }}
                  >
                    {s.icon}
                    <span className="settings-link-text">{s.title}</span>
                    <span className="settings-chevron" aria-hidden>
                      <ForwardIcon size={16} />
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && <p className="empty">No settings match “{query}”.</p>}
          </div>
          <AccountFooter
            onOpenServer={() => {
              select("server");
              setPaneOpen(true);
            }}
          />
        </aside>
        <section className="settings-pane">
          <header className="settings-head">
            <button className="icon-btn settings-back" onClick={() => setPaneOpen(false)} aria-label="All settings">
              <BackIcon />
            </button>
            <div className="settings-head-text">
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
