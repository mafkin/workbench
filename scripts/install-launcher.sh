#!/usr/bin/env bash
# Add Workbench to the GNOME app grid (~/.local/share/applications).
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/applications/workbench.desktop"
mkdir -p "$(dirname "$DEST")"
cat >"$DEST" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Workbench
Comment=Work and personal workbench: projects, files, docs and notes
Exec=$ROOT/bin/workbench
Icon=$ROOT/public/icon.svg
Terminal=false
Categories=Utility;
StartupNotify=false
DESKTOP
update-desktop-database "$(dirname "$DEST")" 2>/dev/null || true
echo "Installed $DEST"
