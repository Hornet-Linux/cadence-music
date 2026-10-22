# Releasing

There are two kinds of downloads.

| | Where | When | Meant for |
| --- | --- | --- | --- |
| **Nightly** | [releases/tag/nightly](https://github.com/Hornet-Linux/cadence-music/releases/tag/nightly), a pre-release | Every push to `main` | Trying the newest build |
| **A version** | Its own release, e.g. `v0.2.1`, marked **Latest** | When you push a `v*` tag | Everyone else |

The README's "latest" download links point at the newest *version*, never at the Nightly.

## Cutting a version

1. Land everything you want in it on `main`, and check the CI run for that commit is green (including **Desktop · macOS app**, **Desktop · Windows installer**, **Android** and **iOS**).
2. Bump the version in one PR: `apps/desktop/package.json`, `apps/server/package.json`, `apps/server/src/version.ts`, the default in `apps/android/app/build.gradle.kts` and `MARKETING_VERSION` in `apps/ios/project.yml`.
3. Write the notes in `docs/releases/vX.Y.Z.md`. If that file exists the release uses it; otherwise GitHub generates notes from the merged PRs.
4. After that PR is merged, tag the merge commit and push the tag:

   ```bash
   git switch main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

## What happens next (automatically)

- **CI** builds the Windows installer and both macOS disk images and creates the release `vX.Y.Z` with them.
- The **Android** workflow builds `Cadence.apk`, signed with the release key, and attaches it with `Cadence.apk.sha256`. The **iOS** workflow attaches the unsigned `Cadence.ipa`. Both wait (up to 30 minutes) for CI to create the release first.
- The release is created as the **Latest**; the Nightly pre-release is not affected.

Check the release page afterwards: it should have `Cadence-Setup.exe`, `Cadence-mac-arm64.dmg`, `Cadence-mac-x64.dmg`, `Cadence.apk`, `Cadence.apk.sha256` and `Cadence.ipa`.

## Android signing

The APK is signed from four repository secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Without them the build falls back to the debug key, which installs but cannot update a release-signed app. Keep a backup of the keystore: if it is lost, everyone has to uninstall before installing a build signed with a new key. `apps/android/scripts/generate-keystore.sh` creates one.

## If a release goes wrong

- A failed job can be re-run from the Actions page; the Android and iOS jobs upload with `--clobber`, so re-running replaces the file.
- To withdraw a release: delete the GitHub release, then delete the tag (`git push origin :refs/tags/vX.Y.Z`). The next tag publishes again.
