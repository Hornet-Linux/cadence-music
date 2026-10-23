# Cadence on iPhone and iPad

The iOS app (`apps/ios`) is a small native shell around your server's web
player at `/app`: you enter your server's address once, sign in, and it keeps
playing in the background with lock-screen and Control Center controls.

It isn't on the App Store. You install it yourself ("sideload") with a free
Apple ID — no $99/year developer account needed.

## Install

1. Download **Cadence.ipa** from the
   [latest release](https://github.com/Hornet-Linux/cadence-music/releases/latest)
   (or from the `ios-ipa` artifact of the latest **iOS** workflow run).
2. Install it with one of:
   - **[Sideloadly](https://sideloadly.io)** (Windows/macOS): plug in your
     iPhone, drag in `Cadence.ipa`, enter your Apple ID, Start.
   - **[AltStore](https://altstore.io)**: install AltServer on your computer and
     AltStore on the phone, then open `Cadence.ipa` from AltStore's My Apps tab.
3. On the iPhone: **Settings → General → VPN & Device Management**, tap your
   Apple ID and **Trust** it. On iOS 16+ also turn on **Settings → Privacy &
   Security → Developer Mode** (the phone restarts).
4. Open Cadence and enter your server's address, e.g. `music.example.com`
   (or `http://192.168.1.20:8787` on your home network). Cadence checks that the
   address really is a Cadence server before it saves it, and tells you plainly if
   it can't be reached, isn't Cadence, or uses plain http over the internet.
   To switch servers later: **Settings → Server → Change server** in the app, or
   **Change server** on the "Cannot reach your server" screen. The last address is
   filled in for you.

The app shows your server's web player, so update the server to get the
latest player and its phone layout; the app itself rarely needs reinstalling.

## Permissions

Cadence asks for as little as possible, and only at the moment it matters:

- **Local network.** Only if your server is on your home network. iOS asks the
  first time Cadence connects to a private address; the address screen says so
  beforehand. Choose **Allow**, otherwise a server at home can't be reached (you
  can change it later in Settings → Privacy & Security → Local Network).
- **Notifications are not needed.** The lock screen and Control Center controls
  come from playback itself, so there is no notification prompt.

## Updates

Sideloaded apps can't update themselves. About once a day, a few seconds after
the player opens, Cadence looks at the latest GitHub release; if it is newer than
the installed version you get one gentle prompt per release with a link to it.
Offline, or on a development build, it stays quiet. To update, install the new
`Cadence.ipa` the same way as the first time (your sign-in is kept).

## Free Apple ID limits

- Apps signed with a free Apple ID **expire after 7 days**. Re-sign before
  then: AltStore refreshes automatically over Wi-Fi while AltServer runs;
  with Sideloadly, install the same IPA again. Your sign-in is kept.
- At most 3 sideloaded apps per device, and 10 app IDs per week.

## What works

- Your server's library, streamed with seeking, and background playback.
- Server sign-in, including single sign-on (OIDC).
- Lock screen and Control Center controls with artwork, from the player's own
  Media Session. If iOS pauses the music for a call, Siri or unplugged headphones,
  the player follows, so the lock screen play button works again.
- Swipe from the left edge to go back through pages you opened. There is no pull to
  refresh and no rubber-banding; the bottom tab bar sits above the home indicator,
  in portrait and landscape, on iPhone and iPad.
- If the web content process is ended by iOS (low memory) the page reloads by
  itself. If the server can't be reached you get a card with **Try again** and
  **Change server**, and Cadence retries when the network comes back.
- Apple Music via MusicKit, if enabled on your server.
- **Spotify playback doesn't work on iOS** — Spotify's Web Playback SDK isn't
  supported in iOS web views. Your Spotify library still shows up.

## Building it yourself

Needs a Mac with Xcode 16 and [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```bash
cd apps/ios
xcodegen generate
open Cadence.xcodeproj
```

To run on your phone straight from Xcode, pick your free Apple ID under
Signing & Capabilities (set `CODE_SIGNING_ALLOWED` back to `YES` locally) and
change the bundle ID to something unique. Without a Mac, push to GitHub —
the **iOS** workflow builds the IPA on a macOS runner and runs the unit tests on a simulator.

## Plain HTTP and links

Servers on a home network are often plain `http://`, and the address is typed in the
app, so App Transport Security allows HTTP. The player narrows it: plain HTTP only
reaches **your server and local-network addresses** (private and loopback IPs,
`.local`/`.lan`/`.home.arpa` names, single-label names like `nas`, and Tailscale's
100.64.0.0/10); any other `http://` load is blocked. Use `https://` for a server
reachable from outside your home.

A link you tap that leaves your server opens in Safari. Sign-in redirects (your
server's single sign-on, Spotify, Apple Music) stay in the app, because they need its
session.

## App icon

The icon is a full-bleed square (iOS rounds the corners itself) generated by
`node apps/ios/tools/make-icons.mjs`, together with the launch screen logo.
Edit the colours or shapes in that script and run it again.

## AI DJ on the phone

The AI DJ runs on your server, so it works on the iPhone with no setup if the
server owner added an AI provider. On **iOS 26 or later** with **Apple
Intelligence** available (iPhone 15 Pro or newer, turned on in Settings), the
app also offers Apple's on-device model as a provider: Settings → **AI DJ** →
**Apple Intelligence**. Nothing leaves the phone and no key is needed. The
on-device model is small, so its picks are simpler than a big server model's.

The unit tests (`apps/ios/CadenceTests`) include one real generation that runs
only on hardware with Apple Intelligence and is skipped everywhere else, so run
them from Xcode on a supported device to check it:

```bash
cd apps/ios && xcodegen generate
xcodebuild test -project Cadence.xcodeproj -scheme Cadence   -destination 'platform=iOS,name=<your iPhone>'
```
