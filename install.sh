#!/bin/sh
# Install the Agent Coach plugin in every supported CLI on PATH (Claude Code, Codex, omp).
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

if [ -z "$installed" ]; then
  echo "None of claude, codex or omp is on PATH. Install one of them first." >&2
  exit 1
fi

cat <<EOF

Installed for:$installed
No token needed: the plugin reads only local history files.
Start a new session and try "show my agent usage report".
EOF
