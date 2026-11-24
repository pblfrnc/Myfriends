#!/bin/sh
# Instala o MyFriends nas IDEs encontradas: skill (Claude Code, Codex, Antigravity) e MCP (Cursor, Copilot, VS Code…).
#   sh install.sh          mostra o que será gravado e pede confirmação
#   sh install.sh --yes    instala sem perguntar
#   sh install.sh --only claude,codex
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "O MyFriends precisa do Node.js 18 ou mais novo (https://nodejs.org). Instale e rode de novo." >&2
  exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js $MAJOR encontrado; o MyFriends precisa do 18 ou mais novo." >&2
  exit 1
fi
exec node "$DIR/scripts/install.js" "$@"
