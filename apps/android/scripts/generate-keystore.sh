#!/usr/bin/env bash
# Creates the key that signs Cadence.apk and prints the four GitHub secrets to add.
#
#   apps/android/scripts/generate-keystore.sh [cadence-release.jks]
#
# Needs `keytool` (it ships with any JDK). Keep the .jks file somewhere safe and private:
# if you lose it, or the repository secrets, new builds can't be installed over the old app
# (you'd have to uninstall it first). Never commit it; *.jks is git-ignored.
set -euo pipefail

file="${1:-cadence-release.jks}"
alias="cadence"

if [ -e "$file" ]; then
  echo "$file already exists; refusing to overwrite it." >&2
  exit 1
fi
command -v keytool >/dev/null || { echo "keytool not found; install a JDK (17+)." >&2; exit 1; }

# PKCS12 keystores use one password for the store and the key.
password="$(head -c 24 /dev/urandom | base64 | tr -d '+/=\n')"

keytool -genkeypair -v \
  -keystore "$file" -storetype PKCS12 \
  -alias "$alias" -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$password" -keypass "$password" \
  -dname "CN=Cadence, O=Hornet Linux" >/dev/null

echo
echo "Wrote $file. Add these four secrets at"
echo "  Settings > Secrets and variables > Actions > New repository secret"
echo
echo "ANDROID_KEYSTORE_PASSWORD = $password"
echo "ANDROID_KEY_PASSWORD      = $password"
echo "ANDROID_KEY_ALIAS         = $alias"
echo "ANDROID_KEYSTORE_BASE64   = (the single line below)"
base64 < "$file" | tr -d '\n'
echo
echo
echo "With the GitHub CLI instead (run from the repository):"
echo "  base64 < $file | tr -d '\\n' | gh secret set ANDROID_KEYSTORE_BASE64"
echo "  gh secret set ANDROID_KEYSTORE_PASSWORD --body '$password'"
echo "  gh secret set ANDROID_KEY_PASSWORD --body '$password'"
echo "  gh secret set ANDROID_KEY_ALIAS --body '$alias'"
