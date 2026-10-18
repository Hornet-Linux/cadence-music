import { usePluginHost } from "@/plugins/host";
import type { Capability } from "@/plugins/types";

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      className={`switch${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      onClick={onClick}
    >
      <span className="knob" />
    </button>
  );
}

function capLabel(c: Capability): string {
  return c;
}

export function SettingsView() {
  const plugins = usePluginHost((s) => s.plugins);
  const settingsPanels = usePluginHost((s) => s.contributions.settings);
  const setEnabled = usePluginHost((s) => s.setEnabled);

  return (
    <div className="view">
      <header className="view-header">
        <h1>Settings</h1>
      </header>

      {settingsPanels.map((panel) => (
        <section className="section" key={panel.id}>
          <div className="section-head">
            <h2>{panel.title}</h2>
          </div>
          <div className="card pad">{panel.render()}</div>
        </section>
      ))}

      <section className="section">
        <div className="section-head">
          <h2>Plugins</h2>
          <span className="muted small">{plugins.length} installed</span>
        </div>
        <div className="card">
          {plugins.map(({ plugin, enabled }) => {
            const m = plugin.manifest;
            return (
              <div className="plugin-card" key={m.id}>
                <div className="pic" />
                <div className="pbody">
                  <div className="pname">
                    {m.name}
                    <span className="muted small">v{m.version}</span>
                    {m.builtin && <span className="badge builtin">Built-in</span>}
                  </div>
                  {m.description && (
                    <p className="muted small" style={{ marginTop: 4 }}>
                      {m.description}
                    </p>
                  )}
                  {m.capabilities.length > 0 && (
                    <div className="caps">
                      {m.capabilities.map((c) => (
                        <span className="cap" key={c}>
                          {capLabel(c)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <Switch
                  on={enabled}
                  onClick={() => void setEnabled(m.id, !enabled)}
                />
              </div>
            );
          })}
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>
          Enabling a plugin grants it the capabilities listed. Third-party plugins install from
          signed packages; see the plugin docs.
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>About</h2>
        </div>
        <div className="card pad">
          <p className="muted">
            Unnamed Music App — a self-hostable, plugin-first music player. Early development build.
          </p>
        </div>
      </section>
    </div>
  );
}
