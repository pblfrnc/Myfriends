// MyFriends — hub local de sessões de agentes (LastGravity, Claude Code, Codex, Antigravity…).
// Biblioteca SEM dependências, usada pela CLI (myfriends.js) e pelo LastGravity (src/friends.js).
//
// Layout em ~/.myfriends (ou $MYFRIENDS_HOME), pastas 700 e arquivos 600:
//   sessions/<id>.json            presença de cada sessão
//   rooms/<sala>/messages.jsonl   mensagens (append-only, uma linha JSON < 4 KB por mensagem)
//   rooms/<sala>/blobs/<id>.json  conteúdo de mensagens grandes
//   state/<hash>.json             sessão atual por pasta (+ ferramenta), para a CLI
//   cursors/<sessão>.json         até onde cada sessão já leu em cada sala
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VERSION = '1.0.0';
const TOOLS = ['lastgravity', 'claude', 'codex', 'antigravity', 'outro'];
const TOOL_LABEL = { lastgravity: 'LastGravity', claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', outro: 'Agente' };
const TYPES = ['chat', 'context', 'task', 'claim', 'done', 'handoff'];
const LINE_MAX = 3800; // bytes por linha do .jsonl (abaixo de 4 KB, append atômico com O_APPEND)
const MSG_MAX = 1_000_000; // tamanho máximo de uma mensagem (com anexos)
const SNIPPET_MAX = 8000;
const STALE_MS = 10 * 60 * 1000;
const ROOM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SID_RE = /^s_[a-f0-9]{8,32}$/;
const MID_RE = /^m_[a-z0-9]{8,40}$/;

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const rand = (n) => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const t = Date.now() + ms; while (Date.now() < t); } };
let seq = 0;
const newMsgId = () => `m_${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${rand(3)}`;
const err = (msg, code) => Object.assign(new Error(msg), code ? { code } : {});

function defaultHome() { return process.env.MYFRIENDS_HOME || path.join(os.homedir(), '.myfriends'); }

function realDir(p) {
  const abs = path.resolve(p || process.cwd());
  try { return fs.realpathSync.native(abs); } catch { return abs; }
}

const slug = (s, max = 40) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');

// Sala padrão do projeto: nome da pasta + hash curto do caminho real (duas pastas "app" não se misturam).
function projectRoom(folder) {
  const real = realDir(folder);
  const key = process.platform === 'win32' ? real.toLowerCase() : real;
  return `${slug(path.basename(real)) || 'raiz'}-${sha1(key).slice(0, 6)}`;
}
function normRoom(name) {
  const r = String(name || '').trim().toLowerCase();
  if (ROOM_RE.test(r) && !r.includes('..')) return r;
  const s = slug(r, 64);
  if (!s) throw err(`Nome de sala inválido: "${name}". Use letras, números, "-", "_" ou ".".`, 'EINVAL');
  return s;
}

// Remove caracteres de controle (exceto \n e \t) e tira segredos óbvios do texto.
const SECRET_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[abpr]-[A-Za-z0-9-]{10,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{30,})\b/g,
  /\b(glpat-[A-Za-z0-9_-]{16,})\b/g,
];
function scrub(text) {
  let s = String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  let redacted = 0;
  for (const re of SECRET_RES) s = s.replace(re, () => { redacted++; return '[segredo removido]'; });
  return { text: s, redacted };
}
// Arquivos que nunca devem ir para a sala (nem como trecho).
const SECRET_FILE_RE = /(^|[\\/])(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks)|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|\.git-credentials)$/i;
const isSecretFile = (p) => SECRET_FILE_RE.test(String(p || ''));

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return true; // sem pid: só o lastSeen decide
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class Hub {
  constructor({ dir } = {}) {
    this.dir = path.resolve(dir || defaultHome());
    this.staleMs = STALE_MS;
  }

  // ------------------------------------------------------------ arquivos
  p(...xs) { return path.join(this.dir, ...xs); }
  ensureDir(d) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') { try { fs.chmodSync(d, 0o700); } catch {} }
  }
  init() {
    if (this._ready) return this;
    for (const d of [this.dir, this.p('sessions'), this.p('rooms'), this.p('state'), this.p('cursors')]) this.ensureDir(d);
    this._ready = true;
    return this;
  }
  writeAtomic(file, data) {
    this.ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${rand(3)}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    if (process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o600); } catch {} }
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  }
  readJson(file, def = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }

  // Lock simples entre processos: mkdir é atômico. Lock velho (> 10 s) é considerado abandonado.
  withLock(file, fn) {
    const lock = `${file}.lock`;
    const deadline = now() + 8000;
    for (;;) {
      try { fs.mkdirSync(lock, { mode: 0o700 }); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmdirSync(lock); continue; } } catch {}
        if (now() > deadline) throw err('Hub ocupado (lock). Tente de novo.', 'EBUSY');
        sleepSync(5 + Math.random() * 20);
      }
    }
    try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
  }

  // ------------------------------------------------------------ sessões
  sessionFile(id) { if (!SID_RE.test(id || '')) throw err(`Id de sessão inválido: ${id}`, 'EINVAL'); return this.p('sessions', `${id}.json`); }

  join({ id, name, tool, folder, room, pid, doing, kind } = {}) {
    this.init();
    tool = TOOLS.includes(tool) ? tool : 'outro';
    const real = realDir(folder);
    const sid = id && SID_RE.test(id) ? id : `s_${rand(5)}`;
    const prev = this.readJson(this.sessionFile(sid), {}) || {};
    const s = {
      id: sid,
      name: scrub(name || prev.name || `${TOOL_LABEL[tool]} · ${path.basename(real)}`).text.slice(0, 80),
      tool,
      kind: kind || prev.kind || 'agent', // agent | human
      folder: real,
      project: path.basename(real),
      projectRoom: projectRoom(real),
      room: room ? normRoom(room) : prev.room || projectRoom(real),
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      host: os.hostname(),
      startedAt: prev.startedAt || now(),
      lastSeen: now(),
      doing: scrub(doing ?? prev.doing ?? '').text.replace(/\s+/g, ' ').slice(0, 200),
      status: prev.status || 'online',
      version: VERSION,
    };
    this.ensureDir(this.p('rooms', s.room));
    this.writeAtomic(this.sessionFile(sid), JSON.stringify(s, null, 2));
    return s;
  }

  getSession(id) { try { return this.readJson(this.sessionFile(id)); } catch { return null; } }

  touch(id, patch = {}) {
    const s = this.getSession(id);
    if (!s) return null;
    if (patch.doing !== undefined) s.doing = scrub(patch.doing).text.replace(/\s+/g, ' ').slice(0, 200);
    if (patch.status) s.status = String(patch.status).slice(0, 20);
    if (patch.name) s.name = scrub(patch.name).text.slice(0, 80);
    if (patch.room) s.room = normRoom(patch.room);
    s.lastSeen = now();
    this.writeAtomic(this.sessionFile(id), JSON.stringify(s, null, 2));
    return s;
  }

  leave(id) {
    try { fs.unlinkSync(this.sessionFile(id)); } catch {}
    try { fs.unlinkSync(this.p('cursors', `${id}.json`)); } catch {}
  }

  alive(s) { return !!s && now() - (s.lastSeen || 0) <= this.staleMs && pidAlive(s.pid); }

  // Lista sessões vivas e apaga as mortas (pid inexistente ou lastSeen > 10 min).
  sessions({ clean = true } = {}) {
    this.init();
    let files = [];
    try { files = fs.readdirSync(this.p('sessions')).filter((f) => /^s_[a-f0-9]+\.json$/.test(f)); } catch {}
    const out = [];
    for (const f of files) {
      const s = this.readJson(this.p('sessions', f));
      if (s && this.alive(s)) { out.push(s); continue; }
      if (clean) {
        // não apaga arquivos recém-criados que ainda estão sendo escritos
        try { if (!s && now() - fs.statSync(this.p('sessions', f)).mtimeMs < 5000) continue; } catch {}
        const id = f.slice(0, -5);
        try { fs.unlinkSync(this.p('sessions', f)); } catch {}
        try { fs.unlinkSync(this.p('cursors', `${id}.json`)); } catch {}
      }
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  // Encontra uma sessão por id (ou prefixo), nome (contém) ou ferramenta ("claude", "codex"…).
  resolveTarget(to, { room, exclude } = {}) {
    const q = String(to || '').trim();
    if (!q) return null;
    const live = this.sessions().filter((s) => s.id !== exclude);
    const byId = live.filter((s) => s.id === q || (q.startsWith('s_') && s.id.startsWith(q)));
    if (byId.length === 1) return byId[0];
    const lq = q.toLowerCase();
    const pools = [live.filter((s) => !room || s.room === room), live];
    for (const pool of pools) {
      for (const pred of [(s) => s.name.toLowerCase() === lq, (s) => s.tool === lq || TOOL_LABEL[s.tool].toLowerCase() === lq, (s) => s.name.toLowerCase().includes(lq)]) {
        const hits = pool.filter(pred);
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) throw err(`"${q}" combina com ${hits.length} sessões: ${hits.map((s) => `${s.id} (${s.name})`).join(', ')}. Use o id.`, 'EAMBIG');
      }
    }
    throw err(`Nenhuma sessão online combina com "${q}". Veja quem está online com "who".`, 'ENOENT');
  }

  // ------------------------------------------------------------ mensagens
  roomFile(room) { return this.p('rooms', normRoom(room), 'messages.jsonl'); }
  rooms() {
    this.init();
    let names = [];
    try { names = fs.readdirSync(this.p('rooms'), { withFileTypes: true }).filter((e) => e.isDirectory() && ROOM_RE.test(e.name)).map((e) => e.name); } catch {}
    return names.map((name) => {
      let size = 0, mtime = 0;
      try { const st = fs.statSync(this.roomFile(name)); size = st.size; mtime = st.mtimeMs; } catch {}
      return { name, size, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
  }

  // Monta a mensagem; anexos grandes vão para blobs/<id>.json e a linha guarda só um resumo.
  _build(room, from, { to, type = 'chat', text = '', files, snippets, ref, data } = {}) {
    if (!TYPES.includes(type)) throw err(`Tipo inválido: ${type}. Use ${TYPES.join(', ')}.`, 'EINVAL');
    const sender = typeof from === 'string' ? this.getSession(from) : from;
    if (!sender) throw err('Sessão não encontrada: entre na sala com "join" primeiro.', 'ENOSESSION');
    const { text: clean, redacted } = scrub(text);
    let target = null;
    if (to) target = typeof to === 'object' ? to : this.resolveTarget(to, { room, exclude: sender.id });
    const msg = { id: newMsgId(), ts: now(), room, from: sender.id, fromName: sender.name, tool: sender.tool, type, text: clean };
    if (target) { msg.to = target.id; msg.toName = target.name; }
    if (ref) msg.ref = String(ref).slice(0, 60);
    if (Array.isArray(files) && files.length) {
      const bad = files.filter(isSecretFile);
      if (bad.length) throw err(`Não envio arquivos de segredos para a sala: ${bad.join(', ')}`, 'ESECRET');
      msg.files = files.map((f) => String(f).slice(0, 400)).slice(0, 100);
    }
    if (Array.isArray(snippets) && snippets.length) {
      msg.snippets = snippets.slice(0, 20).map((sn) => {
        if (isSecretFile(sn.path)) throw err(`Não envio trechos de arquivos de segredos: ${sn.path}`, 'ESECRET');
        return { path: String(sn.path || '').slice(0, 400), lines: sn.lines ? String(sn.lines).slice(0, 40) : undefined, text: scrub(sn.text).text.slice(0, SNIPPET_MAX) };
      });
    }
    if (data && typeof data === 'object') msg.data = data;
    if (redacted) msg.redacted = redacted;
    let line = JSON.stringify(msg);
    const bytes = Buffer.byteLength(line);
    if (bytes > MSG_MAX) throw err(`Mensagem grande demais (${bytes} bytes; máximo ${MSG_MAX}). Resuma ou cite os caminhos dos arquivos.`, 'E2BIG');
    if (bytes > LINE_MAX) {
      const blob = { id: msg.id, text: msg.text, files: msg.files, snippets: msg.snippets, data: msg.data };
      const bdir = this.p('rooms', room, 'blobs');
      this.ensureDir(bdir);
      this.writeAtomic(path.join(bdir, `${msg.id}.json`), JSON.stringify(blob));
      const short = { ...msg, text: `${msg.text.slice(0, 600)}${msg.text.length > 600 ? '…' : ''}`, blob: `${msg.id}.json`, size: bytes };
      delete short.snippets; delete short.data;
      if (short.files && JSON.stringify(short.files).length > 1500) short.files = short.files.slice(0, 10);
      line = JSON.stringify(short);
      if (Buffer.byteLength(line) > LINE_MAX) { short.text = short.text.slice(0, 200); short.toName = short.toName?.slice(0, 40); delete short.files; line = JSON.stringify(short); }
      return { msg, line };
    }
    return { msg, line };
  }

  _append(room, line) {
    const file = this.roomFile(room);
    this.ensureDir(path.dirname(file));
    const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeSync(fd, `${line}\n`); } finally { fs.closeSync(fd); }
    if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch {} }
  }

  post(room, from, opts = {}) {
    this.init();
    room = normRoom(room);
    const { msg, line } = this._build(room, from, opts);
    this.withLock(this.roomFile(room), () => this._append(room, line));
    return msg;
  }

  // Lê mensagens a partir de um deslocamento (bytes). Linhas incompletas no fim ficam para a próxima leitura.
  readRaw(room, offset = 0) {
    const file = this.roomFile(room);
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return { messages: [], offset: 0 }; }
    try {
      const size = fs.fstatSync(fd).size;
      if (offset > size) offset = 0;
      const len = size - offset;
      if (len <= 0) return { messages: [], offset: size };
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const lastNl = buf.lastIndexOf(10);
      if (lastNl < 0) return { messages: [], offset };
      const messages = [];
      for (const l of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
        if (!l.trim()) continue;
        try { const m = JSON.parse(l); if (m && MID_RE.test(m.id)) messages.push(m); } catch {}
      }
      return { messages, offset: offset + lastNl + 1 };
    } finally { fs.closeSync(fd); }
  }

  expand(msg) {
    if (!msg?.blob || !/^m_[a-z0-9]+\.json$/.test(msg.blob)) return msg;
    const b = this.readJson(this.p('rooms', normRoom(msg.room), 'blobs', msg.blob));
    if (!b) return { ...msg, text: `${msg.text}\n[conteúdo completo indisponível]` };
    const out = { ...msg, text: b.text, files: b.files, snippets: b.snippets, data: b.data };
    delete out.blob;
    return out;
  }

  messages(room, { limit = 100, since, expand = true } = {}) {
    let { messages } = this.readRaw(normRoom(room), 0);
    messages = filterSince(messages, since);
    if (limit) messages = messages.slice(-limit);
    return expand ? messages.map((m) => this.expand(m)) : messages;
  }

  // ------------------------------------------------------------ leitura por sessão (cursor)
  cursorFile(id) { this.sessionFile(id); return this.p('cursors', `${id}.json`); }
  getCursor(id, room) { return (this.readJson(this.cursorFile(id), {}) || {})[room] || 0; }
  setCursor(id, room, offset) {
    const f = this.cursorFile(id);
    const c = this.readJson(f, {}) || {};
    c[room] = offset;
    this.writeAtomic(f, JSON.stringify(c));
  }

  // Novas mensagens para a sessão (exceto as dela mesma). Por padrão: para todos ou para ela.
  readFor(id, { room, since, all = false, mark = true, limit = 200 } = {}) {
    const me = this.getSession(id);
    if (!me) throw err('Sessão não encontrada: entre na sala com "join" primeiro.', 'ENOSESSION');
    room = normRoom(room || me.room);
    let messages, offset;
    if (since !== undefined && since !== null && since !== '') {
      ({ messages, offset } = this.readRaw(room, 0));
      messages = filterSince(messages, since);
    } else {
      ({ messages, offset } = this.readRaw(room, this.getCursor(id, room)));
    }
    const out = messages.filter((m) => m.from !== id && (all || !m.to || m.to === id)).slice(-limit).map((m) => this.expand(m));
    if (mark) this.setCursor(id, room, offset);
    return { room, messages: out };
  }

  // Long-poll: espera até haver mensagens novas (fs.watch + verificação periódica de segurança).
  async waitFor(id, opts = {}, seconds = 30) {
    let r = this.readFor(id, opts);
    if (r.messages.length || !(seconds > 0)) return r;
    const me = this.getSession(id);
    const room = normRoom(opts.room || me.room);
    const dir = this.p('rooms', room);
    this.ensureDir(dir);
    const deadline = now() + Math.min(seconds, 600) * 1000;
    let lastBeat = now();
    return new Promise((resolve) => {
      let watcher = null, timer = null, done = false;
      const finish = (res) => { if (done) return; done = true; clearInterval(timer); try { watcher?.close(); } catch {} resolve(res); };
      const check = () => {
        if (done) return;
        try {
          if (now() - lastBeat > 60000) { this.touch(id); lastBeat = now(); }
          const res = this.readFor(id, { ...opts, since: undefined });
          if (res.messages.length || now() >= deadline) finish(res);
        } catch (e) { finish({ room, messages: [], error: e.message }); }
      };
      try { watcher = fs.watch(dir, () => setTimeout(check, 20)); watcher.on('error', () => {}); } catch {}
      timer = setInterval(check, 400);
    });
  }

  // ------------------------------------------------------------ tarefas e reservas
  // Deriva o quadro de tarefas e as reservas de arquivos a partir das mensagens da sala.
  board(room, live = null) {
    room = normRoom(room);
    const liveIds = new Set((live || this.sessions()).map((s) => s.id));
    const { messages } = this.readRaw(room, 0);
    const tasks = new Map(), claims = new Map();
    for (const m of messages) {
      if (m.type === 'task' || m.type === 'handoff') {
        tasks.set(m.id, { id: m.id, type: m.type, from: m.from, fromName: m.fromName, to: m.to, toName: m.toName, text: m.text, blob: m.blob, ts: m.ts, status: 'open', files: m.files });
      } else if (m.type === 'claim') {
        const t = m.ref && tasks.get(m.ref);
        if (t) { if (t.status === 'open' || (t.status === 'claimed' && !liveIds.has(t.by))) Object.assign(t, { status: 'claimed', by: m.from, byName: m.fromName, claimedAt: m.ts }); }
        if (m.files?.length) claims.set(m.id, { id: m.id, by: m.from, byName: m.fromName, files: m.files, text: m.text, ts: m.ts, task: m.ref || null, active: true });
      } else if (m.type === 'done') {
        const t = m.ref && tasks.get(m.ref);
        if (t && t.status !== 'done') Object.assign(t, { status: 'done', by: m.from, byName: m.fromName, result: m.text, doneAt: m.ts });
        for (const c of claims.values()) if (c.by === m.from && (c.id === m.ref || (m.ref && c.task === m.ref) || !m.ref)) c.active = false;
      }
    }
    for (const t of tasks.values()) if (t.status === 'claimed' && !liveIds.has(t.by)) { t.status = 'open'; t.abandonedBy = t.byName; }
    for (const c of claims.values()) if (c.active && !liveIds.has(c.by)) c.active = false;
    return { tasks: [...tasks.values()], claims: [...claims.values()].filter((c) => c.active) };
  }

  findTask(board, ref) {
    const q = String(ref || '').trim();
    const hits = board.tasks.filter((t) => t.id === q || (q.length >= 6 && t.id.startsWith(q)));
    if (hits.length > 1) throw err(`Id ambíguo: ${q}`, 'EAMBIG');
    return hits[0] || null;
  }

  // Pega uma tarefa (e/ou reserva arquivos) sem duplicar: verificação e escrita dentro do mesmo lock.
  claim(id, { room, ref, files, text, force = false } = {}) {
    const me = this.getSession(id);
    if (!me) throw err('Sessão não encontrada: entre na sala com "join" primeiro.', 'ENOSESSION');
    room = normRoom(room || me.room);
    if (!ref && !(files && files.length)) throw err('Informe o id da tarefa ou os arquivos a reservar (--files).', 'EINVAL');
    return this.withLock(this.roomFile(room), () => {
      const live = this.sessions();
      const b = this.board(room, live);
      let task = null;
      if (ref) {
        task = this.findTask(b, ref);
        if (!task) throw err(`Tarefa não encontrada: ${ref}. Veja "tasks".`, 'ENOENT');
        if (task.status === 'done') throw err(`A tarefa ${task.id} já foi concluída por ${task.byName}.`, 'EDONE');
        if (task.status === 'claimed' && task.by !== id) throw err(`A tarefa ${task.id} já foi pega por ${task.byName} (${task.by}).`, 'ECLAIMED');
        if (task.to && task.to !== id && !force) throw err(`A tarefa ${task.id} foi pedida para ${task.toName}. Use --force se combinaram a troca.`, 'ENOTYOURS');
      }
      const norm = (f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '');
      const fl = (files || []).map(norm).filter(Boolean);
      if (fl.length && !force) {
        const busy = b.claims.filter((c) => c.by !== id).flatMap((c) => c.files.map(norm).filter((f) => fl.includes(f)).map((f) => `${f} (${c.byName})`));
        if (busy.length) throw err(`Arquivos já reservados por outra sessão: ${busy.join(', ')}. Combine na sala ou use --force.`, 'ECONFLICT');
      }
      if (task && task.status === 'claimed' && task.by === id && !fl.length) return { already: true, task, msg: null };
      const { msg, line } = this._build(room, me, { type: 'claim', ref: task?.id, files: fl.length ? fl : undefined, text: text || (task ? `Peguei a tarefa: ${task.text.slice(0, 120)}` : `Vou mexer em: ${fl.join(', ')}`) });
      this._append(room, line);
      return { task, msg };
    });
  }

  done(id, { room, ref, text = '', files } = {}) {
    const me = this.getSession(id);
    if (!me) throw err('Sessão não encontrada: entre na sala com "join" primeiro.', 'ENOSESSION');
    room = normRoom(room || me.room);
    return this.withLock(this.roomFile(room), () => {
      const b = this.board(room);
      let task = null, claimRef = null;
      if (ref) {
        task = this.findTask(b, ref);
        if (!task) {
          const c = b.claims.find((x) => x.id === ref || (String(ref).length >= 6 && x.id.startsWith(ref)));
          if (!c) throw err(`Tarefa ou reserva não encontrada: ${ref}.`, 'ENOENT');
          if (c.by !== id) throw err(`A reserva ${c.id} é de ${c.byName}.`, 'ENOTYOURS');
          claimRef = c.id;
        } else {
          if (task.status === 'done') throw err(`A tarefa ${task.id} já foi concluída por ${task.byName}.`, 'EDONE');
          if (task.status === 'claimed' && task.by !== id) throw err(`A tarefa ${task.id} está com ${task.byName}; só quem pegou conclui.`, 'ECLAIMED');
        }
      }
      const { msg, line } = this._build(room, me, { type: 'done', ref: task?.id || claimRef || undefined, text: text || 'Concluído.', files, to: task && task.from !== id ? this.getSession(task.from) || undefined : undefined });
      this._append(room, line);
      return { task, msg };
    });
  }
}

// "since": id de mensagem (m_…), duração ("10m", "2h", "30s", "1d"), data ISO ou milissegundos.
function parseSince(since) {
  if (since === undefined || since === null || since === '') return null;
  const s = String(since).trim();
  if (/^m_/.test(s)) return { id: s };
  const d = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|min|h|d)$/i);
  if (d) return { ts: now() - Number(d[1]) * { s: 1e3, m: 6e4, min: 6e4, h: 36e5, d: 864e5 }[d[2].toLowerCase()] };
  if (/^\d{10,}$/.test(s)) return { ts: Number(s) };
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return { ts: t };
  throw err(`--since inválido: "${s}". Use um id de mensagem (m_…), "10m", "2h" ou uma data.`, 'EINVAL');
}
function filterSince(messages, since) {
  const p = parseSince(since);
  if (!p) return messages;
  if (p.id) { const i = messages.findIndex((m) => m.id === p.id || m.id.startsWith(p.id)); return i >= 0 ? messages.slice(i + 1) : messages; }
  return messages.filter((m) => m.ts >= p.ts);
}

// ------------------------------------------------------------ formatação curta (para modelos)
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const ago = (ts) => { const s = Math.max(0, Math.round((now() - ts) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`; };

function fmtSession(s, me) {
  const flags = [s.id === me?.id ? 'você' : '', me && s.room === me.room && s.id !== me.id ? 'mesma sala' : '', me && s.folder === me.folder && s.room !== me.room ? 'mesmo projeto' : ''].filter(Boolean);
  return `● ${s.id}  ${s.name}  [${s.tool}${s.kind === 'human' ? ', pessoa' : ''}]  sala ${s.room}${s.doing ? `  — ${s.doing}` : ''}  (visto há ${ago(s.lastSeen)})${flags.length ? `  ‹${flags.join(', ')}›` : ''}`;
}
function fmtMessage(m, meId) {
  const to = m.to ? ` → ${m.to === meId ? 'você' : m.toName}` : '';
  const ref = m.ref ? ` [ref ${m.ref}]` : '';
  let s = `[${m.id}] ${hhmm(m.ts)} ${m.fromName} (${m.tool})${to} · ${m.type}${ref}: ${m.text}`;
  if (m.files?.length) s += `\n    arquivos: ${m.files.join(', ')}`;
  for (const sn of m.snippets || []) s += `\n    --- ${sn.path}${sn.lines ? `:${sn.lines}` : ''}\n${sn.text.split('\n').map((l) => `    ${l}`).join('\n')}`;
  if (m.redacted) s += `\n    (${m.redacted} segredo(s) removido(s) automaticamente)`;
  return s;
}
function fmtBoard(b) {
  const lines = [];
  const st = { open: 'aberta', claimed: 'em andamento', done: 'concluída' };
  if (!b.tasks.length) lines.push('Nenhuma tarefa na sala.');
  for (const t of b.tasks) {
    lines.push(`${t.status === 'done' ? '✔' : t.status === 'claimed' ? '◐' : '○'} ${t.id}  ${st[t.status]}${t.by ? ` (${t.byName})` : ''}  de ${t.fromName}${t.toName ? ` para ${t.toName}` : ''}${t.type === 'handoff' ? ' [handoff]' : ''}: ${t.text.split('\n')[0].slice(0, 160)}${t.abandonedBy ? `  (abandonada por ${t.abandonedBy})` : ''}`);
    if (t.status === 'done' && t.result) lines.push(`    resultado: ${t.result.split('\n')[0].slice(0, 200)}`);
  }
  if (b.claims.length) {
    lines.push('Arquivos reservados:');
    for (const c of b.claims) lines.push(`  ${c.id}  ${c.byName}: ${c.files.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  Hub, VERSION, TOOLS, TOOL_LABEL, TYPES, LINE_MAX, STALE_MS,
  projectRoom, normRoom, realDir, scrub, isSecretFile, parseSince, pidAlive, defaultHome,
  fmtSession, fmtMessage, fmtBoard, sha1,
};
