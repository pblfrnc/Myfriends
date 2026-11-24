# Roteiro de teste manual

Os testes automáticos (`npm test`) rodam no macOS, no Windows e no Linux, mas simulam o que as IDEs enviam. Este roteiro confere o MyFriends nas IDEs de verdade. Leva uns 15 minutos. Anote o resultado de cada passo numa [issue](https://github.com/pblfrnc/Myfriends/issues) com o sistema e as versões.

## Preparação

1. Instale: `npx github:pblfrnc/Myfriends install` e confirme. Anote o que ele encontrou.
2. Crie uma pasta de teste com um arquivo: `mkdir ~/mf-teste && cd ~/mf-teste && echo "# teste" > README.md`.
3. Abra o painel: `myfriends painel`.

## Claude Code + Codex

| Passo | Esperado | ✓ |
|---|---|---|
| Abra o Claude Code em `~/mf-teste` e peça "usa o MyFriends e vê quem está online" | ele responde sem rodar `join` e mostra o próprio id | |
| Abra o Codex na mesma pasta (rode `/hooks` e confie nos ganchos na 1ª vez) e peça o mesmo | aparecem as duas sessões, aqui e no painel | |
| No Codex: "pede para o Claude Code revisar o README" | no Claude Code aparece "📨 MyFriends — …" e uma notificação do sistema | |
| Deixe o Claude Code parado e repita o pedido pelo Codex | o Claude Code é acordado e **pergunta** se pode assumir (modo padrão) | |
| Responda "sim" no Claude Code | a tarefa vira "assumida" no painel | |
| `myfriends config wake auto` e repita | o Claude Code assume sem perguntar | |
| `myfriends config wake off` e repita | só aviso e notificação; o Claude Code não é acordado | |
| Abra uma 2ª janela do Claude Code na mesma pasta | são duas sessões diferentes no painel | |

## IDEs com MCP (Cursor, Copilot, VS Code, Antigravity, Windsurf)

| Passo | Esperado | ✓ |
|---|---|---|
| Abra a IDE em `~/mf-teste` e confira a lista de servidores MCP | `myfriends` aparece ligado | |
| Peça "usa o MyFriends e vê quem está online" | o agente usa `myfriends_who` e vê o Claude Code | |
| Do Claude Code, mande uma tarefa para essa IDE | notificação do sistema na hora; o agente vê na próxima chamada | |
| Feche a IDE | a sessão some do painel | |

## Limpeza e desinstalação

| Passo | Esperado | ✓ |
|---|---|---|
| `myfriends gc --compact` | mostra o que limpou, sem erro | |
| `myfriends uninstall` | remove ganchos e MCP; `~/.claude/settings.json` e os `mcp.json` mantêm o resto | |
| Arquivos `*.myfriends.bak` | existem ao lado das configurações alteradas | |

## Notificações

- **macOS:** se não aparecer, libere em Ajustes do Sistema → Notificações → *Editor de Scripts*.
- **Windows:** aparece como balão na área de notificação.
- **Linux:** precisa do `notify-send` (pacote `libnotify-bin`).
