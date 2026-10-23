# Music from files elsewhere

Cadence can play music that lives outside the server's own music folder. Four optional plugins do it, and they all
work the same way: **your Cadence server does the work.** It signs in to the other place with your login, lists the
folders you choose, reads the tags of the audio files and keeps a small index, so browsing and search are instant.
When you press play, the server streams the file to you (with seeking). Your phone, the web player and the desktop
app never see the password or key, and never talk to the other service themselves.

| Plugin | For | Needs |
| --- | --- | --- |
| **WebDAV** (`cadence.webdav`) | Nextcloud, ownCloud, most NAS boxes, any WebDAV server | address, user, (app) password |
| **S3 storage** (`cadence.s3`) | Amazon S3, MinIO, Backblaze B2, Cloudflare R2, Wasabi, other S3-compatible | bucket, access key, secret |
| **Google Drive & OneDrive** (`cadence.onedrive-gdrive`) | Google Drive and Microsoft OneDrive, read-only | an OAuth app the server owner registers. **Experimental, see below** |
| **Bandcamp links** (`cadence.bandcamp`) | Bandcamp albums as links or the official player | nothing. See [BANDCAMP.md](BANDCAMP.md). Its player is allowed as a frame only (`frame-src https://bandcamp.com`, always on, no `script-src`; see `ALWAYS_FRAME_SOURCES` in STREAMING_SERVICES.md's CSP table) |

For music on an SMB (Windows/Samba) share or NFS, mount it and use the normal library instead: see
[Music on a network share](SELF_HOSTING.md#music-on-a-network-share-smbcifs-and-nfs).

## Turning them on

Two switches, because the server does the work:

1. **Server owner**: enable the plugin on the server (community plugins all start off; this is done from the admin
   page's plugin list) and restart the server. Without this the app shows "isn't turned on at your server".
2. **Each person**: in the app, Settings, Plugins, switch the plugin on. It adds a settings page, a sidebar page, and a
   "From ..." shelf in Library and Home. Then open its settings page and connect.

Everything is per person: your connection is yours alone, and other people on the same server don't see your files.

### For the server owner: private networks

By default people can only connect to servers on the internet (over https). A NAS or MinIO on your home network
is a *private* address, and refused, because the address is typed by users and the server can see more than they can
(your router, other containers, cloud metadata). If you want to allow it, either:

- open any source's settings page as an admin and turn on **Server owner options, Allow servers on this network**, or
- set `SOURCES_ALLOW_PRIVATE_NETWORK=true` in the server's environment.

One switch covers all four plugins. Plain `http://` is accepted only for private addresses. The cloud metadata address
(`169.254.169.254`) and similar are refused whatever you choose.

## WebDAV

You need the WebDAV address of your files:

- **Nextcloud / ownCloud**: Files, Settings (bottom left), "WebDAV" address. It looks like
  `https://cloud.example.com/remote.php/dav/files/YOUR-NAME/`.
- **Synology / QNAP / TrueNAS**: turn on the WebDAV service, then use `https://nas.example:5006/` (or the port you set).
- **Others**: whatever address your server documents; `rclone serve webdav` and Apache/nginx WebDAV work too.

Use an **app password**, not your main password: in Nextcloud, Settings, Security, "Create new app password". You can
revoke it there at any time, and it keeps working if you change your main password.

Then choose folders (or leave all unticked to search the whole share for audio). Only Basic authentication over https is
supported (the usual setup); Digest and Kerberos are not.

## S3-compatible storage

You need a bucket, an access key ID and a secret. **Make a key that can only read**. For Amazon S3 an IAM policy
like this is enough (replace the bucket name):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::my-music" },
    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::my-music/*" }
  ]
}
```

| Service | Endpoint | Region |
| --- | --- | --- |
| Amazon S3 | leave empty | the bucket's region, e.g. `eu-west-1` |
| Backblaze B2 | `https://s3.REGION.backblazeb2.com` (shown on the bucket page) | `REGION`, e.g. `us-west-004` |
| Cloudflare R2 | `https://ACCOUNT-ID.r2.cloudflarestorage.com` | `auto` |
| MinIO | `http://minio.local:9000` (needs the private-network switch) | `us-east-1` unless you changed it |

"Folders" in a bucket are key prefixes; the folder picker lists them. If a self-hosted server rejects the connection,
try turning on "Put the bucket name in the path".

Cadence signs its requests with AWS Signature Version 4, implemented in `apps/server/src/community/s3/sigv4.ts` and
tested against the examples AWS publishes. Streaming uses a presigned link that lives for 60 seconds, is made and used
inside the server, and is never shown to your devices.

## Google Drive and OneDrive (experimental)

> **Untested against the real services.** This plugin was written from Google's and Microsoft's public documentation and
> checked only against imitations of their APIs (`fakeCloud.ts`), because testing it for real needs registered OAuth apps
> and real accounts. The pieces most likely to need a small fix are the exact consent-screen requirements and field names.
> Please report anything that doesn't work. Read-only access is all it ever asks for.

You sign in on Google's or Microsoft's own page; Cadence never sees your password, only a token that can read your
files. Because the token belongs to an *app*, the server owner registers one app per provider (free) and enters its
client ID and secret once. The server needs `PUBLIC_URL` set, because the provider sends people back to
`PUBLIC_URL/api/onedrive-gdrive/callback`.

### Google Drive: registering the app

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project, then **APIs & Services, Library**,
   and enable the **Google Drive API**.
2. **OAuth consent screen**: choose External, fill in the app name and your email. Add the scope
   `.../auth/drive.readonly`. Add the Google accounts that will use Cadence as **test users**.
3. **Credentials, Create credentials, OAuth client ID**, type **Web application**. Under *Authorized redirect URIs* add
   exactly the redirect address shown in Cadence's settings (for example `https://music.example.com/api/onedrive-gdrive/callback`).
4. Copy the client ID and client secret into Cadence: Settings, Google Drive & OneDrive, **Server owner setup**.

Google's rules to know about: while the app is in *Testing* status Google limits it to your test users and expires their
sign-ins after 7 days, so you would have to reconnect weekly. Publishing the app removes that, but `drive.readonly` is a
"restricted" scope, so Google asks for a verification review before an app used by the general public. For a handful of
friends and family most owners stay in Testing, or publish and accept the "unverified app" warning.

### OneDrive: registering the app

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/) (or Azure Portal), **App registrations, New
   registration**. Supported account types: *Accounts in any organizational directory and personal Microsoft accounts*.
2. Redirect URI: platform **Web**, the redirect address shown in Cadence's settings.
3. **API permissions, Add a permission, Microsoft Graph, Delegated**: `Files.Read`, `offline_access`, `User.Read`.
4. **Certificates & secrets, New client secret**; copy the secret **Value** (not the ID).
5. Copy the *Application (client) ID* and the secret into Cadence under **Server owner setup**. Leave the tenant on
   `common` unless you only want personal accounts (`consumers`) or one organisation (its tenant ID).

### Using it

Open Settings, Google Drive & OneDrive, press **Connect**. A new tab opens on the provider's page; after you agree it says
"connected" and Cadence starts indexing. Pick folders to index (otherwise the whole drive is searched for audio files,
which can take a long time on a big drive). **Disconnect** forgets the token on the server; to also remove Cadence's
access, remove it in your Google account's *Third-party access* or Microsoft's *My Apps* page.

If the provider ever refuses the saved token (you removed access, it expired), the settings page says "connect again"
and your already-indexed tracks stay in your library meanwhile.

## What gets indexed

- **Formats**: MP3, FLAC, M4A, AAC, OGG/Opus, WAV, WebM, by file extension (the formats the app can play).
- **Tags** are read from the first 384 KB of each file (title, artist, album, album artist, track number). A file whose
  tags are at the end, such as an M4A not prepared for streaming, shows its file name instead. MP3 length is estimated
  from the bit rate; other formats read it from the header.
- **Cover art is not fetched** from these sources.
- **Refresh**: the index updates every 6 hours, when you press **Refresh now**, and after you change folders.
  Only new and changed files are read again. If a run is interrupted (the server restarts) it carries on where it
  stopped. Files you deleted remotely disappear after a complete listing; a failed listing (the service is down, your
  sign-in expired) never removes anything.
- Hidden files and folders (starting with a dot) are skipped.

## How it protects you

- **Passwords, keys and tokens are encrypted at rest** with a key derived from the server's secret (the same scheme used
  for AI provider keys), in the server database. They are never sent to an app and never logged. If the server secret is
  replaced they can no longer be opened and you simply connect again.
- **The server only talks to addresses it considers safe**: it checks what a name resolves to *at connection time* (so a
  trick with DNS can't point it at something internal), refuses private, loopback and link-local addresses unless the
  owner allows private networks, requires https for the public internet, and never sends your credentials to another site
  when a request is redirected.
- **Stream links are short-lived and personal**: signed for you, one track, 6 hours. Another person can't use or alter them.
- **Read-only**: nothing in these plugins writes, renames or deletes anything on the remote side.

## Limits and honesty

- All four are verified with automated tests against **test doubles** (a fake WebDAV server answering PROPFIND, a fake S3
  that checks signatures, fake Google/Microsoft OAuth and file APIs). They have **not** been run against Nextcloud, AWS,
  Backblaze, Cloudflare, Google or Microsoft themselves.
- The WebDAV reader is written to the WebDAV specification (RFC 4918) and tolerates the usual differences between servers,
  but a server with an unusual reply may need a small fix.
- Very large libraries work (the index is a database table, listings are paged), but the first index of hundreds of
  thousands of files takes a long time because each file's first 384 KB is read.
