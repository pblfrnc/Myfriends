# Changelog

## 1.2.0 — 2026-11-21

- **Mensagens chegam sozinhas no Claude Code e no Codex** (ganchos/hooks instalados junto com a skill):
  - aparecem para você como aviso na IDE ("📨 MyFriends — …") e como notificação do sistema (macOS, Windows, Linux);
  - entram na conversa do agente no próximo passo (depois de uma ferramenta ou com o seu próximo prompt);
  - no fim de uma resposta, um pedido para esta sessão (task, handoff ou mensagem direta) faz o agente continuar para tratá-lo;
  - no Claude Code, uma sessão parada é acordada quando chega um pedido para ela.
- Cada janela da IDE vira uma sessão própria automaticamente, sem precisar de `join`.
- `install.sh --no-hooks` instala só a skill; `node scripts/install.js --remove-hooks` desliga os avisos. Os ganchos de outros programas são mantidos e é feita uma cópia de segurança das configurações.
- `MYFRIENDS_NOTIFY=0` desliga só as notificações do sistema.

## 1.1.1 — 2026-11-21

- Sessões expiradas preservam a sala e as mensagens pendentes para a retomada com o mesmo id.
- O histórico de transferências mantém o responsável correto mesmo ao ler registros da versão 1.0.0.
- As reservas de arquivos de uma tarefa continuam ativas até a tarefa terminar, independentemente de outras reservas da mesma sessão.
- `read --wait --since` mantém o filtro durante a espera e preserva o cursor normal.
- A conclusão de uma tarefa aparece no `read` do solicitante mesmo que ele esteja em outra sala.

Atualize os clientes que compartilham o mesmo hub para usar as correções em todas as sessões.

## 1.1.0 — 2026-11-21

Correções encontradas em revisão (cada uma com teste em `test/myfriends.test.js`):

- **Uma sessão por janela:** `join` sempre cria uma sessão nova, com id próprio, e mostra o id. Passe `--session <id>` (ou `MYFRIENDS_SESSION`) nos comandos seguintes; `join --session <id>` volta para a mesma sessão. Sem `--session`, a CLI usa a sessão mais recente da ferramenta na pasta e avisa quando há mais de uma. Duas janelas da mesma IDE não dividem mais nome, cursor de leitura nem reservas.
- **Mensagem direta para outra sala:** `send --to` para uma sessão que está em outra sala agora dá erro (nada é gravado) e diz em qual sala ela está e como entrar. Novo comando `room [sala]`.
- **Sessão que volta não recupera o que foi passado adiante:** quando uma sessão pega a tarefa (ou os arquivos) de outra que expirou, a transferência fica registrada no log; se a antiga voltar, a tarefa e as reservas continuam com a nova, e o `done` da antiga é recusado.
- **`claim <tarefa>` reserva os arquivos da tarefa** no mesmo lock; se algum arquivo estiver com outra sessão viva, nada é pego e a mensagem diz quem está com ele.
- **Reservas grandes completas:** a lista inteira de arquivos é usada na verificação de conflitos (antes só os 10 primeiros); só a exibição corta, com "+N". Limite explícito de 500 arquivos por mensagem.
- **`read` não pula mensagens:** entrega das mais antigas para as mais novas, em lotes de 200, e o cursor avança só até a última entregue ("há mais N mensagens, rode read de novo"). Quem entra numa sala recebe as últimas 50 mensagens do histórico. `--since` não mexe mais no cursor.
- **Handoff com aceite:** o handoff deve trazer branch/commit, onde estão as mudanças locais, o último teste (comando + resultado) e o próximo passo (`--branch`, `--changes`, `--tests`, `--next`; a CLI avisa o que faltar). Novo comando `ack <id>`; `tasks` e `who` mostram "enviado, aguardando" × "assumido por".
- Nomes repetidos ganham sufixo "(2)", "(3)"…

## 1.0.0 — 2026-11-21

- Primeira versão pública.
- Presença de sessões, salas por projeto, mensagens diretas e para a sala.
- Fila de tarefas compartilhada com reserva de arquivos.
- Compartilhamento de resumo e trechos de arquivo, com bloqueio de segredos.
- Instaladores para Claude Code, OpenAI Codex e Google Antigravity (macOS, Linux e Windows).
