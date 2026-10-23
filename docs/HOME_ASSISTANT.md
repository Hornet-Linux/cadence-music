# Home Assistant

Two independent directions, both through your Cadence server (no custom Home Assistant integration to install):

1. **Cadence tells Home Assistant what is playing.** The server calls Home Assistant's official REST API
   (`POST /api/states/<entity_id>`) with a long-lived access token you provide.
2. **Home Assistant controls Cadence.** Home Assistant calls a Cadence endpoint with a per-user command token
   (`rest_command` or an automation), and the command is relayed to the player you are listening on.

Both rely on the **Remote control** plugin (server and app): the server learns what is playing, and reaches your
players, through the same relay that powers the Remote page. Turn on `cadence.remote-control` and
`cadence.home-assistant` in the admin settings (restart the server), then turn on the Home Assistant plugin in the app
(Settings > Plugins) and open Settings > Home Assistant.

## 1. Now-playing in Home Assistant

1. In Home Assistant open your profile (bottom left), Security, **Long-lived access tokens**, create one and copy it.
2. In Cadence, Settings > Home Assistant: enter the address of Home Assistant (`http://homeassistant.local:8123`), paste the
   token, choose the entity (default `media_player.cadence_<your username>`), Save, then **Test connection**.
   The token is stored encrypted on your server and is never shown again.

Cadence updates the entity when the track, play/pause state or volume changes, when you seek, and at least once a minute
while playing. It uses `state` of `playing`, `paused`, `idle` (a player is open, nothing loaded) or `off` (no player
open) and these attributes: `media_title`, `media_artist`, `media_album_name`, `media_duration`, `media_position`,
`media_position_updated_at`, `volume_level`, `entity_picture` (when the track has artwork), `source` (the player's
name) and `friendly_name`.

This is a plain state object, not a full media player integration: dashboards and automations can read it (a media
control card shows the title, artist and artwork), but you cannot call `media_player.*` services on it. Use the commands
below for that. States set over the REST API are not stored by Home Assistant; after a restart the entity is empty until
Cadence next pushes (the next play, pause or track change).

If Home Assistant is unreachable Cadence tries again no more than once a minute and shows nothing to you but a line in the
server log.

## 2. Commands from Home Assistant

In Settings > Home Assistant choose **Create command token**. Copy it immediately; only a hash is kept. A new token
replaces the old one, and **Revoke** turns commands off.

The endpoint is `POST https://<your server>/api/home-assistant/command` with the header
`Authorization: Bearer <command token>` and a JSON body:

| Body | Effect |
| --- | --- |
| `{"command":"play"}` / `"pause"` / `"toggle"` | start, stop, flip |
| `{"command":"next"}` / `"previous"` | skip |
| `{"command":"seek","position":90}` | jump to 90 seconds |
| `{"command":"volume_set","volume_level":0.4}` | volume from 0 to 1 |
| `{"command":"volume_up"}` / `"volume_down"` | change by 0.1 (`"step"` to override) |
| add `"device":"Kitchen laptop"` | pick a player by name or id; default is the one that is playing, else the most recently active |

Names from Home Assistant services work too (`media_play`, `media_pause`, `media_next_track`, ...). Replies: `200`
`{"ok":true,"device":"..."}`; `401` bad token; `409` no player is open or that player is offline; `400` unknown command;
`429` too many wrong tokens (20 a minute per address); `503` the Remote control plugin is off.

### `configuration.yaml`

Put the whole header value in `secrets.yaml`:

```yaml
# secrets.yaml
cadence_authorization: "Bearer cadha_paste_your_token_here"
```

```yaml
# configuration.yaml
rest_command:
  cadence_pause:
    url: "https://cadence.example.com/api/home-assistant/command"
    method: POST
    headers:
      authorization: !secret cadence_authorization
    content_type: "application/json"
    payload: '{"command":"pause"}'
  cadence_play:
    url: "https://cadence.example.com/api/home-assistant/command"
    method: POST
    headers:
      authorization: !secret cadence_authorization
    content_type: "application/json"
    payload: '{"command":"play"}'
  cadence_next:
    url: "https://cadence.example.com/api/home-assistant/command"
    method: POST
    headers:
      authorization: !secret cadence_authorization
    content_type: "application/json"
    payload: '{"command":"next"}'
  cadence_volume:
    url: "https://cadence.example.com/api/home-assistant/command"
    method: POST
    headers:
      authorization: !secret cadence_authorization
    content_type: "application/json"
    payload: '{"command":"volume_set","volume_level":{{ level }}}'
```

Restart (or reload REST commands), then use them from scripts and automations:

```yaml
automation:
  - alias: "Pause Cadence when the doorbell rings"
    triggers:
      - trigger: state
        entity_id: binary_sensor.front_door_bell
        to: "on"
    actions:
      - action: rest_command.cadence_pause

  - alias: "Quiet Cadence at night"
    triggers:
      - trigger: time
        at: "22:00:00"
    actions:
      - action: rest_command.cadence_volume
        data:
          level: 0.2

  - alias: "Turn the hall light on while music plays"
    triggers:
      - trigger: state
        entity_id: media_player.cadence_alice
        to: "playing"
    actions:
      - action: light.turn_on
        target:
          entity_id: light.hall
```

(Older Home Assistant versions use `trigger:` / `action:` lists with `platform:` and `service:`; the REST commands are the same.)

### Reading the state by polling instead

If you prefer Home Assistant to pull, `GET /api/home-assistant/now-playing` with the same bearer token returns
`{"state":"playing","attributes":{...}}`:

```yaml
sensor:
  - platform: rest
    name: Cadence now playing
    resource: "https://cadence.example.com/api/home-assistant/now-playing"
    headers:
      authorization: !secret cadence_authorization
    value_template: "{{ value_json.state }}"
    json_attributes_path: "$.attributes"
    json_attributes:
      - media_title
      - media_artist
    scan_interval: 15
```

## Troubleshooting

* **Test connection says the token was rejected.** Create a new long-lived token; they cannot be shown again.
* **Test works but nothing updates.** The Remote control plugin must be on, and a player must be open: the state comes
  from your open players.
* **Commands answer 409 `no_player`.** No Cadence player is open for that account. A browser tab counts; so does the
  desktop and Android app.
* **Commands answer 200 but nothing plays.** Browsers only start sound after you have interacted with the page once; the
  desktop and Android apps do not have that limit.
* **Your server is not on the same network as Home Assistant.** The server calls Home Assistant, so it needs a route to it.
  Home Assistant calls the server, so it needs a route to the server's public address.
