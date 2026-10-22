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
4. Open Cadence and enter your server's address, e.g. `music.example.com`.
   To switch servers later: **Settings → Server → Change server** in the app.

The app shows your server's web player, so update the server to get the
latest player and its phone layout; the app itself rarely needs reinstalling.

## Free Apple ID limits

- Apps signed with a free Apple ID **expire after 7 days**. Re-sign before
  then: AltStore refreshes automatically over Wi-Fi while AltServer runs;
  with Sideloadly, install the same IPA again. Your sign-in is kept.
- At most 3 sideloaded apps per device, and 10 app IDs per week.

## What works

- Your server's library, streamed with seeking, and background playback.
- Server sign-in, including single sign-on (OIDC).
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
change the bundle ID to something unique. A full walkthrough is in the wiki:
[iOS App with Xcode](https://github.com/Hornet-Linux/cadence-music/wiki/iOS-App-with-Xcode). Without a Mac, push to GitHub —
the **iOS** workflow builds the IPA on a macOS runner.

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
