#!/bin/bash
# Builds Family-Dashboard-Server-<version>.pkg on a Mac (the release workflow
# runs this on GitHub's macOS machines).
#
# usage: installer/macos/build-pkg.sh <bundle.tar.gz> [node major, default 24]
#
# The pkg carries a universal (Intel + Apple silicon) copy of Node, so nothing
# else needs installing. It is unsigned unless these are set:
#   PKG_SIGN_IDENTITY   "Developer ID Installer: Your Name (TEAMID)"
#   NOTARY_PROFILE      a notarytool keychain profile (xcrun notarytool store-credentials)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BUNDLE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
NODE_MAJOR="${2:-24}"
VERSION=$(node -p "require('$REPO/package.json').version")
OUT="$REPO/dist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# 1. Node for both kinds of Mac, checked against nodejs.org's checksums
BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
for arch in arm64 x64; do
  file=$(grep -o "node-v[0-9.]*-darwin-$arch.tar.gz" "$WORK/SHASUMS256.txt" | head -1)
  curl -fsSL "$BASE/$file" -o "$WORK/$file"
  (cd "$WORK" && grep " $file\$" SHASUMS256.txt | shasum -a 256 -c -)
  mkdir -p "$WORK/$arch" && tar -xzf "$WORK/$file" -C "$WORK/$arch" --strip-components 2 "${file%.tar.gz}/bin/node"
done
lipo -create "$WORK/arm64/node" "$WORK/x64/node" -output "$WORK/node"
lipo -info "$WORK/node"
echo "Node $("$WORK/node" --version)"

# 2. what the pkg puts on disk; postinstall moves it into the person's home folder
ROOT="$WORK/root/Library/Application Support/Family Dashboard Installer"
mkdir -p "$ROOT"
cp "$WORK/node" "$ROOT/node"
cp "$BUNDLE" "$ROOT/bundle.tar.gz"
cp "$HERE/com.familydashboard.server.plist" "$HERE/uninstall.command" "$ROOT/"
echo "$VERSION" > "$ROOT/VERSION"

chmod 755 "$HERE/scripts/"* "$ROOT/uninstall.command"
pkgbuild --root "$WORK/root" --scripts "$HERE/scripts" \
  --identifier com.familydashboard.server --version "$VERSION" \
  --install-location / "$WORK/component.pkg"

# 3. the installer window: welcome, license, finish
mkdir -p "$WORK/resources"
cp "$HERE/resources/"*.html "$WORK/resources/"
cp "$REPO/LICENSE" "$WORK/resources/LICENSE.txt"
sed "s/__VERSION__/$VERSION/g" "$HERE/distribution.xml" > "$WORK/distribution.xml"
PKG="$OUT/Family-Dashboard-Server-$VERSION.pkg"
SIGN=()
[ -n "${PKG_SIGN_IDENTITY:-}" ] && SIGN=(--sign "$PKG_SIGN_IDENTITY")
productbuild --distribution "$WORK/distribution.xml" --resources "$WORK/resources" \
  --package-path "$WORK" ${SIGN[@]+"${SIGN[@]}"} "$PKG"

if [ -n "${PKG_SIGN_IDENTITY:-}" ] && [ -n "${NOTARY_PROFILE:-}" ]; then
  xcrun notarytool submit "$PKG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$PKG"
fi
echo "$PKG"
