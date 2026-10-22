# Plex

The **Plex** plugin plays the music in your [Plex Media Server](https://www.plex.tv)
next to your other sources: browse artists, albums, playlists, search, play with
seeking, see artwork, heart tracks (a Plex rating) and have plays counted in Plex.

Like [Jellyfin](JELLYFIN.md) and [Subsonic](SUBSONIC.md) it connects **through the
Cadence server**: the server talks to your Plex server and streams audio and
artwork on, so phones and browsers never need to reach Plex, and Plex tokens never
leave the server.

Plugin ids: `cadence.plex` (app and server). Both are community plugins and start **off**.

## Turn it on

1. **Server owner:** Settings > Plugins (admin): enable the server plugin *Plex*,
   restart the server.
2. **Everyone:** Settings > Plugins in the app: enable *Plex*. A *Plex* page appears in
   the sidebar and a *Plex* section in Settings.

## Set the address (server owner)

Give the address of the Plex Media Server **as the Cadence server reaches it**:
`PLEX_URL` in the server environment (wins), or Settings > Plex as an admin
(**Test** calls the unauthenticated `/identity` endpoint, then **Save**), or the API:

```sh
curl -X POST https://music.example.com/api/admin/plex/test -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"serverUrl":"http://plex:32400"}'
curl -X PUT  https://music.example.com/api/admin/plex -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"serverUrl":"http://plex:32400"}'
```

The same address rules and protections as Subsonic apply (http/https, optional
path, no credentials/query/fragment, link-local and cloud-metadata addresses
refused unless an admin passes `"allowLinkLocal": true`).

## Link your account (everyone else)

Settings > Plex > **Link Plex account**. Cadence asks plex.tv for a short code
(the [official PIN flow](https://forums.plex.tv/t/authenticating-with-plex/609370);
`strong=false`). Open **plex.tv/link** on any device, sign in to Plex and enter the
code. The app notices on its own (it asks the server every 3 seconds). Your Plex
password never reaches Cadence; Cadence only receives a token for your account.

- The Plex account must have access to the owner's server. If it does not, the
  token is thrown away and the app says so.
- If the server has one music library, it is chosen for you; with several, pick
  one in Settings > Plex. Only libraries of type *music* are offered.
- Each person is one Plex device ("Cadence") named by a stable per-person client id.
- **Unlinking** forgets the token in Cadence. To fully revoke it, also remove
  Cadence under *Authorized devices* on plex.tv (Cadence does not call plex.tv to
  revoke tokens).

## What goes through the server

| | |
| --- | --- |
| Browse | Section listings (`/library/sections/<id>/all`, types 8/9/10, paged with `X-Plex-Container-Start/Size`, Plex's own totals), an artist's albums, an album's tracks, audio playlists. |
| Search | `/hubs/search` inside your chosen library; matching artists and albums are expanded into tracks. |
| Playing | **Direct play:** the original file (`/library/parts/...`) is streamed through with HTTP `Range`, when its container/codec is one browsers play (MP3, AAC/M4A, FLAC, WAV). **Transcode fallback:** anything else (Ogg, ALAC, WMA...) goes through Plex's universal transcoder as MP3 (`/music/:/transcode/universal/start.mp3`, direct play off). |
| Artwork | Plex's photo transcoder (`/photo/:/transcode`), 300 px by default, at most 1200. |
| Favourites | Hearting sets your rating to 10 (a rating of 8 or more counts as a favourite); un-hearting sets 0. |
| Plays | Start/stop go to `/:/timeline`; a listen of half the track or four minutes also calls `/:/scrobble`, which updates play count and "recently played". |

Streams and artwork use short-lived signed URLs (six hours / about a month),
bound to the person, item and kind.

## Security notes

- **The token only travels in the `X-Plex-Token` header**, never in a URL, so
  logs and error messages cannot contain it. It is stored encrypted at rest
  (AES-256-GCM, key from the server secret) and never returned by any endpoint.
- **No user-supplied addresses.** The Plex server address is the owner's; plex.tv is
  a fixed address. Plex's resource list (which carries addresses a user could
  influence) is deliberately **not** used, so no one can make the server fetch an
  arbitrary URL. The link pin id stays on the server, so nobody can poll or finish
  another person's link.
- Codes are rate limited (10 per person per 15 minutes).
- Same transport protections as Subsonic: no cross-origin redirects, time and size
  caps, ids must be digits, generic error messages, upstream cancelled when the
  player goes away. Problems with a person's Plex sign-in are HTTP 409, never 401.
- Part and artwork paths from Plex are validated against strict patterns before
  they are requested.

## Known limits

- One Plex server per Cadence server; one music library per person at a time.
- Playlists are read-only; only music is shown.
- The transcoded fallback cannot always seek (Plex produces it live).
- **Not tested against a real Plex server.** The code follows Plex's public API as
  documented by the community, and is verified against a fake Plex and plex.tv
  (`apps/server/src/community/plex/fakePlex.ts`). Parameter details of the
  transcoder and `/hubs/search` in particular may need adjusting against a real
  server; the direct-play path is the one most likely to work as is.
- Plex Pass, Plex-hosted music (TIDAL) and Plexamp-only features (sonic analysis,
  radio) are not used.