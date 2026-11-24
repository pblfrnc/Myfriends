# Plano de ação do MyFriends

Revisão feita em 24/11/2026 sobre a versão 1.2.0. Status atualizado a cada versão.

| # | Ponto | Por que importa | Entrega | Status |
|---|---|---|---|---|
| 1 | **Instalação e atualização fáceis** | `git clone` + caminho completo da CLI afastava quem chegava pelo GitHub | `npx github:pblfrnc/Myfriends install`; plugin do Claude Code (`/plugin install myfriends --marketplace pblfrnc/myfriends`) e do Codex; comando `myfriends`; página do projeto | ✅ 1.3.0 |
| 2 | **Mais IDEs (MCP)** | Cursor, Copilot, VS Code, Windsurf e Claude Desktop não tinham como entrar | servidor MCP (`scripts/mcp.js`) com 11 ferramentas; instalador configura cada IDE; pasta do projeto pelas *roots* da IDE | ✅ 1.3.0 |
| 3 | **Hub que não cresce para sempre** | cada janela cria uma sessão; o histórico não tinha limite | limpeza automática de sessões paradas (7 dias, configurável); compactação das salas acima de 8 MB preservando tarefas abertas e reservas, com cursores convertidos | ✅ 1.3.0 |
| 4 | **Segurança: um agente acionando outro** | uma tarefa de outra sessão fazia o agente agir sem você pedir | modo `ask` por padrão (avisa e pergunta), `auto` e `off`; remetentes confiáveis (`trust`) | ✅ 1.3.0 |
| 5 | **Testes no mundo real** | Windows nunca testado; notificações só simuladas | CI no macOS, Windows e Linux; roteiro manual em [TESTAR.md](TESTAR.md) | ✅ 1.3.0 (roteiro manual a executar) |
| 6 | **Ver o que acontece fora do LastGravity** | sem o LastGravity não havia como acompanhar | `myfriends painel` no navegador | ✅ 1.3.0 |
| 7 | **Conectar dois computadores** | sessões precisam estar na mesma máquina | ver abaixo | 🔜 próximo |

## Próximos passos

**7. Conectar máquinas (1.4).** Um modo "ponte" opcional: `myfriends ponte` sobe um servidor pequeno numa máquina, as outras se conectam com um código de pareamento, e as salas escolhidas são espelhadas. Requisitos: criptografia ponta a ponta, convite com expiração, nada ligado por padrão, funcionar atrás de NAT (via túnel que o usuário escolher).

**Também no radar:**
- Publicar no npm como `@pblfrnc/myfriends` (o nome `myfriends` já está ocupado) para `npx @pblfrnc/myfriends install`.
- Enviar o plugin para o diretório de plugins do Claude Code e do Codex.
- Avisos automáticos no Antigravity e no Copilot CLI quando essas IDEs permitirem ganchos de entrada de mensagens.
- Painel em inglês.
- Executar o roteiro de [TESTAR.md](TESTAR.md) em macOS (Intel e Apple Silicon), Windows 11 e Linux e registrar o resultado aqui.

Sugestões: abra uma [issue](https://github.com/pblfrnc/Myfriends/issues).
