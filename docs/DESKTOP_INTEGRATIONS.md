# Desktop integrations

Five opt-in plugins connect the Cadence desktop app to other things on your computer. They exist only in the
desktop app: the web player and the Android and iOS apps do not load them, list them or show any settings for them.
Turn each on in **Settings > Plugins**; each adds its own page under **Settings > Services**.

| Plugin | What it does |
| --- | --- |
| `cadence.discord-presence` | Shows the current song on your Discord profile (Rich Presence). |
| `cadence.media-keys` | System media controls and global keyboard shortcuts you can rebind. |
| `cadence.obs-overlay` | A see-through now-playing overlay for OBS, served by your Cadence server. |
| `cadence.control-api` | A local HTTP and WebSocket API for Stream Deck and scripts, plus MIDI mapping. |
| `cadence.status-sync` | Sets your Slack status from what is playing, and clears it when you pause or quit. |

How it is built: the plugins run in the app window like any other plugin. Anything that needs the operating system
(Discord's pipe, global shortcuts, a listening socket, the Slack call) is done by the Electron main process behind the
`window.host.integrations` bridge (`apps/desktop/electron/integrations.ts`). Every bridge call is validated again in the
main process, and calls that do not come from the app's own window are refused. Nothing starts until its plugin asks.

## Discord Rich Presence

1. Open `discord.com/developers/applications`, choose **New Application** and name it (friends see "Listening to *name*").
2. Copy the **Application ID** from **General Information** and paste it into **Settings > Discord**.
3. Keep the Discord desktop app running, with **Settings > Activity Privacy > Share my activity** on.

Cadence talks to Discord's local IPC (a named pipe `\\?\pipe\discord-ipc-N` on Windows, a unix socket elsewhere) using the
small framed-JSON protocol directly, so there is no dependency. It reconnects with backoff (2 s doubling to 60 s) if Discord is
closed or restarts, and stops retrying only for an invalid application ID. Shared: title, artists, album, elapsed time and
the cover link. The cover is sent only when it is a public `https` address (never `localhost`, private networks or
tracks served only to you). **Private mode** removes everything at once; you can also hide the cover, the album, or the
activity while paused.

## Media keys and shortcuts

- **System media controls** switches on Chromium's media integration (Windows media overlay, macOS Now Playing, Linux
  MPRIS). It can only be set at launch, so it applies after a restart (the panel has a Restart button). The player already
  publishes the track to the system; this plugin adds seeking and the timeline.
- **Global shortcuts** work while Cadence is in the background. The plugin registers play or pause, next, previous, volume
  up and down, and like (`Ctrl+Alt+Space / Right / Left / Up / Down / L` by default). Every command from any plugin appears in the
  list; click a shortcut and press new keys (Escape cancels, Backspace removes). Commands added by other plugins only
  *suggest* a shortcut: it is offered with a **Use suggestion** button and never switched on without you.
- Conflicts: two commands on the same keys are marked and the first keeps them. Shortcuts without Ctrl, Alt or Cmd are refused
  (except media keys and F1 to F24) so typing is never stolen. If another program owns a combination, the panel says so.
- If you also turn on System media controls, do not bind the dedicated media keys here; both would fire.

## OBS now-playing overlay

This needs one small server plugin, **Now playing overlay** (`cadence.now-playing`). An admin enables it once and
restarts the server; it is off by default like every community server plugin.

1. In **Settings > OBS overlay** (signed in to your server) pick a look and press **Create link**.
2. In OBS: Sources **+** > **Browser**, paste the link into URL, width 600 and height 160.
3. Play something. The overlay updates live and hides when nothing is playing.

The desktop app sends a heartbeat (`POST /api/now-playing`) when playback changes and every 15 seconds while playing. The
server keeps only the latest one per person in memory, never in the database. A link is
`/overlay/<token>`: a random 32-character secret stored hashed, shown once when created, revocable at any time (revoking also
closes open overlays), at most 10 per person. The page is self-contained, transparent, updates over Server-Sent Events with a
polling fallback, and is served with a strict Content-Security-Policy and no referrer. Options in the address: `theme=calm|light|minimal|bar`,
`art=0`, `progress=0`, `align=right`, `scale=0.5..3`.

## Control API (Stream Deck, scripts, MIDI)

While the plugin is on, the app listens on `127.0.0.1:47321` (change the port in settings). It is never reachable from other
machines. Every request needs the secret token shown in settings (**Show**, **Copy**, **New token**), as
`Authorization: Bearer TOKEN` or `?token=TOKEN`. Requests from web pages (an `Origin` header) or under another host name are
refused, and repeated wrong tokens are rate limited.

```
GET  /v1/state                    what is playing
GET  /v1/commands                 command names
GET|POST /v1/command/<name>       run a command; arguments in ?query or a JSON body
WS   /v1/ws?token=TOKEN           live state; send {"id":1,"command":"next","args":{}}
```

Commands: `play`, `pause`, `play-pause`, `next`, `previous`, `volume-up`, `volume-down`, `volume` (`value` 0 to 1, or 0 to 100),
`seek` (`seconds`), `like`, `unlike`, `toggle-like`. Commands from other plugins are reachable by id only if you turn on
**Other plugins' commands** (off by default).

```
curl -X POST -H "Authorization: Bearer TOKEN" http://127.0.0.1:47321/v1/command/next
curl "http://127.0.0.1:47321/v1/command/volume?value=0.4&token=TOKEN"
```

**Stream Deck:** the built-in Stream Deck actions cannot send an HTTP request by themselves, so install a Stream Deck plugin
that can (search the Stream Deck store for "HTTP" or "API"), add its request action to a key, choose `POST` (or `GET`) and paste
`http://127.0.0.1:47321/v1/command/play-pause?token=TOKEN`. Repeat per key with another command name. Bitfocus Companion and any
tool that can make HTTP requests work the same way.

**MIDI:** turn on **MIDI controllers**, pick a command, press **Learn** and press a pad or move a control. Notes fire a
command; a controller used as a button fires once as it passes halfway; a controller mapped to `volume` acts as a fader.
This uses the Web MIDI API in the app window (no SysEx).

## Slack status

1. Create a Slack app at `api.slack.com/apps` (from scratch), add the **User Token Scope** `users.profile:write`, install it
   to your workspace and copy the **User OAuth Token** (`xoxp-...`).
2. Paste it into **Settings > Slack status**, press Save (it runs `auth.test`), then turn on **Show my song in Slack**.

The token is stored encrypted by the operating system (Electron `safeStorage`) and is only used by the main process to call
Slack's official `users.profile.set`. Each status carries an expiry shortly after the song should end, so it clears by itself
even after a crash; it is also cleared on pause (optional), when you turn the plugin off, and when the app quits.
**Keep the song private** shares only "Listening to music".

**Microsoft Teams is not included.** Microsoft's official route is the Graph presence API, which needs an Azure app registration, a
sign-in flow and admin consent, and setting a custom status message is still only in its beta API. There is no
straightforward supported way, so it is left out.

## Not verified on a real desktop

Unit and integration tests cover the Discord framing and reconnect logic (including a real named pipe), accelerator
parsing and conflicts, the control server (HTTP and WebSocket, over real sockets), token auth, command routing, Slack
requests (mocked fetch), and the main-process wiring (against a stand-in for Electron). These need a real installed app to
confirm: that Windows, macOS or Linux shows the media overlay after the restart, that global shortcuts register on your
keyboard, a live Discord client showing the presence, a live Slack workspace accepting the status, and Web MIDI with real hardware.