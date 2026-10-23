# Subsonic (Navidrome, Airsonic-Advanced, Gonic)

The **Subsonic** plugin plays the music on any server that speaks the
[Subsonic API](http://www.subsonic.org/pages/api.jsp) (also the OpenSubsonic
extensions): [Navidrome](https://www.navidrome.org), Airsonic-Advanced, Gonic and
others. You can browse artists, albums, playlists and starred songs, search, play
with seeking, see cover art, star songs and have plays scrobbled back.

It is modelled on the [Jellyfin](JELLYFIN.md) integration. Subsonic connects
**through the Cadence server**: the server calls your Subsonic server and streams
the audio and cover art on, so browsers and phones never talk to it (no CORS, no
mixed-content blocking, no extra address on the phone).

Plugin ids: `cadence.subsonic` (app) and `cadence.subsonic` (server). Both are
community plugins and start **off**.

## Turn it on

1. **Server owner:** in Settings > Plugins (admin), enable the server plugin
   *Subsonic* and restart the server. (Community server plugins load only when
   enabled; a restart applies the change.)
2. **Everyone:** in the app, Settings > Plugins, enable *Subsonic*. A *Subsonic*
   page appears in the sidebar and a *Subsonic* section in Settings.

## Set the address (server owner)

Tell the server where Subsonic is, **as the Cadence server reaches it**: either set
`SUBSONIC_URL` in the server's environment (it wins over the saved value), or open
Settings > Subsonic while signed in as an admin, type the address, press **Test**
and **Save**. The same through the API:

```sh
curl -X POST https://music.example.com/api/admin/subsonic/test \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"serverUrl":"http://navidrome:4533"}'
curl -X PUT https://music.example.com/api/admin/subsonic \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"serverUrl":"http://navidrome:4533"}'      # {"serverUrl": null} removes it
```

The address must be `http://` or `https://`, may have a path (`https://example.com/navidrome`)
and must not contain a user name, password, query string or fragment. Changing it
applies at once; people signed in to the old address are signed out of Subsonic and
their stored password is dropped (it is never sent to a different address).

**Docker tip:** inside a container `localhost` is the container itself. Put both
containers on one Docker network and use the service name (`http://navidrome:4533`).

## Sign in (everyone else)

Settings > Subsonic: enter your own Subsonic user name and password. Each person
uses their own account, so stars and play counts are theirs.

**Why the server keeps your password.** Subsonic has no session tokens: every call
carries `t = md5(password + salt)` with a fresh salt, which needs the password. So
Cadence stores it on the server, **encrypted at rest** (AES-256-GCM, key derived from
the server secret) and never returns or logs it. It is sent to Subsonic only as the
salted token (never as a plain password), except for servers that cannot check
tokens (LDAP users, error code 41): then Cadence falls back to the older
`p=enc:<hex>` parameter, which is plain text on the wire, so use HTTPS between
Cadence and such a server. Use a Subsonic account you do not reuse elsewhere.

## What goes through the server

| | |
| --- | --- |
| Browse | Tracks (the whole library via an empty `search3`), albums (alphabetical, newest, recent, frequent), artists and their albums, playlists, starred songs. |
| Search | `search3`. A text search also finds the tracks of matching artists and albums. |
| Playing | `stream` with HTTP `Range` passed through, so seeking works. Files browsers play (MP3, AAC/M4A, FLAC, WAV) are requested as `format=raw`; others (Ogg, Opus, WMA...) as MP3 at 320 kbit/s (seeking inside a transcoded stream depends on your server). |
| Cover art | `getCoverArt`, default 300 px, at most 1200. |
| Stars | Starring a song in Cadence is `star`/`unstar` in your account. |
| Plays | Start = `scrobble` (now playing); a listen of half the track or four minutes = `scrobble` with `submission=true` (so Navidrome forwards it to Last.fm/ListenBrainz if you set that up there). Skipped songs are not counted. |

Streams and cover art use short-lived signed URLs (audio elements cannot send a
sign-in header): audio links last six hours, cover art about a month. The signature
binds the service, the person, the item, the kind and the expiry.

## Security notes

- **Only the owner sets the address**; nothing a user sends is used as a URL.
  Link-local and cloud-metadata addresses (`169.254.0.0/16`, `fe80::/10`,
  `metadata.google.internal`, `100.100.100.200`, ...) are refused, including in
  decimal/hex/IPv4-mapped spellings, unless an admin passes `"allowLinkLocal": true`
  to the admin API on purpose. Ordinary private addresses (192.168.x.x, 10.x.x.x,
  `localhost`, service names) are the normal case and are allowed.
- **Passwords never leave the server** (see above) and are removed when the person
  signs out, when the address changes, when the account is deleted (a daily sweep)
  or when Subsonic rejects them.
- **No password guessing through Cadence.** Failed sign-ins are limited to 5 per
  person and 20 per address every 15 minutes.
- **Ids are checked** before they go into any request.
- **Errors are generic.** Clients get fixed phrases ("Subsonic couldn't be
  reached"), never upstream text. Calls carry credentials in the query string
  (the Subsonic API's design), so the server never logs request URLs to Subsonic.
- **No cross-origin redirects.** A redirect to another origin is an error;
  same-origin redirects are followed up to three times.
- **Size and time limits:** API answers are capped at 12 MB and 15 s; cover art at
  8 MB; streams give up when the server goes quiet for 30 s and are cancelled
  when the player goes away.
- A sign-in problem is reported as HTTP **409**, never 401 (the Cadence app signs
  you out of Cadence on a 401 it does not recognise).

## Known limits

- One Subsonic server per Cadence server.
- Subsonic has no "list every song" call: Cadence uses an empty `search3`, which
  Navidrome, Gonic and Airsonic answer with the whole library. A server that does
  not shows the tracks of its first 20 albums instead (browse by album then).
- Subsonic reports no totals for albums and `search3`, so those lists use
  "Show more" instead of a count.
- Ids must be plain tokens (letters, digits and `._:@=+~-`, up to 128 characters).
- Playlists, stars on albums and artists, and the AI DJ taste profile are not
  wired up; playlists are read-only. API-key auth (OpenSubsonic `apiKey`) is not
  used.
- Tested against a fake Subsonic server in this repository
  (`apps/server/src/community/subsonic/fakeSubsonic.ts`), written from the API
  documentation; not yet against a real Navidrome, Airsonic or Gonic.