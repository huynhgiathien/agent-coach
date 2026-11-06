#!/bin/sh
# Install the Agent Coach plugin in every supported agent found (Claude Code, Codex, omp, Cursor).
#   curl -fsSL https://raw.githubusercontent.com/huynhgiathien/agent-coach/main/install.sh | sh
set -eu

REPO="huynhgiathien/agent-coach"
PLUGIN="agent-coach@agent-coach-plugin"
installed=""

if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add "$REPO"
  claude plugin install "$PLUGIN"
  installed="$installed Claude Code"
fi

if command -v codex >/dev/null 2>&1; then
  codex plugin marketplace add "$REPO"
  codex plugin add "$PLUGIN"
  installed="$installed Codex"
fi

if command -v omp >/dev/null 2>&1; then
  omp plugin marketplace add "$REPO"
  omp plugin install "$PLUGIN"
  installed="$installed omp"
fi

if [ -d "$HOME/.cursor" ] || command -v cursor >/dev/null 2>&1; then
  dest="$HOME/.cursor/plugins/local/agent-coach"
  if [ -d "$dest/.git" ]; then git -C "$dest" pull --ff-only
  else mkdir -p "$(dirname "$dest")" && git clone --depth 1 "https://github.com/$REPO" "$dest"; fi
  node "$dest/bin/agent-coach" install-cursor-mcp
  installed="$installed Cursor"
fi

if [ -z "$installed" ]; then
  echo "None of claude, codex, omp or Cursor was found. Install one of them first." >&2
  exit 1
fi

cat <<EOF

Installed for:$installed
No token needed: the plugin reads only local history files.
Restart Cursor, or start a new session in the other CLIs, then try "show my agent usage report".
EOF
