# Cadence on Android

The Android app (`apps/android`) is a small native shell around your server's web
player at `/app`, like the [iOS app](IOS.md): you enter your server's address once,
sign in, and it keeps playing with the screen off, with notification and lock-screen
controls. It is written in Kotlin with Jetpack Compose for the native screens and a
`WebView` for the player.

It isn't on Google Play. You install the APK yourself ("sideload"); no developer
account is needed.

## Install

1. On the phone, download **Cadence.apk** from the
   [latest release](https://github.com/Hornet-Linux/cadence-music/releases/latest)
   (or from the `android-apk` artifact of the latest **Android** workflow run).
2. Open it. Android asks to allow installs from your browser or file manager
   ("Install unknown apps"); allow it for that app only, then install.
   Play Protect may warn that the app is unrecognised: choose **Install anyway**.
3. Open Cadence and enter your server's address, e.g. `music.example.com`. A bare
   address means `https://`; for a server on your network without a certificate, type
   the scheme, e.g. `http://192.168.1.20:8787`.
4. Allow notifications when asked (Android 13+). Without that permission playback still
   works, but the notification and lock-screen controls don't appear.

To switch servers later: **Settings → Server → Change server** in the player (this needs
the web-side change described under [the native bridge](#the-native-bridge)); the failure
screen also offers **Change server**.

The app shows your server's web player, so update the server to get the latest player and
its phone layout; the app itself rarely needs reinstalling. Requires Android 8.0 (API 26)
or newer and a current Android System WebView (it's updated through Google Play).

## Updating, and the signing key

Android only installs an update over an existing app if **the same key signed both**.

- Releases are signed with a release key kept in the repository's GitHub secrets
  (below). Install each new `Cadence.apk` over the old one and your sign-in is kept.
- If the secrets aren't set (a fork, a pull request, the first run), the build is signed
  with the Android *debug* key instead, so it's still installable but it **can't update a
  build signed with a different key**: uninstall first. Builds from forks or PRs are
  therefore for testing, not for keeping.

### Creating the release key (once, by the maintainer)

No key is committed to the repository, and none should be. Generate one and add it as
repository secrets:

```bash
apps/android/scripts/generate-keystore.sh cadence-release.jks
```

The script needs `keytool` (any JDK) and prints the four values below, plus `gh secret set`
commands. Equivalent by hand:

```bash
keytool -genkeypair -keystore cadence-release.jks -storetype PKCS12 \
  -alias cadence -keyalg RSA -keysize 4096 -validity 10000
base64 < cadence-release.jks | tr -d '\n'     # the value for ANDROID_KEYSTORE_BASE64
```

Add them under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the keystore file, base64 on one line |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | the key alias (`cadence` with the script) |
| `ANDROID_KEY_PASSWORD` | the key password (same as the keystore password for PKCS12) |

Keep the `.jks` file and its passwords backed up somewhere private. If they're lost you
can make a new key, but everyone then has to uninstall Cadence once before installing a
build signed with it.

## What works

- Your server's library, streamed with seeking.
- Server sign-in, including single sign-on (OIDC): sign-in redirects stay inside the app.
  Pop-up windows (Apple Music's sign-in) open in a dialog that shares the page's session.
- Background playback: while music plays, a foreground service keeps the app alive, and
  the notification and lock screen show the track, cover art and play/pause/next/previous/
  seek, driven by the page's Media Session.
- On-device AI DJ with Gemini Nano on devices that support it (see below).
- Back goes back through the player's history; at the first page it sends the app to the
  background (music keeps playing) rather than closing it.
- Links to non-web schemes (`mailto:`, …) open in the matching app. Web links stay in
  the app: sign-in redirects need that, so there is no "open in browser" for normal
  links.

## Limits

- **Local-network servers use plain HTTP.** Many self-hosters serve Cadence over
  `http://` on a LAN, where there's no certificate to check, so the app allows cleartext
  traffic (`res/xml/network_security_config.xml`). The tradeoff: on an `http://` server,
  anything on the network path can read or alter your traffic, including your password
  and session cookie. Use `https://` for anything reachable from outside your home, and
  only use `http://` on a network you trust. `https://` servers are validated as usual.
- **The bridge is bound to your server's exact origin** (scheme, host and port as you typed
  them). If your server redirects to a different origin (e.g. `http://` → `https://`, or to
  another hostname), the page works but the native bridge (notification controls, on-device
  AI, Change server) is off; type the final address instead.
- **Spotify playback is likely unsupported**: the Spotify Web Playback SDK needs DRM (EME)
  support that an embedded WebView doesn't reliably provide. Your Spotify library still
  shows up. Not tested.
- The WebView, not the app, plays audio, so closing the app (swipe away in Recents, or
  Back out via the system) stops playback.
- Cleartext also applies to cover art in the notification, which is fetched over the same
  scheme as your server.
- There's no Google Play listing or in-app updater: install new releases by hand.

### On-device AI (Gemini Nano)

The AI DJ can run on the phone with no server and no API key, through Google's
[ML Kit GenAI Prompt API](https://developers.google.com/ml-kit/genai/prompt/android)
(Gemini Nano via AICore). It's offered only when the model is ready:

- the phone supports it (recent Pixel and some other flagships; see Google's
  [ML Kit GenAI docs](https://developers.google.com/ml-kit/genai) for the supported devices),
- its bootloader is locked (unlocked bootloaders are unsupported by the API),
- AICore is present and Gemini Nano has already been downloaded to the phone. The app
  never starts that (large) download itself; if the model isn't there yet it's reported as
  unavailable.

Anywhere else the app reports the model as unavailable and the AI DJ just doesn't offer
"on-device". The model is small, so the player sends it a trimmed profile and a JSON
schema in the prompt, as it does for Apple Intelligence on iOS.

## The native bridge

The shell injects `window.CadenceNative` into pages **from your server's origin only**
(not into identity-provider or other third-party pages), at document start. It
follows the contract in `apps/desktop/src/host.d.ts` (`CadenceNativeBridge`):

```ts
window.CadenceNative: {
  platform: "android";                          // extra: tells you which shell you're in
  aiName: "Gemini Nano";                        // shown to the listener
  aiAvailable(): Promise<boolean>;              // model downloaded and ready right now
  aiChatJson(requestJson: string): Promise<string>;
  changeServer(): void;                         // extra: back to the address screen
}
```

- `aiChatJson` takes `{ messages: [{role, content}], schema, temperature? }` as a JSON string and
  resolves with the model's reply text (a JSON object, possibly with chatter around it);
  it rejects with an `Error` if the model isn't available or fails.
- The `window.CadenceNative` object exists on every Android install, whether or not the device
  has Gemini Nano; `aiAvailable()` is the thing to ask.

### What the web side must call for "Change server"

On iOS the page posts to `window.webkit.messageHandlers.cadence`. On Android the equivalent is:

```ts
window.CadenceNative?.changeServer?.();
```

The Settings → Server button currently shows only when `isIosApp()` is true
(`apps/desktop/src/platform/webHost.ts`, `ServerSettings.tsx`), so on Android it needs a
small change that this repository's Android PR deliberately doesn't make:

```ts
export function isNativeApp(): boolean {
  return !!iosApp() || window.CadenceNative?.platform === "android";
}

export function changeNativeServer(): void {
  if (iosApp()) iosApp()?.postMessage({ action: "changeServer" });
  else window.CadenceNative?.changeServer?.();
}
```

(and `host.d.ts` would gain `platform?: string` and `changeServer?(): void`).
Equivalent lower-level form: `window.CadenceAndroid.postMessage(JSON.stringify({ op: "changeServer" }))`.
Until then the failure screen is the only way to change the server, or clear the app's data.
Don't reuse the iOS-only branches for Android blindly: for example the "Spotify doesn't work
on iOS" notice is about iOS web views.

### Media notification

The injected script also watches the page's own Media Session (`navigator.mediaSession`:
`metadata`, `playbackState`, `setPositionState`, plus the first `<audio>`/`<video>` element's
position) and reports it to the app, which mirrors it into the notification and lock screen.
When you use those controls, the app calls the handlers the page registered with
`navigator.mediaSession.setActionHandler` (`play`, `pause`, `nexttrack`, `previoustrack`,
`seekto`). So the web player's existing Media Session integration
(`src/player/integrations.ts`) is all that's needed; no extra web code.

## Building it yourself

Needs JDK 17 and the Android SDK (Android Studio brings both):

```bash
cd apps/android
./gradlew testDebugUnitTest assembleRelease     # APK: app/build/outputs/apk/release/
```

Without a release key (see above) the release build is signed with the debug key. To sign
with your own, put the keystore path and passwords in `apps/android/keystore.properties`
(`storeFile`, `storePassword`, `keyAlias`, `keyPassword`; git-ignored) or in the
`CADENCE_KEYSTORE_FILE` / `CADENCE_KEYSTORE_PASSWORD` / `CADENCE_KEY_ALIAS` /
`CADENCE_KEY_PASSWORD` environment variables. `-PversionName=1.2.3 -PversionCode=42` set
the version; CI sets them from the release tag and run number so each build upgrades the last.
Without an Android SDK, push to GitHub: the **Android** workflow builds the APK.

The Gradle setup uses Android Gradle Plugin 8.13, Kotlin 2.3, `compileSdk`/`targetSdk` 36 and
`minSdk` 26, with a version catalog in `gradle/libs.versions.toml`.
