#!/usr/bin/env node
// MyFriends CLI — conecta sessões de agentes de IDEs diferentes na mesma máquina.
// Sem dependências (Node 18+). Uso: node myfriends.js <comando> [opções]   (veja "help")
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./hub');

const HELP = `MyFriends — sessões de agentes conversando na mesma máquina

  join   [--name "Claude Code · projeto"] [--tool claude|codex|antigravity|lastgravity|outro] [--room sala]
         cria uma sessão NOVA e mostra o id dela; use --session <id> em todos os próximos comandos
         (ou export MYFRIENDS_SESSION=<id>). "join --session <id>" volta para uma sessão existente.
  who                                  quem está online + seus pedidos e o que espera o seu aceite
  status "<o que estou fazendo>"       atualiza a sua linha de presença
  room   [sala]                        mostra a sua sala ou muda para outra
  send   "<texto>" [--to <id|nome|ferramenta>] [--type chat|context|task|handoff] [--files a,b]
         handoff: --branch <branch@commit> --changes "<onde estão as mudanças locais>"
                  --tests "<comando: resultado>" --next "<próximo passo>"
  share  --summary "<resumo/decisões>" [--files a,b] [--snippet arquivo:10-40] [--to ...]
  read   [--since <m_id|10m|2h|data>] [--wait 30] [--all] [--limit 200]
  tasks                                fila da sala (enviada / assumida / concluída) e arquivos reservados
  ack    <id> ["nota"]                 assume uma task/handoff (mesmo que claim <id>)
  claim  <id-da-tarefa> | claim --files a,b [--note "..."]   (pega/reserva sem duplicar)
  done   <id> "<resultado>"            conclui uma tarefa ou libera uma reserva
  rooms                                salas existentes
  leave                                sai (libera reservas)

Opções gerais: --session <id>  --json  --dir <pasta do projeto>  --tool <ferramenta>
Hub: ${'$'}MYFRIENDS_HOME ou ~/.myfriends`;

const HANDOFF_FIELDS = [
  ['branch', 'Branch/commit', /\b(branch|commit|ramo|sha|HEAD)\b|\b[0-9a-f]{7,40}\b/i],
  ['changes', 'Mudanças locais', /(commitad|uncommitted|working tree|stash|mudan[çc]as|altera[çc][õo]es|diff|nada pendente)/i],
  ['tests', 'Último teste', /\b(tests?|testes?|npm test|pytest|jest)\b/i],
  ['next', 'Próximo passo', /(pr[óo]xim|next|falta|pendente)/i],
];

const BOOL = new Set(['json', 'all', 'force', 'help', 'quiet']);
function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') o.help = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (BOOL.has(k)) o[k] = v === undefined ? true : v !== 'false';
      else if (k === 'snippet') (o.snippet ||= []).push(v ?? argv[++i]);
      else o[k] = v ?? argv[++i];
    } else o._.push(a);
  }
  return o;
}
const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : undefined);

function detectTool(o) {
  if (o.tool) return H.TOOLS.includes(o.tool) ? o.tool : 'outro';
  if (process.env.MYFRIENDS_TOOL && H.TOOLS.includes(process.env.MYFRIENDS_TOOL)) return process.env.MYFRIENDS_TOOL;
  if (process.env.CLAUDECODE === '1') return 'claude';
  return null;
}

const sidOf = (o) => o.session || process.env.MYFRIENDS_SESSION || null;

class Cli {
  constructor(o, out) {
    this.o = o;
    this.out = out;
    this.hub = new H.Hub().init();
    this.folder = H.realDir(o.dir || process.cwd());
    this.stateFile = this.hub.p('state', `${H.sha1(process.platform === 'win32' ? this.folder.toLowerCase() : this.folder).slice(0, 20)}.json`);
    this.tool = detectTool(o);
    this.warnings = [];
  }
  // Estado por pasta: sessões criadas pela CLI aqui (mais recente primeiro). Só serve de "plano B"
  // para comandos sem --session; cada janela/instância deve passar o próprio id.
  state() {
    const st = this.hub.readJson(this.stateFile, {}) || {};
    let recent = Array.isArray(st.recent) ? st.recent : [];
    if (!recent.length) recent = [st.last, ...Object.values(st.byTool || {})].filter((x) => x && x.id); // estado da 1.0.0
    const seen = new Set();
    st.recent = recent.filter((x) => x && x.id && !seen.has(x.id) && seen.add(x.id));
    return st;
  }
  saveState(st) {
    st.folder = this.folder;
    delete st.byTool; delete st.last;
    st.recent = st.recent.slice(0, 20);
    this.hub.writeAtomic(this.stateFile, JSON.stringify(st, null, 2));
  }
  remember(s) {
    const st = this.state();
    st.recent = [{ id: s.id, tool: s.tool, name: s.name, at: Date.now() }, ...st.recent.filter((x) => x.id !== s.id && this.hub.getSession(x.id))];
    this.saveState(st);
  }
  join(extra = {}) {
    const id = sidOf(this.o);
    const prev = id ? this.hub.getSession(id) : null;
    const tool = this.tool || prev?.tool || 'outro';
    const s = this.hub.join({ id: id || undefined, name: this.o.name, tool, folder: this.folder, room: this.o.room, pid: this.o.pid ? Number(this.o.pid) : undefined, doing: this.o.doing, ...extra });
    this.resumed = !!prev;
    this.remember(s);
    return s;
  }
  // Sessão atual. Com --session (ou MYFRIENDS_SESSION) é exatamente aquela; sem, usa a sessão mais
  // recente desta ferramenta nesta pasta e avisa se houver mais de uma (janelas diferentes da mesma IDE).
  me() {
    const id = sidOf(this.o);
    const patch = this.o.room ? { room: this.o.room } : {};
    if (id) {
      const s = this.hub.getSession(id);
      if (this.hub.alive(s)) return this.hub.touch(id, patch);
      // Nunca falar em nome de outra sessão: id explícito desconhecido é erro, não "cai" na última sessão.
      throw new Error(`sessão "${id}" não encontrada (expirou ou nunca entrou). Rode "join --session ${id}" para voltar com o mesmo id, ou "join" para uma sessão nova.`);
    }
    const st = this.state();
    const cands = st.recent.filter((x) => !this.tool || x.tool === this.tool).map((x) => this.hub.getSession(x.id)).filter((s) => s && this.hub.alive(s));
    if (cands.length) {
      const s = cands[0];
      if (cands.length > 1) this.warnings.push(`há ${cands.length} sessões ${this.tool || ''} vivas nesta pasta (${cands.map((x) => x.id).join(', ')}); sem --session usei a mais recente, ${s.id} "${s.name}". Se esta não é a sua, passe --session <seu id> (ou export MYFRIENDS_SESSION=<id>).`.replace('  ', ' '));
      return this.hub.touch(s.id, patch);
    }
    this.autoJoined = true;
    return this.join();
  }
  print(text, json) {
    if (this.o.json) this.out(JSON.stringify({ ...(json ?? { text }), ...(this.warnings.length ? { warning: this.warnings.join(' ') } : {}) }, null, 2));
    else if (text) this.out(`${this.warnings.map((w) => `(aviso: ${w})\n`).join('')}${text}`);
  }
  note() { return this.autoJoined && !this.o.json ? `(entrei automaticamente como ${this._me.id} "${this._me.name}" na sala ${this._me.room}; passe --session ${this._me.id} nos próximos comandos)\n` : ''; }

  async run(cmd) {
    const o = this.o;
    const hub = this.hub;
    if (cmd === 'join') {
      const s = this.join();
      const others = hub.sessions().filter((x) => x.id !== s.id);
      const same = others.filter((x) => x.room === s.room);
      const twins = same.filter((x) => x.tool === s.tool && x.folder === s.folder);
      return this.print(`${this.resumed ? 'Voltou' : 'Entrou'} como ${s.id} "${s.name}" [${s.tool}] na sala ${s.room}.
SUA SESSÃO: ${s.id} — passe --session ${s.id} em TODOS os próximos comandos desta janela (ou export MYFRIENDS_SESSION=${s.id}).
${same.length ? `Na mesma sala: ${same.map((x) => `${x.name} (${x.id})`).join(', ')}.` : 'Ninguém mais nesta sala ainda.'}${others.length > same.length ? ` Outras ${others.length - same.length} sessão(ões) online em outras salas (veja "who").` : ''}${twins.length ? `\nAtenção: há outra(s) sessão(ões) ${s.tool} nesta pasta (${twins.map((x) => x.id).join(', ')}); são outras janelas, não você.` : ''}
Próximos passos: "read" para ver mensagens, "send" para falar, "tasks" para a fila.`, { session: s, others, resumed: !!this.resumed });
    }
    if (cmd === 'rooms') {
      const rs = hub.rooms();
      return this.print(rs.length ? rs.map((r) => `${r.name}  (${r.size} bytes, última atividade ${r.mtime ? new Date(r.mtime).toLocaleString('pt-BR') : '—'})`).join('\n') : 'Nenhuma sala ainda.', { rooms: rs });
    }
    const me = this._me = this.me();
    switch (cmd) {
      case 'who': {
        const all = hub.sessions();
        const rel = all.filter((s) => o.all || s.room === me.room || s.folder === me.folder || s.id === me.id);
        const others = all.length - rel.length;
        const b = hub.board(me.room, all);
        const pend = H.fmtPending(b, me.id);
        const sent = b.tasks.filter((t) => t.from === me.id && t.status !== 'done').map((t) => ({ id: t.id, type: t.type, to: t.to || null, status: t.status, by: t.by || null, state: H.acceptState(t) }));
        const awaiting = b.tasks.filter((t) => t.to === me.id && t.status === 'open').map((t) => ({ id: t.id, type: t.type, from: t.from, text: t.text }));
        return this.print(`${this.note()}Sala: ${me.room} · você: ${me.id}\n${rel.map((s) => H.fmtSession(s, me)).join('\n')}${others ? `\n(+${others} sessão(ões) em outros projetos; use --all)` : ''}${pend ? `\n${pend}` : ''}`, { me, sessions: o.all ? all : rel, pending: { sent, awaiting } });
      }
      case 'status': {
        const text = o._.join(' ');
        const s = hub.touch(me.id, { doing: text, status: o.state || (text ? 'working' : 'online') });
        return this.print(`${this.note()}Status: ${s.doing || '(vazio)'}`, { session: s });
      }
      case 'send': {
        let text = o._.join(' ').trim() || o.text;
        if (!text) throw new Error('Escreva a mensagem: send "texto"');
        const type = o.type || 'chat';
        let data;
        if (type === 'handoff') {
          const h = {};
          const extra = [];
          for (const [k, label] of HANDOFF_FIELDS) if (o[k] && o[k] !== true) { h[k] = String(o[k]); extra.push(`- ${label}: ${o[k]}`); }
          if (extra.length) text = `${text}\n${extra.join('\n')}`;
          const missing = HANDOFF_FIELDS.filter(([k, , re]) => !h[k] && !re.test(text)).map(([k, label]) => `${label} (--${k})`);
          if (missing.length) this.warnings.push(`handoff sem: ${missing.join(', ')}. O outro agente precisa disso para continuar; mande um complemento com send --ref <id>.`);
          if (Object.keys(h).length) data = { handoff: h };
        }
        const m = hub.post(me.room, me, { text, to: o.to, type, files: list(o.files), ref: o.ref, data });
        const wait = type === 'task' || type === 'handoff' ? ` Status: enviado, aguardando ${m.toName || 'o outro agente'} assumir (ele roda "ack ${m.id}"). Veja em "tasks"/"who"; não diga ao usuário que foi assumido antes disso.` : '';
        return this.print(`${this.note()}Enviada ${m.id} (${m.type})${m.toName ? ` para ${m.toName}` : ' para a sala'}.${wait}${m.redacted ? ` ${m.redacted} segredo(s) foram removidos do texto.` : ''}`, { message: m, ...(wait ? { state: 'enviado' } : {}) });
      }
      case 'room': {
        const to = o._[0];
        if (!to) return this.print(`${this.note()}Sua sala: ${me.room}${me.room === me.projectRoom ? ' (sala do projeto)' : ` (sala do projeto: ${me.projectRoom})`}`, { room: me.room, projectRoom: me.projectRoom });
        const s = hub.touch(me.id, { room: to });
        return this.print(`${this.note()}Agora você está na sala ${s.room} (${s.id}).`, { session: s });
      }
      case 'share': {
        const summary = o.summary || o._.join(' ').trim();
        if (!summary) throw new Error('Informe o resumo: share --summary "o que fiz / decidi"');
        const snippets = (o.snippet || []).map((spec) => readSnippet(this.folder, spec));
        const m = hub.post(me.room, me, { text: summary, type: 'context', files: list(o.files), snippets, to: o.to });
        return this.print(`${this.note()}Contexto compartilhado: ${m.id}${m.blob ? ' (conteúdo grande guardado em blob)' : ''}.`, { message: m });
      }
      case 'read': {
        const wait = o.wait !== undefined ? Math.max(0, Math.min(600, Number(o.wait) || 0)) : 0;
        const opts = { since: o.since, all: !!o.all, limit: o.limit ? Number(o.limit) : undefined };
        const r = wait ? await hub.waitFor(me.id, opts, wait) : hub.readFor(me.id, opts);
        let txt = r.messages.length ? r.messages.map((m) => H.fmtMessage(m, me.id, r.room)).join('\n') : wait ? `Nenhuma mensagem nova em ${wait} s.` : 'Nenhuma mensagem nova.';
        if (r.more) txt += `\n(há mais ${r.more} mensagens, rode read de novo${o.since ? ' com --since a partir da última' : ''})`;
        return this.print(`${this.note()}${txt}`, { room: r.room, messages: r.messages, more: r.more || 0 });
      }
      case 'tasks': {
        const b = hub.board(me.room);
        return this.print(`${this.note()}${H.fmtBoard(b)}`, b);
      }
      case 'ack':
      case 'claim': {
        const ref = o._[0];
        if (cmd === 'ack' && !ref) throw new Error('Informe o id da task/handoff: ack <m_id> ["nota"]');
        const note = o.note || (cmd === 'ack' ? o._.slice(1).join(' ').trim() || undefined : undefined);
        const r = hub.claim(me.id, { ref, files: list(o.files), text: note, force: !!o.force });
        const files = r.files?.length ? ` Arquivos reservados para você: ${H.fmtFiles(r.files)}.` : '';
        const txt = r.already ? (r.task ? `A tarefa ${r.task.id} já é sua.${files}` : `Esses arquivos já estão reservados para você.`)
          : r.task ? `Tarefa ${r.task.id} assumida por você${r.takeover ? ' (a sessão anterior tinha expirado; a transferência ficou registrada)' : ''}.${files} Conclua com: done ${r.task.id} "resultado"`
          : `Reservado (${r.msg.id}): ${H.fmtFiles(r.msg.files)}. Libere com: done ${r.msg.id} "ok"`;
        return this.print(`${this.note()}${txt}`, { task: r.task, message: r.msg, files: r.files || [], takeover: r.takeover || null, already: !!r.already });
      }
      case 'done': {
        let ref = o._[0], text = o._.slice(1).join(' ');
        if (ref && !/^m_/.test(ref)) { text = o._.join(' '); ref = undefined; }
        const r = hub.done(me.id, { ref, text: text || o.result, files: list(o.files) });
        return this.print(`${this.note()}${r.task ? `Tarefa ${r.task.id} concluída.` : 'Concluído'} (${r.msg.id}).`, { task: r.task, message: r.msg });
      }
      case 'leave': {
        hub.leave(me.id);
        const st = this.state();
        st.recent = st.recent.filter((x) => x.id !== me.id);
        this.saveState(st);
        return this.print(`Saiu da sala (${me.id}).`, { left: me.id });
      }
      default:
        throw new Error(`Comando desconhecido: ${cmd}. Use "help".`);
    }
  }
}

// "--snippet caminho:10-40": trecho de um arquivo do projeto (nunca fora dele, nunca segredos).
function readSnippet(folder, spec) {
  const m = String(spec || '').match(/^(.*?)(?::(\d+)(?:-(\d+))?)?$/);
  const rel = m[1];
  if (H.isSecretFile(rel)) throw new Error(`Não compartilho arquivos de segredos: ${rel}`);
  const abs = path.resolve(folder, rel);
  let real;
  try { real = fs.realpathSync.native(abs); } catch { throw new Error(`Arquivo não encontrado: ${rel}`); }
  if (real !== folder && !real.startsWith(folder + path.sep)) throw new Error(`Arquivo fora do projeto: ${rel}`);
  if (H.isSecretFile(real)) throw new Error(`Não compartilho arquivos de segredos: ${rel}`);
  const lines = fs.readFileSync(real, 'utf8').split('\n');
  const a = m[2] ? Math.max(1, Number(m[2])) : 1;
  const b = m[3] ? Number(m[3]) : m[2] ? a : Math.min(lines.length, 80);
  return { path: rel.replace(/\\/g, '/'), lines: `${a}-${b}`, text: lines.slice(a - 1, b).join('\n') };
}

async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const [cmd, ...rest] = argv;
  const o = parse(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || o.help) { out(HELP); return 0; }
  try {
    await new Cli(o, out).run(cmd);
    return 0;
  } catch (e) {
    if (o.json) out(JSON.stringify({ error: e.message, code: e.code || null }));
    else err(`Erro: ${e.message}`);
    return e.code === 'ECLAIMED' || e.code === 'ECONFLICT' || e.code === 'EDONE' ? 3 : e.code === 'EROOM' ? 4 : 1;
  }
}

module.exports = { main, parse, readSnippet };

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
