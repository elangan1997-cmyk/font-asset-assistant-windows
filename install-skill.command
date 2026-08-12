#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
TARGET="$HOME/.codex/skills/psd-image-text-rebuild"
mkdir -p "$HOME/.codex/skills"
rm -rf "$TARGET"
ditto "$SCRIPT_DIR/psd-image-text-rebuild" "$TARGET"
print "Skill installed to $TARGET"
