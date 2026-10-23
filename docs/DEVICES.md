# Playing on other devices

Cadence can send playback to speakers and TVs on your network and let one Cadence player control another.
Browsers and phones cannot search the local network, so the searching and the talking to devices is done by
your **Cadence server**. Each feature is two small plugins that work together:

| Feature | Server plugin (admin turns on, then restart) | App plugin (each person turns on in Settings > Plugins) |
| --- | --- | --- |
| "Play on..." page | none | `cadence.output-picker` |
| Control another Cadence player | `cadence.remote-control` | `cadence.remote-control` |
| DLNA / UPnP speakers and TVs, Sonos | `cadence.dlna` | `cadence.dlna` |
| Chromecast | `cadence.chromecast` | `cadence.chromecast` |
| Snapcast | `cadence.snapcast` | `cadence.snapcast` |
| Home Assistant | `cadence.home-assistant` | `cadence.home-assistant` |
| AirPlay | not available | `cadence.airplay` (explains why) |

Devices appear under **Play on** (a page in the sidebar, also the command "Play on...").

## The network, which is the part that goes wrong

The server must be able to **find** the device and the device must be able to **fetch music from the server**.

* **Docker.** A container on the default bridge network does not receive multicast (SSDP for DLNA and Sonos, mDNS for
  Chromecast), so automatic discovery finds nothing. Either run the server with `network_mode: host` (Linux hosts), or
  skip discovery and **add the device by address** (Settings > the device plugin > Add by address). Adding by address
  works from a bridge network as long as the server can reach the device's IP.
* **The address the device uses.** The server hands the device a link like `http://<address>/api/stream/...?exp=...&sig=...`.
  By default `<address>` is the one you opened Cadence with; if that is `localhost`, the machine's LAN address is
  used instead. The deploy compose file binds the server to `127.0.0.1`, which a speaker cannot reach. Either bind it to
  your LAN (`ports: "192.168.1.10:8787:8787"`, no TLS) or set **Server address for devices** in the DLNA/Chromecast
  settings (an admin sets it, for example `http://192.168.1.10:8787`).
* **Reverse proxy with HTTPS.** Most speakers reject self-signed certificates and some cannot do TLS at all. Give them a
  plain `http://` LAN address through the setting above.
* **Links are short-lived.** Each link is signed and expires after 45 minutes, and only covers one track.

With `network_mode: host` the compose service looks like:

```yaml
services:
  server:
    network_mode: host      # remove the "ports:" section; the server listens on PORT directly
    environment:
      HOST: 0.0.0.0
      PORT: "8787"
```

## What can be played

Only tracks the server can serve by URL: **your Cadence library and Jellyfin**. Spotify, Apple Music and local files
cannot be fetched by a speaker (and their terms do not allow it), so when such a track comes up the app plays it on this
device and says so; the next library track goes back to the speaker.

## How the output works

Choosing a device sends the current track and position to it. This device keeps running silently as the clock (it is
muted, and stays muted if you move the volume slider) so the queue, shuffle and "next track" work as before. Play, pause,
seek, skip and volume are forwarded to the device. Every few seconds the app also asks the device what it is doing: if you
pause on the speaker itself, the app pauses too; if it stops answering three times in a row the app plays on this device
again. Choosing **This device** stops the speaker.

Limits: gapless playback is not available (a short gap between tracks), "repeat one" does not restart on the speaker, and
only one output is active at a time.

## Remote control (Cadence to Cadence)

Every open player (a browser tab, the desktop app, the Android app) registers with the server under your account with
a name you can change on the **Remote** page. The Remote page lists your other players and shows what each is playing; tap one to
play/pause, skip, seek, change volume and jump in its queue. **Play my queue there** hands your queue and position over
(and **Play on > Other Cadence devices** does the same). Choosing **This device** brings the queue back at the other
player's position.

* Devices are per account: nobody else can see or command your players.
* Messages travel over a server-sent-events stream with automatic reconnecting, so a phone that sleeps comes back by itself.
* A browser only lets a page start sound after you have interacted with it once, so a tab you never touched may not start
  playing when told to. The desktop app and an installed Android app are not affected.

## DLNA and Sonos

The server sends an SSDP search and controls whatever answers as a UPnP MediaRenderer (SetAVTransportURI, Play, Pause,
Seek, SetVolume). **Sonos** speakers are UPnP devices and are labelled "Sonos" when detected (by manufacturer, model or
`RINCON_` id). To add one by hand, enter the speaker's IP (Sonos is tried on port 1400); for other devices enter the full
description URL, usually `http://<ip>:<port>/description.xml`. Notes: a Sonos speaker that is part of a group only accepts
commands on the group's coordinator; pick that one.

## Chromecast

The server talks Google Cast (CASTV2) directly: a TLS connection to port 8009, launching the Default Media Receiver and
loading the stream link. It is implemented in the server without a third-party dependency (the protocol only needs one
small protobuf message). Discovery uses mDNS (`_googlecast._tcp`), or add the IP by hand. Chromecast accepts MP3, AAC,
FLAC, WAV and Ogg; a file in another format is refused with a clear message.

## Snapcast

The Snapcast page controls an existing Snapcast server: groups, clients, per-client volume and mute, group mute and the
stream a group plays. An admin enters the server address (host or `host:1705`, or `http://host:1780`). Cadence does **not**
play into Snapcast; point a Snapcast stream at your music source yourself. Anyone signed in to your Cadence server can use
the page.

## AirPlay

Not available. See the note in Settings > AirPlay (not available). It is a closed protocol that needs Apple's own pairing
and encryption for current devices; a half-working version would drop out mid-song, so Cadence does not pretend. Use the
Mac or iOS system AirPlay output, or a separate bridge that shows AirPlay speakers as UPnP devices.

## Home Assistant

See [HOME_ASSISTANT.md](HOME_ASSISTANT.md).

## Security notes

* Only an admin can add devices by address, and addresses must be `http(s)` (no credentials, no link-local metadata
  addresses). A device description may not point its control URL at a different machine.
* Command tokens for Home Assistant are separate from login sessions, stored only as a hash, limited to one account's
  players and rate limited. Home Assistant tokens are stored encrypted with the server secret.
* The error messages shown in the app are short phrases; device addresses and stack traces stay in the server log.
