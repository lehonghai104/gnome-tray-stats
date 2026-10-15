#!/usr/bin/env bash
# Install (or uninstall) the Tray Stats GNOME Shell extension for the current user.
#
#   ./install.sh             copy the extension into ~/.local/share/gnome-shell/extensions
#   ./install.sh --link      symlink instead, so edits here apply on the next shell restart
#   ./install.sh --uninstall remove it
set -euo pipefail

UUID=tray-stats@lehonghai104
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [[ "${1:-}" == "--uninstall" ]]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    echo "Removed $DEST"
    exit 0
fi

glib-compile-schemas "$SRC/schemas"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
if [[ "${1:-}" == "--link" ]]; then
    ln -s "$SRC" "$DEST"
else
    cp -r "$SRC" "$DEST"
fi
echo "Installed to $DEST"

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    # The running shell already knows about it (X11 restart or a previous install)
    gnome-extensions enable "$UUID"
    echo "Enabled. If you changed code, restart GNOME Shell (log out and back in on Wayland)."
else
    # A running Wayland session only scans for new extensions at login, so mark
    # it enabled in settings; it will start automatically on the next login.
    current=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ "$current" != *"'$UUID'"* ]]; then
        if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
            gsettings set org.gnome.shell enabled-extensions "['$UUID']"
        else
            gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']"
        fi
    fi
    echo "Log out and back in to load it (GNOME on Wayland can't hot-load new extensions)."
fi
