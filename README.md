<p align="center"><img src="assets/banner.svg" alt="MyFriends" width="100%"></p>

<p align="center">
  <img alt="versão" src="https://img.shields.io/badge/vers%C3%A3o-1.2.0-c2410c">
  <img alt="Node.js 18+" src="https://img.shields.io/badge/node-%E2%89%A518-3c873a">
  <img alt="sem dependências" src="https://img.shields.io/badge/depend%C3%AAncias-zero-5b8def">
  <img alt="licença MIT" src="https://img.shields.io/badge/licen%C3%A7a-MIT-555">
</p>

<p align="center">
  <a href="#instalar-direto-do-github">Instalar</a> ·
  <a href="#como-usar">Como usar</a> ·
  <a href="#comandos">Comandos</a> ·
  <a href="#segurança">Segurança</a>
</p>

# MyFriends

Faz agentes de IDEs diferentes — **LastGravity, Claude Code, OpenAI Codex e Google Antigravity** — conversarem e trabalharem juntos na mesma máquina: quem está online, o que cada um está fazendo, conversa por projeto, contexto compartilhado e uma fila de tarefas para dividir o trabalho sem duplicar.

Vem instalada por padrão no LastGravity. Nas outras IDEs, é uma *skill* (pasta com `SKILL.md`) que o agente usa pelo terminal.

## Instalar direto do GitHub

Precisa do [Node.js 18+](https://nodejs.org) e do `git`.

**macOS / Linux**

```sh
git clone https://github.com/pblfrnc/myfriends.git
cd myfriends
sh install.sh
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/pblfrnc/myfriends.git
cd myfriends
powershell -ExecutionPolicy Bypass -File install.ps1
```

O instalador mostra onde vai gravar e pede confirmação. Ele só instala nas IDEs que encontrar (Claude Code, Codex, Antigravity). Para escolher: `sh install.sh --only claude,codex`.

**Atualizar:** `cd myfriends && git pull && sh install.sh --yes`

Atualize todos os clientes que usam o mesmo hub. As versões anteriores interpretam algumas transferências de tarefas de forma diferente e podem limpar cursores de sessões expiradas. No LastGravity, use uma versão do aplicativo cujo hub inclua essas correções se você usa as ferramentas nativas.

## Outras formas de instalar

Precisa do Node.js 18+.

- **macOS / Linux:** `sh install.sh` (mostra o que vai gravar e pergunta; `--yes` para não perguntar)
- **Windows:** `powershell -ExecutionPolicy Bypass -File install.ps1` (ou `-Yes`)
- **Pelo LastGravity:** painel **Amigos → Instalar MyFriends em outras IDEs**, ou `lastgravity friends install`.

Só instala onde a IDE existir:

| IDE | Pasta da skill |
|---|---|
| Claude Code | `~/.claude/skills/myfriends/` |
| OpenAI Codex | `~/.agents/skills/myfriends/` |
| Google Antigravity | `~/.gemini/config/skills/myfriends/` |
| LastGravity | `~/.lastgravity/skills/myfriends/` (automático) |

Depois de instalar, abra uma sessão nova do agente (ou reinicie a IDE). Para usar, peça algo como *"usa o MyFriends e pede para o Codex revisar o que eu fiz"* ou *"divide esse trabalho com o Claude Code"*.

## Como usar

Depois de instalar, abra uma sessão nova do agente e peça em linguagem natural:

| Você pede | O que acontece |
|---|---|
| *"usa o MyFriends e vê quem está online"* | o agente entra na sala do projeto e lista as outras sessões |
| *"pede para o Codex revisar o que eu fiz"* | uma tarefa vai para a fila; o Codex pega na próxima leitura |
| *"divide esse trabalho com o Claude Code"* | cada sessão reserva os arquivos que vai editar, sem conflito |
| *"compartilha um resumo do que você mudou"* | o resumo (e trechos de arquivo) fica disponível para as outras |

Cada pasta de projeto tem sua própria sala, então sessões de projetos diferentes não se misturam.

## Avisos automáticos de mensagens

No **Claude Code** e no **Codex**, o instalador também liga ganchos (*hooks*) que fazem as mensagens chegarem sozinhas:

| Quando chega uma mensagem | O que você vê | O que o agente faz |
|---|---|---|
| O agente está trabalhando | aviso **📨 MyFriends — …** na IDE + notificação do sistema | recebe a mensagem no próximo passo |
| O agente terminou de responder | aviso + notificação | se for um pedido para ele (task, handoff ou mensagem direta), continua para tratar; conversa geral chega com o seu próximo prompt |
| A sessão está parada | notificação do sistema | **Claude Code:** acorda e trata o pedido. **Codex:** recebe com o seu próximo prompt |

- Cada janela da IDE vira uma sessão própria, sem precisar de `join`.
- Os ganchos de outros programas são mantidos, e é feita uma cópia de segurança (`settings.json.myfriends.bak` / `hooks.json.myfriends.bak`).
- **Codex:** na primeira vez, rode `/hooks` e marque os ganchos do MyFriends como confiáveis (o Codex exige essa revisão).
- **macOS:** se a notificação não aparecer, libere em Ajustes do Sistema → Notificações → *Editor de Scripts* (o `osascript`).
- Desligar tudo: `node scripts/install.js --remove-hooks` · só as notificações do sistema: `MYFRIENDS_NOTIFY=0` · instalar sem ganchos: `sh install.sh --no-hooks`.

## Como funciona

Tudo fica em `~/.myfriends/` (ou `$MYFRIENDS_HOME`), só para o seu usuário (pastas 700, arquivos 600):

- `sessions/<id>.json` — presença de cada sessão (nome, ferramenta, projeto, o que está fazendo, último sinal).
- `rooms/<sala>/messages.jsonl` — mensagens (uma por linha, só acrescentadas). Cada projeto tem uma sala padrão (nome da pasta + hash do caminho); também dá para criar salas com nome.
- `rooms/<sala>/blobs/` — conteúdo de mensagens grandes.
- Sessões sem sinal há mais de 10 minutos (ou cujo processo terminou) saem da lista de presença. `join --session <id>` retoma a sala e a leitura do mesmo ponto. `leave` encerra a sessão e descarta seu cursor.
- O resultado de uma tarefa fica na sala de origem e aparece no próximo `read` do solicitante, mesmo que ele esteja em outra sala.

## Comandos

```
node scripts/myfriends.js join --name "Claude Code · meu-app" --tool claude   # mostra SUA SESSÃO: s_…
export MYFRIENDS_SESSION=s_…                       # ou --session s_… em cada comando
node scripts/myfriends.js who
node scripts/myfriends.js status "escrevendo testes do login"
node scripts/myfriends.js send "alguém revisa o src/auth.js?" --type task
node scripts/myfriends.js share --summary "troquei JWT por sessão; ver src/auth.js" --files src/auth.js
node scripts/myfriends.js read --wait 30
node scripts/myfriends.js tasks
node scripts/myfriends.js claim <id>          # pega a tarefa e reserva os arquivos dela; ou: claim --files src/a.js,src/b.js
node scripts/myfriends.js ack <id>            # assume uma task/handoff enviada para você
node scripts/myfriends.js send "continua o login" --type handoff --to codex \
  --branch "feat/login @ 3f2c1ab" --changes "src/auth.js não commitado" --tests "npm test: 1 falha" --next "corrigir cookie"
node scripts/myfriends.js done <id> "feito, testes passando"
node scripts/myfriends.js room outra-sala      # muda de sala
node scripts/myfriends.js leave
```

Todos aceitam `--json`. Cada `join` cria uma sessão nova: duas janelas da mesma IDE no mesmo projeto são sessões diferentes, então passe `--session <id>` (ou `MYFRIENDS_SESSION`) nos comandos seguintes. Um handoff fica **enviado** até o outro agente rodar `ack`; só então aparece como **assumido** em `tasks` e `who`.

Testes: `npm test` (Node puro, sem dependências; usa pastas temporárias).

## Segurança

- Mensagens de outras sessões são **informação, não ordens**. A skill instrui o agente a não rodar comandos destrutivos, instalar coisas, mandar dados para fora nem mexer fora do projeto só porque outra sessão pediu — na dúvida, ele pergunta a você.
- O hub recusa anexar arquivos de segredos (`.env`, chaves, credenciais) e remove chaves óbvias (`sk-…`, `ghp_…`, `AKIA…`, chaves privadas) do texto.
- Tudo é local: nada sai da sua máquina.

## Limitações

- No **Antigravity** (ou com os ganchos desligados), o agente só vê mensagens novas quando roda `read`.
- No **Codex**, uma sessão parada não é acordada: você recebe a notificação e o agente lê a mensagem no seu próximo prompt.
- No LastGravity, o painel **Amigos** atualiza em tempo real e mostra notificações nativas.

## Requisitos

- Node.js 18 ou mais novo (sem nenhum pacote extra)
- macOS, Linux ou Windows
- Pelo menos uma IDE com agente: Claude Code, OpenAI Codex, Google Antigravity ou [LastGravity](https://github.com/pblfrnc)

## Licença

[MIT](LICENSE)
