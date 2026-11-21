#!/bin/bash
# Builds the update bundle a release carries:
#   dist/family-dashboard-server-<version>.tar.gz   code + production node_modules
# Only the files listed here go in, so a stray config.txt or key never ships.
# usage: scripts/make-bundle.sh            (run from the repo, after npm ci --omit=dev)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
NAME="family-dashboard-server-$VERSION"
FILES="server.js launcher.js updater.js setup-extras.js pairing.js cloud-config.js tasks.js discovery.js map-full.js ai.js home-assistant.js displays.js
firestore.rules package.json package-lock.json household.example.json config.example.txt README.md LICENSE CHANGELOG.md"

[ -d node_modules ] || { echo "run npm ci --omit=dev first"; exit 1; }
rm -rf "dist/$NAME" "dist/$NAME.tar.gz"
mkdir -p "dist/$NAME"
for f in $FILES; do cp "$f" "dist/$NAME/"; done
cp -R web "dist/$NAME/web"
# never ship code that doesn't even parse, or that imports a file left out of the bundle
for f in dist/$NAME/*.js; do node --check "$f"; done
for f in dist/$NAME/*.js; do
  for dep in $(grep -oE "from '\./[^']+'" "$f" | sed -E "s/from '\.\/([^']+)'/\1/"); do
    [ -f "dist/$NAME/$dep" ] || { echo "refusing: $(basename "$f") needs $dep, which isn't in the bundle"; exit 1; }
  done
done
cp -R node_modules "dist/$NAME/node_modules"
# a dev-only test helper is never needed by a running server
find "dist/$NAME/node_modules" -name ".cache" -type d -prune -exec rm -rf {} +
# no secrets, ever
if find "dist/$NAME" -maxdepth 1 \( -name 'config.txt' -o -name 'household.json' -o -name 'home-assistant.json' -o -name 'tvs.json' -o -name '*adminsdk*.json' \) | grep -q .; then
  echo "refusing: a personal file got into the bundle"; exit 1
fi
(cd dist && COPYFILE_DISABLE=1 tar -czf "$NAME.tar.gz" "$NAME")
echo "dist/$NAME.tar.gz"
