# Streaming-service plugins: what is and is not possible

Cadence ships opt-in community plugins for **SoundCloud**, **Deezer**, **TIDAL** and **YouTube**
(`cadence.soundcloud`, `cadence.deezer`, `cadence.tidal`, `cadence.youtube-music`). There is **no
Qobuz plugin**. This page records what each service's *official* developer documentation and terms allow,
what we built on top of that, and what we deliberately did not build.

**Ground rules.** We only use official, documented APIs and official embedded players. We do not scrape,
reverse-engineer private/web-player APIs, extract stream URLs from players, bypass DRM, download or cache
audio, or hide a player that a service's terms require to be visible. Where a service gives third-party
apps no legitimate way to do something, the feature is missing and this page says so.

**How the research was done.** The pages listed at the end were read on 2026-10-22. Several developer
portals (Deezer, TIDAL) are JavaScript apps that could only be partly read automatically, and TIDAL's
developer terms could not be retrieved at all. Where something is *unverified* it is marked that way.
Nothing here is legal advice; the services' own terms control and can change at any time. The plugins
were tested against fakes only (no live credentials were available), so request/response shapes of the live
services are as documented, not as observed.

## Summary

| Service | What the official API allows | What we implemented | What we did NOT implement, and why |
| --- | --- | --- | --- |
| **SoundCloud** `cadence.soundcloud` | Anyone can register an app (client id/secret). OAuth 2.1 with **PKCE required** for user login; client-credentials for public data. `GET /tracks?q=`, `/me/likes/tracks`, `/me/playlists`, `/resolve`, `/oembed`. Playback: the official HTML5 Widget (it handles attribution itself) or a custom player on `stream_url` (then the official SoundCloud logo, a "Powered by SoundCloud" asset and a link on every track are required). Forbidden: downloads, persistent caching, offline use, ads/sponsorship around user content, AI use of content. | Admin-entered client id/secret (server side only). Search (client credentials, token cached until expiry). Per-person login with PKCE and refresh (single-use refresh tokens are rotated), likes and playlists. **Playback through the official SoundCloud Widget** in a visible player panel, driven as an `ExternalPlayback`. Creator credit, permalink back-link and a "Powered by SoundCloud" link. | Custom `stream_url` playback in our own `<audio>`: the terms then require SoundCloud's official logo assets on every track, which we do not bundle (we will not redraw a trademark), and a track's `access` may be `preview` or `blocked`. The widget path avoids this. Downloads/offline (forbidden). |
| **Deezer** `cadence.deezer` | Free, **non-commercial**, personal apps. OAuth: `app_id` + `secret`, code flow at `connect.deezer.com`, permissions such as `basic_access` and `offline_access`. **No PKCE and no refresh token are documented** for it. API audio is **30-second MP3 previews only**; full tracks are for Premium listeners and only inside Deezer's own plugins/widgets. Terms: storing audio is "strictly forbidden", full-track URLs must never reach end users, no reverse engineering, users must be told streaming is private/family use, trademark guidelines for logos. | Admin-entered app id/secret. Search (public API). Person login (code flow, `state` checked, secret kept on the server), favourite tracks and playlists. **30-second previews** as normal audio, with the preview URL fetched fresh at play time because Deezer signs and expires it. "Open in Deezer" on every track, "Powered by Deezer" credit, non-commercial / private-use notice. Optional **official Deezer widget** shown in the player panel for full-length listening by someone with a Deezer account (Cadence does not control it). | Full-track playback inside Cadence's own player: the widget has no documented JS control API, so it is shown as-is and is **not** an `ExternalPlayback` (queue, seek and volume do not apply). We also could not verify that the old JS SDK player is open to new apps. Downloads/offline (forbidden). Deezer logo images (text credit only). PKCE/refresh (not offered by Deezer). |
| **TIDAL** `cadence.tidal` | Self-service developer portal. **OpenAPI v2** (`openapi.tidal.com/v2`, JSON:API): catalogue, search, playlists, user collections. OAuth2: client-credentials for the catalogue, **authorization code + PKCE** (`login.tidal.com/authorize`, `auth.tidal.com/v1/oauth2/token`) for user data. Audio: the Playback API only issues **encrypted manifests that must be played through TIDAL's official Player SDK** (per TIDAL policy). TIDAL's developer terms and design guidelines could **not** be read, so whether a third-party app may use the Player SDK is **unverified**. | Admin-entered client id/secret. Catalogue search (client credentials). Person login with **PKCE** and refresh; the person's playlists and saved tracks. Every track links out to `tidal.com`; "Powered by TIDAL" credit. | **Playback.** An official web Player SDK exists, but we could not verify that it is licensed for a third-party app like this, it needs a Widevine-capable runtime, and it cannot be tested without live credentials. We did not ship an unverifiable integration: TIDAL tracks are **link-out only**. No previews (none found in the API). No manifest/HLS/DASH handling, no download/offline tasks. |
| **Qobuz** (no plugin) | No public API for third-party apps. Credentials (`app_id`/`app_secret`) go to commercial partners on request. Community reports say Qobuz refuses open-source integrations because of its label licences and has revoked app ids used by hobby apps (not an official statement we could retrieve). | **Nothing.** | Everything. There is no legitimate API for a hobby or self-hosted app. The only ways in are scraping or reusing a private app id, which we will not do. With genuine Qobuz partner credentials you could write your own plugin on the same `_streaming` helpers. |
| **YouTube** `cadence.youtube-music` | **There is no YouTube Music API.** The YouTube Data API v3 (`search.list`, quota-limited) and the **IFrame Player API** are official. Rules: the player must be at least 200x200, must not be covered or altered, and must be **displayed on the screen the person is viewing** (developer policy III.I.9 forbids playing from a player that is not displayed; III.I.7 forbids separating audio from video). No downloading or caching, ads must not be blocked, YouTube must be shown as the source, link to the YouTube Terms of Service. API keys must be your own and not shared or published. | Admin-entered Data API key (kept on the server). Search for **embeddable videos** (Music category), with duration lookup. Playback only through the **official IFrame player in a visible panel** (200x200 or larger, nothing overlaid), driven as an `ExternalPlayback`. "YouTube" source credit, YouTube Terms of Service link, link-out to each video. | **Audio-only, hidden or background playback** (forbidden), so playback pauses when the panel is closed. **YouTube Music catalogue, library, playlists, lyrics, Premium features**: no official API. Ad skipping, downloads. YouTube logo images (text credit only; logos have size/placement rules). The IFrame API fails from a `file://` origin (error 153), so use the web player or an HTTP-served build. Quota: the docs we read were inconsistent about the cost of `search.list` (1 vs 100 units); check your Google Cloud console. |

## How the pieces fit

```
Browser / Electron / Android WebView          Cadence server (community plugin)             Service
cadence.<svc> (desktop plugin)  --/api/streaming/<svc>/...-->  cadence.<svc> (server plugin)  --official API-->
  settings panel, page, audio source                             OAuth + PKCE, token refresh,
  visible player panel (widgets)                                 search proxy; secrets in settings.pluginConfig
```

* The **admin** turns the server add-on on (community server plugins start off; the switch is the
  server setting `plugin:<id>:enabled`, e.g. `plugin:cadence.deezer:enabled`, applied after a restart) and
  enters the service's credentials in the plugin's settings panel. Secrets are encrypted at rest with a key derived
  from the server secret and are never sent back to a browser.
* Each **person** presses "Connect" to log in to the service themselves (OAuth). Tokens are stored per
  person on the server, encrypted, and refreshed there. (YouTube needs no personal login.)
* Without credentials, every plugin shows a plain explanation, stays out of the way, and makes no calls.
* The desktop plugins are `builtin: false`; people enable them in Settings > Plugins.
* Embedded players (SoundCloud, YouTube, optionally Deezer) live in a **visible player panel** that Cadence
  never hides, covers, shrinks below 200x200, or overlays. Closing the panel stops playback.

## Content-Security-Policy

The server-served web player (`/app`) keeps its default CSP exactly as before. `EMBED_CSP_SOURCES` in
`apps/server/src/web/webApp.ts` adds each official embed host **only when the admin has enabled the matching
server plugin** (read at start-up, so, like the plugin itself, it applies after a restart):

| Plugin enabled on the server | Added to `script-src` | Added to `frame-src` |
| --- | --- | --- |
| `cadence.youtube-music` | `https://www.youtube.com` | `https://www.youtube.com`, `https://www.youtube-nocookie.com` |
| `cadence.soundcloud` | `https://w.soundcloud.com` | `https://w.soundcloud.com` |
| `cadence.deezer` | none (plain iframe) | `https://widget.deezer.com` |
| `cadence.tidal` | none | none |
| always (no server plugin: the desktop `cadence.bandcamp` embed) | none | `https://bandcamp.com` |

`ALWAYS_FRAME_SOURCES` in the same file holds that last row: the Bandcamp embedded player is a plain iframe with no
script and has no server plugin an admin could switch on, so its host is always allowed as a frame and never as a script.

The web build (`vite build --mode web`) drops the `<meta>` CSP from `index.html`, because a fixed meta policy
would be intersected with the server's header and block these embeds; the header is stricter anyway.

The Electron app's own policy (the meta tag in `apps/desktop/index.html`, no admin toggle) gains only
`frame-src https://widget.deezer.com https://bandcamp.com`, because both widgets are iframes with no script. Its `script-src` is
**not** widened, so the YouTube and SoundCloud plugins (which need their loader scripts) work in the web player and
Android app, not in the Electron app. (YouTube's player also refuses `file://` origins.)

## Testing

Unit tests use mocked network and mocked widget/iframe APIs. For end-to-end checks without live credentials,
the server can redirect every service endpoint, token exchange included, to a fake host, but **only when both**
`CADENCE_TESTING=1` and `CADENCE_STREAMING_TEST_UPSTREAM=<origin>` are set (endpoints become
`<origin>/<slug>/<host-key>/...`; see `hosts()` in `apps/server/src/community/_streaming/http.ts`). Either variable
alone is ignored, and when it is active each streaming plugin logs a WARN at start-up naming itself and the target.
Never set these in production.

## Redirect URIs to register

OAuth completes on the Cadence server. Register this exact redirect URI with each service (the plugin's
settings panel shows it to the admin; it is built from `PUBLIC_URL`, else from the request):

`<PUBLIC_URL>/api/streaming/soundcloud/callback`, `<PUBLIC_URL>/api/streaming/deezer/callback`,
`<PUBLIC_URL>/api/streaming/tidal/callback`

SoundCloud and TIDAL expect HTTPS for non-loopback redirect URIs; Deezer wants the host to match the
"application domain" of the app you registered.

## Branding actually shown

| Service | We show | The service also asks for, which we did not do |
| --- | --- | --- |
| SoundCloud | Widget (carries SoundCloud's own branding), creator, permalink back-link, "Powered by SoundCloud" text link | Official logo image assets (not bundled) |
| Deezer | "Powered by Deezer" text link, "Open in Deezer", official widget | Logo image per Deezer's trademark guidelines |
| TIDAL | "Powered by TIDAL" text link, "Open in TIDAL" | Logo image and design guidelines (not read) |
| YouTube | Official player (shows YouTube branding), "YouTube" source credit, Terms of Service link | YouTube logo/icon image; your own terms must say users are bound by the YouTube ToS |

## Sources read

* SoundCloud: developers.soundcloud.com/docs/api/guide, /terms-of-use, /html5-widget, /buttons-logos
* Deezer: developers.deezer.com/guidelines, /termsofuse, widget.deezer.com. The OAuth and API reference pages
  did not load without JavaScript, so the OAuth flow is from third-party client libraries and is **less
  certain** than the rest.
* TIDAL: tidal-music/tidal-sdk `Auth.md`, tidal-sdk-web READMEs, third-party API listings. developer.tidal.com
  pages did not load and the developer terms were **not** read.
* Qobuz: no official developer documentation to read; community reports only.
* YouTube: developers.google.com/youtube/iframe_api_reference, /terms/required-minimum-functionality,
  /terms/developer-policies, /terms/branding-guidelines, /v3/docs/search/list
