# Plugins

Almost everything in Unnamed Music App is a plugin. This document describes the
plugin model as it stands in v1 (built-in and sample plugins loaded in-process).
Signed, installable third-party packages build on this same contract.

## The model

A plugin is an object with a **manifest** and an `activate(ctx)` function
(`src/plugins/types.ts`):

```ts
const myPlugin: Plugin = {
  manifest: {
    id: "me.my-plugin",          // reverse-DNS, unique
    name: "My Plugin",
    version: "1.0.0",
    capabilities: ["ui.sidebar", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: "mine", label: "Mine", render: () => <MyPage /> });
  },
};
```

The manifest declares, up front, the **capabilities** the plugin needs. The host
shows these to the user and only grants what was declared. On activation the
plugin gets a **context** (`PluginContext`) whose methods are gated by those
capabilities — calling one you didn't request throws, so the manifest stays the
single source of truth about what a plugin can do.

## Capabilities

| Capability          | Lets the plugin…                               |
| ------------------- | ---------------------------------------------- |
| `player.read`       | observe now-playing / position                 |
| `player.control`    | start/pause/skip playback                      |
| `source.audio`      | resolve a track to a playable stream           |
| `source.library`    | import a library/playlists from a service      |
| `provider.lyrics`   | supply lyrics                                   |
| `provider.metadata` | supply artwork/metadata                        |
| `ui.sidebar`        | add a navigation entry + page                  |
| `ui.home.widget`    | add a widget to Home                           |
| `ui.settings`       | add a settings panel                           |
| `storage`           | read/write a small private key-value store     |
| `network.outbound`  | make outbound HTTP requests                    |

## Contribution points

- **Sidebar pages** — `ctx.registerSidebarItem(...)`
- **Home widgets** — `ctx.registerHomeWidget(...)`
- **Settings panels** — `ctx.registerSettingsPanel(...)`
- **Audio sources** — `ctx.registerAudioSource({ resolve })`; the player tries each
  enabled source until one returns a URL.
- **Library sources** — `ctx.registerLibrarySource({ connect })` for service
  connectors (this is where Spotify / Apple Music library import will live).
- **Now-playing observers** — `ctx.onNowPlaying(cb)` for scrobblers, presence, etc.

## Built-in vs sample plugins

- `builtin: true` plugins ship with the app, are trusted, and enable
  automatically (e.g. `core.welcome`, `core.now-playing-log`).
- Sample plugins start **disabled** and demonstrate the consent flow — e.g.
  `obsoletelabs.tracking-bridge`, a stub that shows where a bridge to a
  self-hosted Unnamed Tracking App instance would live.

## Planned: signed packages

Third-party plugins will install from signed packages (manifest + UI + backend +
sandboxed frontend), with a permission review on install and publisher signatures
— the same shape used by the obsoletelabs tracking-app plugin ecosystem. The
in-process contract above is the stable core those packages target.
