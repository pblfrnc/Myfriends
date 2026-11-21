#!/usr/bin/env node
// MyFriends CLI — conecta sessões de agentes de IDEs diferentes na mesma máquina.
// Sem dependências (Node 18+). Uso: node myfriends.js <comando> [opções]   (veja "help")
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./hub');

const HELP = `MyFriends — sessões de agentes conversando na mesma máquina

  join   [--name "Claude Code · projeto"] [--tool claude|codex|antigravity|lastgravity|outro] [--room sala]
  who                                  quem está online (marca mesma sala / mesmo projeto)
  status "<o que estou fazendo>"       atualiza a sua linha de presença
  send   "<texto>" [--to <id|nome|ferramenta>] [--type chat|context|task|handoff] [--files a,b]
  share  --summary "<resumo/decisões>" [--files a,b] [--snippet arquivo:10-40] [--to ...]
  read   [--since <m_id|10m|2h|data>] [--wait 30] [--all]
  tasks                                fila de tarefas da sala e arquivos reservados
  claim  <id-da-tarefa> | claim --files a,b [--note "..."]   (pega/reserva sem duplicar)
  done   <id> "<resultado>"            conclui uma tarefa ou libera uma reserva
  rooms                                salas existentes
  leave                                sai (libera reservas)

Opções gerais: --json  --dir <pasta do projeto>  --session <id>  --tool <ferramenta>
Hub: ${'$'}MYFRIENDS_HOME ou ~/.myfriends`;

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

class Cli {
  constructor(o, out) {
    this.o = o;
    this.out = out;
    this.hub = new H.Hub().init();
    this.folder = H.realDir(o.dir || process.cwd());
    this.stateFile = this.hub.p('state', `${H.sha1(process.platform === 'win32' ? this.folder.toLowerCase() : this.folder).slice(0, 20)}.json`);
    this.tool = detectTool(o);
  }
  state() { return this.hub.readJson(this.stateFile, {}) || {}; }
  saveState(s) {
    const st = this.state();
    st.folder = this.folder;
    st.last = { id: s.id, name: s.name, tool: s.tool, room: s.room };
    st.byTool = { ...(st.byTool || {}), [s.tool]: st.last };
    this.hub.writeAtomic(this.stateFile, JSON.stringify(st, null, 2));
  }
  join(extra = {}) {
    const st = this.state();
    const tool = this.tool || st.last?.tool || 'outro';
    const prev = this.o.session ? { id: this.o.session } : st.byTool?.[tool] || (this.tool ? null : st.last);
    const s = this.hub.join({ id: prev?.id, name: this.o.name || prev?.name, tool, folder: this.folder, room: this.o.room || prev?.room, pid: this.o.pid ? Number(this.o.pid) : undefined, doing: this.o.doing, ...extra });
    this.saveState(s);
    return s;
  }
  // Sessão atual (volta a entrar sozinha se expirou ou se ainda não entrou).
  me() {
    const id = this.o.session || process.env.MYFRIENDS_SESSION;
    if (id) {
      const s = this.hub.getSession(id);
      if (s) return this.hub.touch(id, this.o.room ? { room: this.o.room } : {});
      // Nunca falar em nome de outra sessão: id explícito desconhecido é erro, não "cai" na última sessão.
      throw new Error(`sessão "${id}" não encontrada (expirou ou nunca entrou). Rode "join" de novo ou use --tool.`);
    }
    const st = this.state();
    const prev = (this.tool && st.byTool?.[this.tool]) || (!this.tool && st.last);
    if (prev) {
      const s = this.hub.getSession(prev.id);
      if (s) return this.hub.touch(prev.id, this.o.room ? { room: this.o.room } : {});
    }
    this.autoJoined = true;
    return this.join();
  }
  print(text, json) {
    if (this.o.json) this.out(JSON.stringify(json ?? { text }, null, 2));
    else if (text) this.out(text);
  }
  note() { return this.autoJoined && !this.o.json ? `(entrei automaticamente como ${this._me.id} "${this._me.name}" na sala ${this._me.room})\n` : ''; }

  async run(cmd) {
    const o = this.o;
    const hub = this.hub;
    if (cmd === 'join') {
      const s = this.join();
      const others = hub.sessions().filter((x) => x.id !== s.id);
      const same = others.filter((x) => x.room === s.room);
      return this.print(`Entrou como ${s.id} "${s.name}" [${s.tool}] na sala ${s.room}.\n${same.length ? `Na mesma sala: ${same.map((x) => `${x.name} (${x.id})`).join(', ')}.` : 'Ninguém mais nesta sala ainda.'}${others.length > same.length ? ` Outras ${others.length - same.length} sessão(ões) online em outras salas (veja "who").` : ''}\nPróximos passos: "read" para ver mensagens, "send" para falar, "tasks" para a fila.`, { session: s, others });
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
        return this.print(`${this.note()}Sala: ${me.room} · você: ${me.id}\n${rel.map((s) => H.fmtSession(s, me)).join('\n')}${others ? `\n(+${others} sessão(ões) em outros projetos; use --all)` : ''}`, { me, sessions: o.all ? all : rel });
      }
      case 'status': {
        const text = o._.join(' ');
        const s = hub.touch(me.id, { doing: text, status: o.state || (text ? 'working' : 'online') });
        return this.print(`${this.note()}Status: ${s.doing || '(vazio)'}`, { session: s });
      }
      case 'send': {
        const text = o._.join(' ').trim() || o.text;
        if (!text) throw new Error('Escreva a mensagem: send "texto"');
        const m = hub.post(me.room, me, { text, to: o.to, type: o.type || 'chat', files: list(o.files), ref: o.ref });
        return this.print(`${this.note()}Enviada ${m.id} (${m.type})${m.toName ? ` para ${m.toName}` : ' para a sala'}.${m.redacted ? ` ${m.redacted} segredo(s) foram removidos do texto.` : ''}`, { message: m });
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
        const r = wait ? await hub.waitFor(me.id, { since: o.since, all: !!o.all }, wait) : hub.readFor(me.id, { since: o.since, all: !!o.all });
        const txt = r.messages.length ? r.messages.map((m) => H.fmtMessage(m, me.id)).join('\n') : wait ? `Nenhuma mensagem nova em ${wait} s.` : 'Nenhuma mensagem nova.';
        return this.print(`${this.note()}${txt}`, { room: r.room, messages: r.messages });
      }
      case 'tasks': {
        const b = hub.board(me.room);
        return this.print(`${this.note()}${H.fmtBoard(b)}`, b);
      }
      case 'claim': {
        const r = hub.claim(me.id, { ref: o._[0], files: list(o.files), text: o.note, force: !!o.force });
        return this.print(`${this.note()}${r.already ? `A tarefa ${r.task.id} já é sua.` : r.task ? `Tarefa ${r.task.id} é sua agora. Conclua com: done ${r.task.id} "resultado"` : `Reservado (${r.msg.id}): ${r.msg.files.join(', ')}. Libere com: done ${r.msg.id} "ok"`}`, { task: r.task, message: r.msg });
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
        if (st.byTool) for (const k of Object.keys(st.byTool)) if (st.byTool[k].id === me.id) delete st.byTool[k];
        if (st.last?.id === me.id) delete st.last;
        hub.writeAtomic(this.stateFile, JSON.stringify(st, null, 2));
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
    return e.code === 'ECLAIMED' || e.code === 'ECONFLICT' || e.code === 'EDONE' ? 3 : 1;
  }
}

module.exports = { main, parse, readSnippet };

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
