# Jellyfin

Cadence can play the music in your [Jellyfin](https://jellyfin.org) server next
to your own files, Spotify and Apple Music: browse and search albums and tracks,
play them (with cover art), favourite songs, see your playlists, and let the AI
DJ use your Jellyfin listening to pick songs from your own library.

Jellyfin connects **through the Cadence server**. The server calls Jellyfin and
streams the audio and cover art on to the app, so phones and browsers never talk
to Jellyfin directly (no CORS, no extra ports, no Jellyfin address on the
phone), and a Jellyfin sign-in never leaves the server.

## Set it up (server owner)

Tell the server where Jellyfin is, **as the Cadence server reaches it**. Either
set it in `deploy/.env`:

```env
JELLYFIN_URL=http://jellyfin:8096
```

or save it from the **Jellyfin** page in the admin panel (`/admin`): type the
address, press **Test** (it reports the Jellyfin server's name and version) and
**Save**. A `JELLYFIN_URL` variable wins if both are set, and then the page shows
the address read-only. The same thing through the admin API:

```sh
# check an address first (nothing is saved)
curl -X POST https://music.example.com/api/admin/jellyfin/test \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"serverUrl":"http://jellyfin:8096"}'

# save it ({"serverUrl": null} removes it)
curl -X PUT https://music.example.com/api/admin/jellyfin \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"serverUrl":"http://jellyfin:8096"}'
```

The address must be `http://` or `https://`, may have a path (for Jellyfin at
`https://example.com/jellyfin`) and must not contain a user name, password, query
string or fragment. A trailing slash is dropped.

**Docker tip.** Inside a container, `localhost` is the container itself. Put the
Cadence and Jellyfin containers on a shared Docker network and use the service
name (`http://jellyfin:8096`), or use the host's address if Jellyfin runs on the
host (`http://host.docker.internal:8096` with an `extra_hosts` entry, or the
machine's LAN IP). Use the plain internal address: it never has to be reachable
from outside.

Changing the address applies immediately. People who signed in to the old address
are signed out of Jellyfin in Cadence (their stored sign-in is dropped and never
sent to the new address) and sign in again.

## Connect (everyone else)

In the app's Jellyfin settings, enter your own Jellyfin user name and
password and press **Sign in**. Each person uses their own account, so
favourites, play counts and recently played are theirs. Cadence uses the password
once, to ask Jellyfin for an access token, and doesn't keep it.

In Jellyfin's dashboard each person shows up as a device named **Cadence server**.
Signing out in Cadence signs that device out of Jellyfin too. If a session is
ended in Jellyfin (or the account is disabled), Cadence notices on the next call
and asks the person to sign in again.

## What goes through the server

| | |
| --- | --- |
| Browse and search | Tracks, albums (with their tracks), playlists (read-only), favourites. |
| Playing | Audio is streamed through the server with seeking (HTTP `Range`). Formats browsers and phones play (MP3, AAC/M4A, FLAC, WAV) are passed through untouched; anything else (Ogg, Opus, WMA, ...) is transcoded by Jellyfin to MP3. |
| Cover art | Proxied and resized by Jellyfin (default 300 px wide, at most 1200). |
| Favourites | Starring a song in Cadence stars it in Jellyfin, and vice versa. |
| Plays | Start, progress and stop are reported to Jellyfin, so play counts and "recently played" stay right and show up in Jellyfin's "now playing". |
| AI DJ | The taste profile (top and favourite artists, their genres, most played and recent songs) is built from your Jellyfin. A new Jellyfin with no plays yet falls back to a sample of the library. The DJ's picks are matched back to library tracks by artist and title (case, accents, punctuation, "(Remastered)" and "feat." are ignored; both must match closely, otherwise the pick is skipped). |

Streams and cover art use short-lived signed URLs (audio elements can't send a
sign-in header): audio links last six hours, cover art about a month so saved
history and likes keep their pictures. The signature covers the person, the item
and the expiry, and audio and cover links are not interchangeable.

## Security notes

- **Only the owner sets the address.** Ordinary users can't supply a URL, because
  a URL the server fetches for them would let anyone with an account make the
  server request internal addresses (SSRF) or use it as a relay. Nothing a user
  sends (body, query, headers) is ever used as an address. The admin "test" call
  does fetch an address an admin gives it, so it is admin-only and sends no
  credentials.
- **Tokens stay on the server**, encrypted at rest with a key derived from the
  server secret (`SERVER_SECRET` / `DATA_DIR/secret.key`), and are never returned
  by any endpoint or written to logs. Anyone who can read the data folder can read
  both, as with the AI provider keys. Back them up together, or just have people
  sign in again after a restore.
- **No password guessing through Cadence.** Failed Jellyfin sign-ins are limited
  to 5 per person and 20 per address every 15 minutes.
- **Ids are checked** (Jellyfin ids are 32 hex characters) before they go into any
  Jellyfin URL.
- **Errors are generic.** Clients get fixed phrases ("Jellyfin couldn't be
  reached"), never text from Jellyfin or details of your network. Details are in
  the server log.
- **No redirects to other origins.** Calls with a sign-in are never followed to
  another address (the token would go with them); a redirect from Jellyfin to a
  different address is an error. If your Jellyfin redirects `http` to `https`, set
  the `https://` address.
- Put Cadence behind HTTPS (the setup script does): the Jellyfin password crosses
  your connection to Cadence when someone signs in.

## Known limits

- One Jellyfin server per Cadence server.
- Transcoded streams (non-MP3/AAC/FLAC/WAV sources) can't be seeked: Jellyfin
  produces them live. Sources in the passthrough formats seek normally.
- Playlists are read-only in Cadence, and only music (audio tracks, albums,
  playlists of audio) is shown.
- Tested against Jellyfin 12.2.0. Favourites use `UserFavoriteItems` (Jellyfin 10.9
  and later) and fall back to the older per-user route; other calls use routes that
  are stable across 10.8 to 12.
- Cadence doesn't create or manage Jellyfin accounts; people need one already.
- Smoke test: with a Jellyfin and a running Cadence server,
  `apps/server/scripts/jellyfin-smoke.mjs` walks every feature against the real
  thing (see the comment at the top of the file). It is not part of CI.
