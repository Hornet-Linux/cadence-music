# Bandcamp

**Short version:** Bandcamp does not offer a way for other apps to play your collection, so Cadence doesn't pretend
to. Music you *bought and downloaded* works perfectly from your library, and the **Bandcamp links** plugin keeps
albums on your Home screen as links or as Bandcamp's own embedded player.

Cadence does not scrape Bandcamp, log in to it, read your collection, or get around anything. That would break
Bandcamp's terms and could break any day. What it uses is what Bandcamp publishes for everyone.

## 1. Your purchases: put the downloads in your library

When you buy on Bandcamp you can download the music (FLAC, MP3, AAC and more) from your collection page. Those are
ordinary files, and the normal Cadence library plays them with tags and artwork:

1. On Bandcamp: **Collection, Download** next to the album, choose a format (FLAC for best quality, MP3 V0 or
   320 for smaller files), download the `.zip`.
2. Unzip it into your music folder, one folder per album (`Artist/Album/01 Song.flac`). Most unzip tools do this
   naturally; the zip already contains the tags and cover art.
3. The server finds new files at its next scan (default hourly). To see them now, an admin can call
   `POST /api/library/scan`.

If your music lives on a NAS or in Nextcloud/S3, the same files work there too: see
[CLOUD_SOURCES.md](CLOUD_SOURCES.md) and
[Music on a network share](SELF_HOSTING.md#music-on-a-network-share-smbcifs-and-nfs).

## 2. The "Bandcamp links" plugin

Turn on **Bandcamp links** (Settings, Plugins). It adds a **Bandcamp** card to Home where you can paste:

- **A page link**, like `https://artist.bandcamp.com/album/name`. The card keeps it with a button **Open on
  Bandcamp**. Cadence does not open or read the page; it only remembers the address (without tracking parameters).
- **The embed code** from an album or track page: on Bandcamp, press **Share / Embed**, choose *Embed this album*, and
  copy the code. Paste it into the card. Cadence reads only the numeric album or track id from the code and builds
  Bandcamp's official player address itself; nothing else in the pasted text is used. Press **Show Bandcamp player**
  and the player appears on your Home screen, sized for phones too.

Notes:

- The player is Bandcamp's own, in an iframe. It is **not loaded until you press the button**, so opening Home doesn't
  contact Bandcamp. What it plays, and whether it plays the whole album, is up to Bandcamp and the artist; Cadence
  can't add its queue, equalizer, history or casting to it.
- Embed codes are what artists and labels publish for their own releases. Fans see the Share / Embed button on
  public pages. If a page has no embed option, use the link.
- Only addresses on `*.bandcamp.com` (and the player address on `bandcamp.com`) are accepted; anything else is rejected
  with an explanation. The list is stored in this app's plugin storage, on this device.
- To allow the player frame, the page security policy of the app (`apps/desktop/index.html`) and of the web player served
  by your server (`apps/server/src/web/webApp.ts`) lists `https://bandcamp.com` under `frame-src`. No other Bandcamp
  address is allowed to load.

## What is not possible, and why

- Playing your *Bandcamp collection* inside Cadence: no public API, and the site's streams are for Bandcamp's own player.
- Importing your wishlist/collection automatically: same.
- Showing the numeric id for a plain link: the id is only in the page's HTML, and reading it would be scraping.
