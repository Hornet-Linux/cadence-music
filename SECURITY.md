# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it
privately through GitHub instead:
[Report a vulnerability](https://github.com/Hornet-Linux/cadence-music/security/advisories/new)
(the repository's **Security** tab → **Report a vulnerability**).

Include what you found, how to reproduce it and what an attacker could do with
it. You'll get an answer within a week. Once a fix is released, the advisory is
published with credit to you unless you'd rather stay anonymous.

## Supported versions

Fixes go into the latest release and the rolling Nightly build. Self-hosters
should keep the server up to date: re-run the installer, or
`git pull && docker compose up -d --build` in `deploy/`.

## Scope

In scope: the server (`apps/server`), the desktop and web player
(`apps/desktop`), the Android and iOS apps, and the deployment scripts in
`deploy/`. Problems in third-party services (Spotify, Apple Music, Jellyfin,
AI providers) should go to those projects.
