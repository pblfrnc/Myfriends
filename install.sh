#!/bin/sh
# Instala a skill MyFriends no Claude Code, no Codex e no Antigravity (só onde a IDE existir).
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
case " $* " in
  *" --yes "*|*" -y "*) exec node "$DIR/scripts/install.js" "$@" ;;
esac
node "$DIR/scripts/install.js" "$@"
printf "\nInstalar agora? [s/N] "
read -r ans || ans=""
case "$ans" in
  s|S|sim|y|Y|yes) node "$DIR/scripts/install.js" --yes "$@" ;;
  *) echo "Nada foi alterado." ;;
esac
