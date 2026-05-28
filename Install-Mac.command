#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude/tasker"

echo ""
echo "Installing Tasker to $DEST ..."
echo ""

mkdir -p "$DEST"
cp -r "$DIR/Tasker/." "$DEST/"

echo "Installing Claude Code skills ..."
echo ""

node "$DEST/tasker.js"

echo ""
echo "Done. Reload VS Code (Cmd+Shift+P → Reload Window), then run /tasker in any project."
echo ""
read -p "Press Enter to close..."
