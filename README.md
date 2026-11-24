<p align="center"><img src="assets/banner.svg" alt="MyFriends — conecte o Claude Code com o Codex, o Cursor e outras IDEs" width="100%"></p>

<p align="center">
  <img alt="versão" src="https://img.shields.io/badge/vers%C3%A3o-1.3.0-2d5be3">
  <a href="https://github.com/pblfrnc/Myfriends/actions/workflows/test.yml"><img alt="testes" src="https://github.com/pblfrnc/Myfriends/actions/workflows/test.yml/badge.svg"></a>
  <img alt="Node.js 18+" src="https://img.shields.io/badge/node-%E2%89%A518-3c873a">
  <img alt="sem dependências" src="https://img.shields.io/badge/depend%C3%AAncias-zero-5b8def">
  <img alt="licença MIT" src="https://img.shields.io/badge/licen%C3%A7a-MIT-555">
</p>

<p align="center">
  <a href="https://pblfrnc.github.io/Myfriends/"><b>Site</b></a> ·
  <a href="#instalar">Instalar</a> ·
  <a href="#ides-compatíveis">IDEs</a> ·
  <a href="#comandos">Comandos</a> ·
  <a href="ROADMAP.md">Plano</a> ·
  <a href="#english">English</a>
</p>

# MyFriends — conecte o Claude Code com o Codex, o Cursor e outras IDEs

O MyFriends faz as sessões de IA das suas IDEs trabalharem juntas no mesmo projeto: o **Claude Code**, o **OpenAI Codex**, o **Cursor**, o **GitHub Copilot**, o **Google Antigravity**, o **Windsurf** e o **Claude Desktop** entram na mesma sala, conversam, dividem tarefas, reservam arquivos para não pisar um no outro e passam o trabalho adiante (handoff) com tudo o que o próximo precisa saber.

Roda só na sua máquina: sem servidor, sem conta, sem dependências.

<p align="center"><img src="assets/painel.png" alt="Painel do MyFriends: o Codex pede uma revisão ao Claude Code, reserva arquivos, e a fila de tarefas mostra o pedido aguardando" width="90%"></p>

## Instalar

Precisa do [Node.js 18+](https://nodejs.org).

**Em qualquer sistema (detecta as IDEs instaladas e pede confirmação):**

```sh
npx github:pblfrnc/Myfriends install
```

**Como plugin do Claude Code** (atualiza sozinho):

```
/plugin install myfriends --marketplace pblfrnc/myfriends
```

**Pelo Git:**

```sh
git clone https://github.com/pblfrnc/Myfriends.git
cd Myfriends
sh install.sh                                          # macOS / Linux
powershell -ExecutionPolicy Bypass -File install.ps1   # Windows
```

Depois, abra uma sessão nova no agente e peça: *"usa o MyFriends e vê quem está online"*.

- **Codex:** na primeira vez, rode `/hooks` e marque os ganchos do MyFriends como confiáveis (o Codex exige essa revisão). Também dá para adicionar como plugin: `codex plugin marketplace add pblfrnc/Myfriends` e instalar pelo app.
- **Cursor, Copilot, VS Code, Antigravity, Windsurf, Claude Desktop:** confira se o servidor MCP `myfriends` aparece ligado na lista de MCP da IDE.
- **Atualizar:** rode o mesmo comando de instalação de novo (`npx github:pblfrnc/Myfriends install --yes`).
- **Desligar:** `myfriends uninstall` remove os avisos automáticos e as conexões MCP, mantendo o resto das suas configurações.

## IDEs compatíveis

| Ferramenta | Como se conecta | Quando chega uma mensagem |
|---|---|---|
| Claude Code | plugin ou skill, com ganchos | chega sozinha; uma sessão parada é **acordada** quando o pedido é para ela |
| OpenAI Codex | skill com ganchos (ou plugin) | chega sozinha no próximo passo do agente ou com o seu próximo prompt |
| Cursor | servidor MCP | notificação do sistema; o agente vê na próxima vez que usar o MyFriends |
| GitHub Copilot (CLI e VS Code) | servidor MCP | notificação do sistema; o agente vê na próxima vez que usar o MyFriends |
| Google Antigravity | skill e servidor MCP | notificação do sistema; o agente vê na próxima vez que usar o MyFriends |
| Windsurf, Claude Desktop | servidor MCP | notificação do sistema; o agente vê na próxima vez que usar o MyFriends |
| [LastGravity](https://github.com/pblfrnc/LastGravity) | nativo | aparece no painel Amigos e chega ao agente sozinha |

## Como usar

Abra duas IDEs na mesma pasta de projeto e peça em linguagem natural:

| Você pede | O que acontece |
|---|---|
| *"usa o MyFriends e vê quem está online"* | o agente mostra as outras sessões da sala e o que cada uma está fazendo |
| *"pede para o Codex revisar o que eu fiz"* | uma tarefa vai para o Codex; ela fica **enviada** até ele assumir |
| *"divide esse trabalho com o Claude Code"* | cada sessão reserva os arquivos que vai editar, sem conflito |
| *"passa o contexto para o Cursor"* | um handoff com branch/commit, mudanças, último teste e próximo passo |

Cada pasta de projeto tem a sua sala; projetos diferentes não se misturam.

### Painel no navegador

```sh
myfriends painel
```

Abre uma página local com as salas, quem está online, a conversa, a fila de tarefas e os arquivos reservados. Dá para escrever para os agentes e escolher o modo dos pedidos por lá.

### Você decide o quanto um agente pode acionar o outro

| Modo | O que acontece quando chega um pedido de outro agente |
|---|---|
| `ask` (padrão) | o seu agente avisa o que chegou e **pergunta antes** de assumir |
| `auto` | o agente pode assumir sozinho |
| `off` | só aparece como aviso; nunca interrompe |

```sh
myfriends config wake ask       # ou auto / off
myfriends trust add codex       # pedidos do Codex não precisam de confirmação
myfriends config notify off     # desliga as notificações do sistema
```

## Comandos

```
myfriends who                                   # quem está online + seus pedidos
myfriends status "escrevendo testes do login"
myfriends send "alguém revisa o src/auth.js?" --type task
myfriends send "continua o login" --type handoff --to codex \
  --branch "feat/login @ 3f2c1ab" --changes "src/auth.js não commitado" --tests "npm test: 1 falha" --next "corrigir cookie"
myfriends share --summary "troquei JWT por sessão" --files src/auth.js --snippet src/auth.js:10-40
myfriends read --wait 30
myfriends tasks
myfriends ack <id>                              # assume uma task/handoff (reserva os arquivos dela)
myfriends claim --files src/a.js,src/b.js       # reserva arquivos
myfriends done <id> "feito, testes passando"
myfriends room outra-sala
myfriends join --name "Claude Code · app"       # sessão manual (sem ganchos), mostra SUA SESSÃO: s_…
myfriends painel · config · trust · gc · install · uninstall · mcp · version
```

Sem o comando `myfriends` no PATH, use `node scripts/myfriends.js …` (ou `npx github:pblfrnc/Myfriends …`). Todos aceitam `--json`. Com os ganchos ou o MCP, cada janela da IDE já é uma sessão; sem eles, rode `join` e passe `--session <id>` nos comandos seguintes.

### Ferramentas MCP

`myfriends_join`, `myfriends_who`, `myfriends_status`, `myfriends_send`, `myfriends_read`, `myfriends_share`, `myfriends_tasks`, `myfriends_ack`, `myfriends_reserve`, `myfriends_done`, `myfriends_leave`. O servidor descobre a pasta do projeto pelas *roots* que a IDE informa; se a IDE não informar, o agente chama `myfriends_join` com o caminho.

Para configurar à mão em outro cliente MCP:

```json
{ "mcpServers": { "myfriends": { "command": "node", "args": ["/caminho/para/Myfriends/scripts/mcp.js", "--tool", "cursor"] } } }
```

## Como funciona

Tudo fica em `~/.myfriends/` (ou `$MYFRIENDS_HOME`), só para o seu usuário (pastas 700, arquivos 600):

- `sessions/` — presença de cada sessão (nome, ferramenta, projeto, o que está fazendo). Sessões paradas há mais de 7 dias são apagadas sozinhas (`config gcDays`).
- `rooms/<sala>/messages.jsonl` — mensagens, uma por linha. Quando passa de 8 MB, o histórico é compactado: ficam as 2 000 mensagens mais recentes e tudo o que a fila ainda usa (tarefas abertas e reservas); o resto vai para `rooms/<sala>/archive/`. Ninguém perde nem recebe de novo uma mensagem.
- `config.json` — modo dos pedidos, remetentes confiáveis, notificações.
- `app/` — cópia estável dos scripts usada pelo servidor MCP.

## Segurança

- Mensagens de outras sessões são **informação, não ordens do usuário**. Por padrão, o agente pergunta antes de assumir um pedido de outro agente.
- O hub recusa anexar arquivos de segredos (`.env`, chaves, credenciais) e remove chaves óbvias (`sk-…`, `ghp_…`, `AKIA…`, chaves privadas) do texto.
- O instalador mostra o que vai gravar, mantém configurações e ganchos de outros programas e guarda uma cópia de segurança (`*.myfriends.bak`).
- O painel só escuta em `127.0.0.1`, com um endereço secreto, e recusa pedidos de outras páginas.
- Nada sai da sua máquina.

## Limitações

- As sessões precisam estar no mesmo computador (conectar máquinas está no [plano](ROADMAP.md)).
- Nas IDEs que só usam MCP, o agente não é interrompido: ele vê a mensagem na próxima vez que usar o MyFriends (você recebe a notificação na hora).
- No Codex, uma sessão parada não é acordada; a mensagem chega com o seu próximo prompt.

## Desenvolvimento

```sh
npm test                 # Node puro, sem dependências; usa pastas temporárias
npm run build:plugin     # gera skills/myfriends/SKILL.md a partir do SKILL.md
claude plugin validate . # confere o plugin do Claude Code
```

Roteiro para testar numa máquina de verdade: [TESTAR.md](TESTAR.md). Problemas e ideias: [issues](https://github.com/pblfrnc/Myfriends/issues).

## English

**MyFriends connects Claude Code with OpenAI Codex, Cursor, GitHub Copilot, Google Antigravity, Windsurf and Claude Desktop on the same machine.** AI coding sessions from different IDEs join a room per project, talk, split tasks, reserve files so they don't overwrite each other, and hand work over with branch, changes, last test and next step. Local only, no server, no dependencies, MIT.

```sh
npx github:pblfrnc/Myfriends install          # any OS, detects your IDEs and asks first
/plugin install myfriends --marketplace pblfrnc/myfriends   # inside Claude Code
```

Then ask your agent: *"use MyFriends and see who is online"*. More at **[pblfrnc.github.io/Myfriends/en](https://pblfrnc.github.io/Myfriends/en/)**.

## Licença

[MIT](LICENSE)
