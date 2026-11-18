#!/bin/bash
# Removes Family Dashboard Server from this Mac.
# Your settings folder (keys, config.txt, household.json) is kept unless you
# answer yes when asked, so a reinstall picks up where you left off.
LABEL="com.familydashboard.server"
APP_HOME="$HOME/Library/Application Support/Family Dashboard"
echo "This removes Family Dashboard Server from this Mac."
read -r -p "Continue? (y/n) " ok
[ "$ok" = "y" ] || [ "$ok" = "Y" ] || exit 0
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
read -r -p "Also delete your settings and keys? (y/n) " all
if [ "$all" = "y" ] || [ "$all" = "Y" ]; then
  rm -rf "$APP_HOME"
  echo "Removed everything."
else
  find "$APP_HOME" -mindepth 1 -maxdepth 1 ! -name Settings -exec rm -rf {} +
  echo "Removed the program. Your settings are still in: $APP_HOME/Settings"
fi
pkgutil --pkgs | grep -q "^$LABEL$" && sudo pkgutil --forget "$LABEL" >/dev/null 2>&1
echo "Done. You can close this window."
