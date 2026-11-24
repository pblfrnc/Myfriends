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

const VERSION = '1.3.0';
const TOOLS = ['lastgravity', 'claude', 'codex', 'antigravity', 'cursor', 'copilot', 'vscode', 'windsurf', 'claude-desktop', 'gemini', 'outro'];
const TOOL_LABEL = { lastgravity: 'LastGravity', claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', cursor: 'Cursor', copilot: 'Copilot', vscode: 'VS Code', windsurf: 'Windsurf', 'claude-desktop': 'Claude Desktop', gemini: 'Gemini', outro: 'Agente' };
const TYPES = ['chat', 'context', 'task', 'claim', 'done', 'handoff'];
const LINE_MAX = 3800; // bytes por linha do .jsonl (abaixo de 4 KB, append atômico com O_APPEND)
const MSG_MAX = 1_000_000; // tamanho máximo de uma mensagem (com anexos)
const SNIPPET_MAX = 8000;
const STALE_MS = 10 * 60 * 1000;
const READ_BATCH = 200; // mensagens por "read" (as mais antigas primeiro; o resto fica para o próximo)
const HISTORY = 50; // ao entrar numa sala, a sessão recebe as últimas N mensagens já existentes
// Limpeza: o histórico de uma sala é compactado quando passa deste tamanho; sessões paradas há
// mais de GC_DAYS dias são apagadas. Ajuste com MYFRIENDS_ROOM_MAX_BYTES / config "gcDays".
const ROOM_MAX_DEFAULT = 8 * 1024 * 1024;
const KEEP_TAIL = 2000; // mensagens mais recentes que a compactação sempre mantém
const GC_EVERY_MS = 3600 * 1000;
const CONFIG_DEFAULTS = Object.freeze({ wake: 'ask', trust: [], notify: true, gcDays: 7 });
const WAKE_MODES = ['ask', 'auto', 'off'];
const FILES_MAX = 500; // arquivos por mensagem/reserva
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
const claimPath = (file) => String(file).replace(/\\/g, '/').replace(/^\.\//, '');

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
    if (id && !SID_RE.test(id)) throw err(`Id de sessão inválido: ${id} (formato s_ seguido de 8 a 32 caracteres hexadecimais).`, 'EINVAL');
    const sid = id || `s_${rand(6)}`;
    const prev = this.readJson(this.sessionFile(sid), {}) || {};
    const s = {
      id: sid,
      name: this._uniqueName(scrub(name || prev.name || `${TOOL_LABEL[tool]} · ${path.basename(real)}`).text.slice(0, 80), sid),
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
    if (this.getCursor(sid, s.room) === null) this.initCursor(sid, s.room);
    return s;
  }

  // Duas janelas da mesma IDE no mesmo projeto não ficam com o mesmo nome: a segunda vira "… (2)".
  _uniqueName(name, sid) {
    const taken = new Set(this.sessions({ clean: false }).filter((x) => x.id !== sid).map((x) => x.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) { const c = `${name.slice(0, 74)} (${i})`; if (!taken.has(c)) return c; }
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
    if (patch.room) { this.ensureDir(this.p('rooms', s.room)); if (this.getCursor(id, s.room) === null) this.initCursor(id, s.room); }
    return s;
  }

  leave(id) {
    try { fs.unlinkSync(this.sessionFile(id)); } catch {}
    try { fs.unlinkSync(this.p('cursors', `${id}.json`)); } catch {}
  }

  alive(s) { return !!s && now() - (s.lastSeen || 0) <= this.staleMs && pidAlive(s.pid); }

  // Sessões expiradas saem da lista, mas guardam sala e cursor para uma retomada pelo mesmo id.
  sessions({ clean = true } = {}) {
    this.init();
    if (clean) { try { this.gc(); } catch {} }
    let files = [];
    try { files = fs.readdirSync(this.p('sessions')).filter((f) => /^s_[a-f0-9]+\.json$/.test(f)); } catch {}
    const out = [];
    for (const f of files) {
      const s = this.readJson(this.p('sessions', f));
      if (s) {
        if (this.alive(s)) out.push(s);
        continue;
      }
      if (clean) {
        // Não descarta o cursor se o agente voltar com este id.
        try { if (now() - fs.statSync(this.p('sessions', f)).mtimeMs < 5000) continue; } catch {}
        try { fs.unlinkSync(this.p('sessions', f)); } catch {}
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
  _build(room, from, { to, type = 'chat', text = '', files, snippets, ref, data, takeover, supersedes } = {}) {
    if (!TYPES.includes(type)) throw err(`Tipo inválido: ${type}. Use ${TYPES.join(', ')}.`, 'EINVAL');
    const sender = typeof from === 'string' ? this.getSession(from) : from;
    if (!sender) throw err('Sessão não encontrada: entre na sala com "join" primeiro.', 'ENOSESSION');
    const { text: clean, redacted } = scrub(text);
    let target = null;
    if (to && typeof to === 'object') target = to;
    else if (to) {
      target = this.resolveTarget(to, { room, exclude: sender.id });
      // Mensagem direta só chega se o destinatário estiver nesta sala: nunca "enviar" para onde ele não lê.
      if (target.room !== room) throw err(`Não enviei: ${target.name} (${target.id}) está na sala "${target.room}", não em "${room}". Para falar com essa sessão, entre na sala dela (join --session <seu id> --room ${target.room}, ou room ${target.room}) ou peça para ela entrar na sua (${room}).`, 'EROOM');
    }
    const msg = { id: newMsgId(), ts: now(), room, from: sender.id, fromName: sender.name, tool: sender.tool, type, text: clean };
    if (target) { msg.to = target.id; msg.toName = target.name; }
    if (ref) msg.ref = String(ref).slice(0, 60);
    if (Array.isArray(files) && files.length) {
      const bad = files.filter(isSecretFile);
      if (bad.length) throw err(`Não envio arquivos de segredos para a sala: ${bad.join(', ')}`, 'ESECRET');
      if (files.length > FILES_MAX) throw err(`Arquivos demais numa mensagem (${files.length}; máximo ${FILES_MAX}). Divida em partes ou cite as pastas.`, 'E2BIG');
      msg.files = files.map((f) => String(f).slice(0, 400));
    }
    if (takeover && SID_RE.test(takeover)) msg.takeover = takeover;
    if (Array.isArray(supersedes) && supersedes.length) msg.supersedes = supersedes.filter((x) => MID_RE.test(x)).slice(0, 50);
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
    let size = 0;
    this.withLock(this.roomFile(room), () => { this._append(room, line); try { size = fs.statSync(this.roomFile(room)).size; } catch {} });
    if (size > this.roomMax()) { try { this.compactRoom(room); } catch {} }
    return msg;
  }

  // ------------------------------------------------------------ configuração
  // ~/.myfriends/config.json — wake: ask|auto|off, trust: [ferramentas, nomes ou ids], notify, gcDays.
  config() {
    this.init();
    const c = this.readJson(this.p('config.json'), {}) || {};
    const out = { ...CONFIG_DEFAULTS, ...c };
    if (!WAKE_MODES.includes(out.wake)) out.wake = CONFIG_DEFAULTS.wake;
    out.trust = Array.isArray(out.trust) ? out.trust.map(String).filter(Boolean).slice(0, 100) : [];
    out.notify = out.notify !== false;
    out.gcDays = Math.max(1, Math.min(365, Number(out.gcDays) || CONFIG_DEFAULTS.gcDays));
    return out;
  }
  setConfig(patch = {}) {
    const file = this.p('config.json');
    return this.withLock(file, () => {
      const cur = this.readJson(file, {}) || {};
      const next = { ...cur };
      if (patch.wake !== undefined) {
        if (!WAKE_MODES.includes(patch.wake)) throw err(`wake deve ser ${WAKE_MODES.join(', ')}.`, 'EINVAL');
        next.wake = patch.wake;
      }
      if (patch.notify !== undefined) next.notify = !!patch.notify;
      if (patch.gcDays !== undefined) {
        const n = Number(patch.gcDays);
        if (!(n >= 1 && n <= 365)) throw err('gcDays deve ser entre 1 e 365.', 'EINVAL');
        next.gcDays = n;
      }
      if (patch.trust !== undefined) next.trust = [...new Set(patch.trust.map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
      this.writeAtomic(file, JSON.stringify(next, null, 2));
      return this.config();
    });
  }
  // Remetente confiável: a ferramenta (claude, codex…), o id da sessão ou parte do nome.
  isTrusted(msg, cfg = this.config()) {
    if (!msg) return false;
    return cfg.trust.some((t) => {
      const q = t.toLowerCase();
      return q === String(msg.tool || '').toLowerCase() || q === msg.from || (q.length >= 3 && String(msg.fromName || '').toLowerCase().includes(q));
    });
  }

  // ------------------------------------------------------------ limpeza
  roomMax() { const n = Number(process.env.MYFRIENDS_ROOM_MAX_BYTES); return n > 0 ? n : ROOM_MAX_DEFAULT; }
  epoch(room) { return Number(this.readJson(this.p('rooms', normRoom(room), 'epoch.json'), {})?.epoch) || 0; }

  // Apaga sessões paradas há mais de `days` dias (e os cursores e vigias delas). Roda sozinho no
  // máximo uma vez por hora; `force` roda agora.
  gc({ days, force = false } = {}) {
    this.init();
    const stamp = this.p('state', 'gc.json');
    if (!force) {
      try { if (now() - fs.statSync(stamp).mtimeMs < GC_EVERY_MS) return null; } catch {}
    }
    try { this.writeAtomic(stamp, JSON.stringify({ at: now() })); } catch {}
    const maxAge = (Number(days) || this.config().gcDays) * 86400 * 1000;
    const res = { sessions: 0, cursors: 0, watchers: 0 };
    const keep = new Set();
    let files = [];
    try { files = fs.readdirSync(this.p('sessions')); } catch {}
    for (const f of files) {
      if (!/^s_[a-f0-9]+\.json$/.test(f)) continue;
      const id = f.slice(0, -5);
      const s = this.readJson(this.p('sessions', f));
      if (s && (this.alive(s) || now() - (s.lastSeen || 0) < maxAge)) { keep.add(id); continue; }
      try { fs.unlinkSync(this.p('sessions', f)); res.sessions++; } catch {}
    }
    let cfiles = [];
    try { cfiles = fs.readdirSync(this.p('cursors')); } catch {}
    for (const f of cfiles) {
      const m = f.match(/^(s_[a-f0-9]+)\.json$/);
      if (!m || keep.has(m[1])) continue;
      try { if (now() - fs.statSync(this.p('cursors', f)).mtimeMs < maxAge) continue; fs.unlinkSync(this.p('cursors', f)); res.cursors++; } catch {}
    }
    let sfiles = [];
    try { sfiles = fs.readdirSync(this.p('state')); } catch {}
    for (const f of sfiles) {
      const m = f.match(/^watch-(s_[a-f0-9]+)\.pid$/);
      if (!m) continue;
      try {
        const pid = Number(fs.readFileSync(this.p('state', f), 'utf8'));
        if (!pid || !pidAlive(pid) || !keep.has(m[1])) { fs.unlinkSync(this.p('state', f)); res.watchers++; }
      } catch {}
    }
    return res;
  }

  // Compacta o histórico de uma sala: guarda as últimas KEEP_TAIL mensagens e, das antigas, só o que
  // o quadro ainda precisa (tarefas não concluídas, as reservas delas e reservas ativas). O arquivo
  // antigo vai para rooms/<sala>/archive/. Os cursores de todas as sessões são convertidos para o
  // arquivo novo, então ninguém perde nem recebe de novo mensagens.
  compactRoom(room, { keepTail = KEEP_TAIL } = {}) {
    this.init();
    room = normRoom(room);
    const file = this.roomFile(room);
    return this.withLock(file, () => {
      let buf;
      try { buf = fs.readFileSync(file); } catch { return null; }
      // Linhas com posição original (início/fim em bytes).
      const lines = [];
      let pos = 0;
      while (pos < buf.length) {
        let nl = buf.indexOf(10, pos);
        if (nl < 0) break; // linha incompleta no fim: fica de fora (não deveria acontecer sob o lock)
        const raw = buf.subarray(pos, nl + 1);
        let m = null;
        try { m = JSON.parse(raw.toString('utf8')); } catch {}
        lines.push({ start: pos, end: nl + 1, raw, m: m && MID_RE.test(m.id) ? m : null });
        pos = nl + 1;
      }
      const msgs = lines.filter((l) => l.m);
      if (msgs.length <= keepTail) return { room, kept: msgs.length, dropped: 0 };
      // O que o quadro ainda precisa (sem olhar quem está vivo: isso é decidido na leitura).
      const tasks = new Map(), claimsByTask = new Map(), looseClaims = new Map();
      for (const l of msgs) {
        const m = l.m;
        if (m.type === 'task' || m.type === 'handoff') tasks.set(m.id, { line: l, done: false });
        else if (m.type === 'claim') {
          if (m.ref && tasks.has(m.ref)) { if (!claimsByTask.has(m.ref)) claimsByTask.set(m.ref, []); claimsByTask.get(m.ref).push(l); }
          else looseClaims.set(m.id, { line: l, by: m.from, active: true });
        } else if (m.type === 'done') {
          if (m.ref && tasks.has(m.ref)) tasks.get(m.ref).done = true;
          for (const c of looseClaims.values()) if (c.by === m.from && (!m.ref || m.ref === c.line.m.id)) c.active = false;
        }
      }
      const tailStart = msgs[msgs.length - keepTail].start;
      const keep = new Set();
      for (const l of msgs) if (l.start >= tailStart) keep.add(l);
      for (const [id, t] of tasks) {
        if (t.done) continue;
        keep.add(t.line);
        for (const c of claimsByTask.get(id) || []) keep.add(c);
      }
      for (const c of looseClaims.values()) if (c.active) keep.add(c.line);
      const kept = lines.filter((l) => keep.has(l));
      const out = Buffer.concat(kept.map((l) => l.raw));
      // Conversão de posições: tudo até o fim de uma linha guardada vira o fim dela no arquivo novo.
      const map = [];
      let acc = 0;
      for (const l of kept) { acc += l.raw.length; map.push([l.end, acc]); }
      const translate = (off) => {
        if (!Number.isInteger(off) || off <= 0) return 0;
        let lo = 0, hi = map.length - 1, best = 0;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (map[mid][0] <= off) { best = map[mid][1]; lo = mid + 1; } else hi = mid - 1; }
        return best;
      };
      // Trava os cursores de todas as sessões que leem esta sala antes de trocar o arquivo.
      let cfiles = [];
      try { cfiles = fs.readdirSync(this.p('cursors')).filter((f) => /^s_[a-f0-9]+\.json$/.test(f)); } catch {}
      const locks = [];
      try {
        for (const f of cfiles) {
          const lock = `${this.p('cursors', f)}.lock`;
          const deadline = now() + 8000;
          for (;;) {
            try { fs.mkdirSync(lock, { mode: 0o700 }); locks.push(lock); break; } catch (e) {
              if (e.code !== 'EEXIST') break;
              try { if (now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmdirSync(lock); continue; } } catch {}
              if (now() > deadline) throw err('Hub ocupado (lock). Tente de novo.', 'EBUSY');
              sleepSync(5 + Math.random() * 20);
            }
          }
        }
        const adir = this.p('rooms', room, 'archive');
        this.ensureDir(adir);
        const ep = this.epoch(room) + 1;
        fs.copyFileSync(file, path.join(adir, `messages-${ep - 1}-${now()}.jsonl`));
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, out, { mode: 0o600 });
        fs.renameSync(tmp, file);
        this.writeAtomic(this.p('rooms', room, 'epoch.json'), JSON.stringify({ epoch: ep, at: now() }));
        for (const f of cfiles) {
          const cf = this.p('cursors', f);
          const c = this.readJson(cf, null);
          if (!c) continue;
          let changed = false;
          if (Number.isInteger(c[room])) { c[room] = translate(c[room]); changed = true; }
          if (c.$results && Number.isInteger(c.$results[room])) { c.$results[room] = translate(c.$results[room]); changed = true; }
          if (changed) this.writeAtomic(cf, JSON.stringify(c));
        }
        // Blobs de mensagens que saíram do arquivo ativo.
        const keptIds = new Set(kept.filter((l) => l.m).map((l) => l.m.id));
        let blobs = [];
        try { blobs = fs.readdirSync(this.p('rooms', room, 'blobs')); } catch {}
        for (const b of blobs) { const id = b.replace(/\.json$/, ''); if (!keptIds.has(id)) { try { fs.renameSync(this.p('rooms', room, 'blobs', b), path.join(adir, b)); } catch {} } }
        // Arquivos antigos: guarda os 3 mais recentes.
        const olds = fs.readdirSync(adir).filter((f) => /^messages-\d+-\d+\.jsonl$/.test(f)).sort((a, b) => Number(a.split('-')[2].split('.')[0]) - Number(b.split('-')[2].split('.')[0]));
        for (const f of olds.slice(0, -3)) { try { fs.unlinkSync(path.join(adir, f)); } catch {} }
        return { room, kept: keptIds.size, dropped: msgs.length - keptIds.size, epoch: ep, before: buf.length, after: out.length };
      } finally {
        for (const l of locks) { try { fs.rmdirSync(l); } catch {} }
      }
    });
  }

  // Lê mensagens a partir de um deslocamento (bytes). Linhas incompletas no fim ficam para a próxima leitura.
  readRaw(room, offset = 0) {
    const file = this.roomFile(room);
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return { messages: [], ends: [], offset: 0 }; }
    try {
      const size = fs.fstatSync(fd).size;
      if (offset > size) offset = 0;
      const len = size - offset;
      if (len <= 0) return { messages: [], ends: [], offset: size };
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const lastNl = buf.lastIndexOf(10);
      if (lastNl < 0) return { messages: [], ends: [], offset };
      // ends[i] = posição (bytes) logo depois da linha da mensagem i: o cursor pode parar no meio do lote.
      const messages = [], ends = [];
      let pos = 0;
      while (pos <= lastNl) {
        const nl = buf.indexOf(10, pos);
        const l = buf.subarray(pos, nl).toString('utf8');
        pos = nl + 1;
        if (!l.trim()) continue;
        try { const m = JSON.parse(l); if (m && MID_RE.test(m.id)) { messages.push(m); ends.push(offset + pos); } } catch {}
      }
      return { messages, ends, offset: offset + lastNl + 1 };
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
  // null = esta sessão ainda não tem cursor nesta sala.
  getCursor(id, room) { const v = (this.readJson(this.cursorFile(id), {}) || {})[room]; return Number.isInteger(v) && v >= 0 ? v : null; }
  setCursor(id, room, offset) {
    const file = this.cursorFile(id);
    return this.withLock(file, () => {
      const cursors = this.readJson(file, {}) || {};
      cursors[room] = offset;
      this.writeAtomic(file, JSON.stringify(cursors));
    });
  }
  // Primeiro cursor numa sala: começa nas últimas HISTORY mensagens; tudo o que chegar depois é entregue.
  initialOffset(room) {
    const { ends } = this.readRaw(room, 0);
    return ends.length > HISTORY ? ends[ends.length - HISTORY - 1] : 0;
  }
  initCursor(id, room) {
    const file = this.cursorFile(id);
    return this.withLock(file, () => {
      const cursors = this.readJson(file, {}) || {};
      if (Number.isInteger(cursors[room]) && cursors[room] >= 0) return cursors[room];
      cursors[room] = this.initialOffset(room);
      this.writeAtomic(file, JSON.stringify(cursors));
      return cursors[room];
    });
  }

  // Novas mensagens para a sessão (exceto as dela mesma). Por padrão: para todos ou para ela.
  // Entrega das mais antigas para as mais novas, no máximo `limit` (e ~maxChars) por vez; o cursor
  // avança só até a última entregue e `more` diz quantas ainda faltam.
  readFor(id, { room, since, all = false, mark = true, limit = READ_BATCH, maxChars = 0 } = {}) {
    limit = Math.max(1, Math.min(1000, Number(limit) || READ_BATCH));
    const wanted = (m) => m.from !== id && (all || !m.to || m.to === id);
    const sizeOf = (m) => (m.text || '').length + JSON.stringify(m.files || []).length + (m.snippets || []).reduce((n, sn) => n + sn.text.length + 40, 0) + 80;
    const getRoom = () => {
      const me = this.getSession(id);
      if (!me) throw err('Sessão não encontrada: entre na sala com "join" primeiro.', 'ENOSESSION');
      return normRoom(room || me.room);
    };
    if (since !== undefined && since !== null && since !== '') {
      // Consulta pelo histórico: não mexe no cursor.
      const room = getRoom();
      const list = filterSince(this.readRaw(room, 0).messages, since).filter(wanted);
      const out = [];
      let chars = 0;
      for (const m of list) {
        if (out.length >= limit) break;
        const full = this.expand(m);
        if (maxChars && out.length && chars + sizeOf(full) > maxChars) break;
        out.push(full); chars += sizeOf(full);
      }
      return { room, messages: out, more: list.length - out.length };
    }
    const file = this.cursorFile(id);
    const read = () => {
      const room = getRoom();
      const cursors = this.readJson(file, {}) || {};
      const results = cursors.$results || {};
      const isResult = (m) => m.type === 'done' && m.to === id && m.from !== id;
      const out = [];
      let more = 0, chars = 0;

      // O resultado existe apenas na sala da tarefa. Cada sala visitada tem um cursor
      // separado para esses avisos, de modo que lê-los de fora não consome a conversa.
      const readRoom = (source, start, include) => {
        const { messages, ends, offset } = this.readRaw(source, start);
        let next = offset;
        for (let i = 0; i < messages.length; i++) {
          if (!include(messages[i], ends[i])) continue;
          if (!more && out.length < limit) {
            const full = this.expand(messages[i]);
            const size = maxChars ? sizeOf(full) : 0;
            if (!maxChars || !out.length || chars + size <= maxChars) {
              out.push(full);
              chars += size;
              continue;
            }
          }
          if (next === offset) next = i > 0 ? ends[i - 1] : Math.min(start, offset);
          more++;
        }
        return next;
      };

      // Avisos diretos chegam mesmo se o solicitante estiver em outra sala ou voltar
      // depois de expirar. Uma segunda leitura na sala de origem não os repete.
      for (const origin of Object.keys(cursors)) {
        if (origin === room || !ROOM_RE.test(origin) || !Number.isInteger(cursors[origin])) continue;
        const start = Math.max(cursors[origin], results[origin] || 0);
        results[origin] = readRoom(origin, start, isResult);
      }
      const start = cursors[room] ?? this.initialOffset(room);
      cursors[room] = readRoom(room, start, (m, end) => wanted(m) && (!isResult(m) || end > (results[room] || 0)));
      if (mark) this.writeAtomic(file, JSON.stringify({ ...cursors, $results: results }));
      return { room, messages: out, more };
    };
    return mark ? this.withLock(file, read) : read();
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
    return new Promise((resolve, reject) => {
      let watcher = null, timer = null, done = false;
      const finish = (res, error) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        try { watcher?.close(); } catch {}
        if (error) reject(error);
        else resolve(res);
      };
      const check = () => {
        if (done) return;
        try {
          if (now() - lastBeat > 60000) { this.touch(id); lastBeat = now(); }
          const res = this.readFor(id, opts);
          if (res.messages.length || now() >= deadline) finish(res);
        } catch (e) { finish(null, e); }
      };
      try { watcher = fs.watch(dir, () => setTimeout(check, 20)); watcher.on('error', () => {}); } catch {}
      timer = setInterval(check, 400);
    });
  }

  // ------------------------------------------------------------ tarefas e reservas
  // Deriva o quadro de tarefas e as reservas de arquivos a partir das mensagens da sala.
  // Regras (o log é a fonte da verdade, então uma sessão que volta não "recupera" o que foi passado adiante):
  //  - claim de tarefa aberta (ou da própria) → a tarefa é de quem pegou e os arquivos dela ficam reservados;
  //  - claim de outro dono no log transfere a tarefa, inclusive em logs anteriores a "takeover";
  //  - claim com "supersedes" → as reservas listadas (de sessões que expiraram) deixam de valer para sempre;
  //  - done → conclui a tarefa e libera as reservas de quem concluiu.
  board(room, live = null) {
    const b = this._board(room, live);
    return { tasks: b.tasks, claims: b.claims };
  }

  _board(room, live = null) {
    room = normRoom(room);
    const liveIds = new Set((live || this.sessions()).map((s) => s.id));
    const { messages } = this.readRaw(room, 0);
    const tasks = new Map(), claims = new Map();
    for (let m of messages) {
      // Linhas grandes guardam só um resumo: a lista completa de arquivos está no blob.
      if (m.blob && (m.type === 'task' || m.type === 'handoff' || m.type === 'claim')) m = this.expand(m);
      if (m.type === 'task' || m.type === 'handoff') {
        tasks.set(m.id, { id: m.id, type: m.type, from: m.from, fromName: m.fromName, to: m.to, toName: m.toName, text: m.text, ts: m.ts, status: 'open', files: m.files });
      } else if (m.type === 'claim') {
        for (const cid of m.supersedes || []) { const c = claims.get(cid); if (c) { c.active = false; c.supersededBy = m.id; } }
        const t = m.ref && tasks.get(m.ref);
        const files = new Set((m.files || []).map(claimPath));
        if (t && t.status !== 'done') {
          const previous = t.by || m.takeover;
          if (previous && previous !== m.from) {
            t.takeoverFrom = previous;
            t.takeoverFromName = t.byName;
            for (const c of claims.values()) {
              if (c.by === previous && c.task === t.id) { c.active = false; c.supersededBy = m.id; }
            }
          }
          Object.assign(t, { status: 'claimed', by: m.from, byName: m.fromName, claimedAt: m.ts });

          // Logs antigos podiam omitir arquivos já reservados pelo mesmo agente
          // em outra tarefa ou em uma reserva avulsa. A tarefa tem sua própria reserva.
          const reserved = new Set([...claims.values()]
            .filter((c) => c.active && c.by === m.from && c.task === t.id)
            .flatMap((c) => c.files));
          for (const file of (t.files || []).map(claimPath)) {
            if (!reserved.has(file)) files.add(file);
          }
        }
        if (files.size) claims.set(m.id, { id: m.id, by: m.from, byName: m.fromName, files: [...files], text: m.text, ts: m.ts, task: m.ref || null, active: true });
      } else if (m.type === 'done') {
        const t = m.ref && tasks.get(m.ref);
        if (t && t.status !== 'done') Object.assign(t, { status: 'done', by: m.from, byName: m.fromName, result: m.text, doneAt: m.ts });
        for (const c of claims.values()) {
          if (c.by !== m.from) continue;
          if (c.task ? c.task === m.ref : !m.ref || c.id === m.ref) c.active = false;
        }
      }
    }
    for (const t of tasks.values()) {
      // enviado (ninguém assumiu) → assumido (claim/ack do outro agente) → concluido
      if (t.status === 'claimed' && !liveIds.has(t.by)) {
        Object.assign(t, { status: 'open', abandonedBy: t.byName, abandonedById: t.by });
        delete t.by; delete t.byName; delete t.claimedAt;
      }
      t.acceptance = t.status === 'done' ? 'concluido' : t.status === 'claimed' ? 'assumido' : 'enviado';
    }
    const dormant = [];
    for (const c of claims.values()) if (c.active && !liveIds.has(c.by)) { c.active = false; dormant.push(c); }
    return { tasks: [...tasks.values()], claims: [...claims.values()].filter((c) => c.active), dormant, liveIds };
  }

  findTask(board, ref) {
    const q = String(ref || '').trim();
    const hits = board.tasks.filter((t) => t.id === q || (q.length >= 6 && t.id.startsWith(q)));
    if (hits.length > 1) throw err(`Id ambíguo: ${q}`, 'EAMBIG');
    return hits[0] || null;
  }

  // Pega uma tarefa (e reserva os arquivos dela) e/ou reserva arquivos, sem duplicar:
  // verificação e escrita dentro do mesmo lock. Se algum arquivo está com outra sessão viva, nada é gravado.
  claim(id, { room, ref, files, text, force = false } = {}) {
    const me = this.getSession(id);
    if (!me) throw err('Sessão não encontrada: entre na sala com "join" primeiro.', 'ENOSESSION');
    room = normRoom(room || me.room);
    if (!ref && !(files && files.length)) throw err('Informe o id da tarefa ou os arquivos a reservar (--files).', 'EINVAL');
    return this.withLock(this.roomFile(room), () => {
      const live = this.sessions();
      const b = this._board(room, live);
      let task = null, takeover;
      if (ref) {
        task = this.findTask(b, ref);
        if (!task) {
          const other = this.messages(room, { limit: 0, expand: false }).find((m) => m.id === ref || (String(ref).length >= 6 && m.id.startsWith(ref)));
          if (other) throw err(`A mensagem ${other.id} é do tipo "${other.type}"; só dá para pegar/assumir mensagens "task" ou "handoff".`, 'EINVAL');
          throw err(`Tarefa não encontrada: ${ref}. Veja "tasks".`, 'ENOENT');
        }
        if (task.status === 'done') throw err(`A tarefa ${task.id} já foi concluída por ${task.byName}.`, 'EDONE');
        if (task.status === 'claimed' && task.by !== id) throw err(`A tarefa ${task.id} já foi pega por ${task.byName} (${task.by}).`, 'ECLAIMED');
        if (task.to && task.to !== id && !force) throw err(`A tarefa ${task.id} foi pedida para ${task.toName}. Use --force se combinaram a troca.`, 'ENOTYOURS');
        // Dono anterior expirou: a transferência fica registrada e ele não recupera a tarefa se voltar.
        if (task.status === 'open' && task.abandonedById && task.abandonedById !== id) takeover = task.abandonedById;
      }
      const fl = [...new Set([...(files || []), ...(task?.files || [])].map(claimPath).filter(Boolean))];
      if (fl.length && !force) {
        const busy = [];
        for (const c of b.claims) {
          if (c.by === id) continue;
          const mine = new Set(c.files);
          for (const f of fl) if (mine.has(f)) busy.push(`${f} (${c.byName}, ${c.by})`);
        }
        if (busy.length) {
          const what = task ? `Não peguei a tarefa ${task.id}: os arquivos dela já estão reservados por outra sessão` : 'Arquivos já reservados por outra sessão';
          throw err(`${what}: ${fmtFiles(busy, 10)}. Combine na sala ou use --force.`, 'ECONFLICT');
        }
      }
      // Uma reserva só serve para a tarefa que a criou ou para o escopo avulso.
      const scope = task?.id || null;
      const mineNow = new Set(b.claims.filter((c) => c.by === id && c.task === scope).flatMap((c) => c.files));
      const add = fl.filter((f) => !mineNow.has(f));
      if (task && task.status === 'claimed' && task.by === id && !add.length) return { already: true, task, msg: null, files: fl };
      if (!task && !add.length) return { already: true, task: null, msg: null, files: fl };
      const addSet = new Set(add);
      const supersedes = b.dormant.filter((c) => (task && c.task === task.id) || c.files.some((f) => addSet.has(f))).map((c) => c.id);
      const { msg, line } = this._build(room, me, {
        type: 'claim', ref: task?.id, files: add.length ? add : undefined, takeover, supersedes,
        text: text || (task ? `Assumi a tarefa: ${task.text.slice(0, 120)}` : `Vou mexer em: ${fmtFiles(add, 10)}`),
      });
      this._append(room, line);
      return { task, msg, files: fl, takeover: takeover || null };
    });
  }

  done(id, { room, ref, text = '', files } = {}) {
    const me = this.getSession(id);
    if (!me) throw err('Sessão não encontrada: entre na sala com "join" primeiro.', 'ENOSESSION');
    room = normRoom(room || me.room);
    return this.withLock(this.roomFile(room), () => {
      const b = this._board(room);
      let task = null, claimRef = null;
      if (ref) {
        task = this.findTask(b, ref);
        if (!task) {
          const c = b.claims.find((x) => x.id === ref || (String(ref).length >= 6 && x.id.startsWith(ref)));
          if (!c) throw err(`Tarefa ou reserva não encontrada (ou não está mais ativa): ${ref}.`, 'ENOENT');
          if (c.by !== id) throw err(`A reserva ${c.id} é de ${c.byName}.`, 'ENOTYOURS');
          if (c.task) throw err(`A reserva pertence à tarefa ${c.task}. Use "done ${c.task}" para concluir a tarefa e liberar os arquivos.`, 'EINVAL');
          claimRef = c.id;
        } else {
          if (task.status === 'done') throw err(`A tarefa ${task.id} já foi concluída por ${task.byName}.`, 'EDONE');
          if (task.status === 'claimed' && task.by !== id) throw err(`A tarefa ${task.id} está com ${task.byName}; só quem pegou conclui.`, 'ECLAIMED');
          if (task.status === 'open' && task.takeoverFrom === id) throw err(`A tarefa ${task.id} foi assumida por outra sessão enquanto a sua estava expirada; não é mais sua.`, 'ECLAIMED');
        }
      }
      // O solicitante pode estar em outra sala ou offline. O id do autor no log
      // basta para endereçar o aviso sem duplicar o evento que conclui a tarefa.
      const to = task && task.from !== id ? { id: task.from, name: task.fromName } : undefined;
      const { msg, line } = this._build(room, me, { type: 'done', ref: task?.id || claimRef || undefined, text: text || 'Concluído.', files, to });
      this._append(room, line);
      return { task, msg };
    });
  }
}

// Lista de arquivos para exibição: corta no texto (a lista guardada é sempre completa).
function fmtFiles(files, max = 10) {
  const fs_ = files || [];
  return fs_.length > max ? `${fs_.slice(0, max).join(', ')} (+${fs_.length - max})` : fs_.join(', ');
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
function fmtMessage(m, meId, room) {
  const to = m.to ? ` → ${m.to === meId ? 'você' : m.toName}` : '';
  const ref = m.ref ? ` [ref ${m.ref}]` : '';
  const origin = room && m.room !== room ? ` [sala ${m.room}]` : '';
  let s = `[${m.id}] ${hhmm(m.ts)} ${m.fromName} (${m.tool})${to} · ${m.type}${ref}${origin}: ${m.text}`;
  if (m.files?.length) s += `\n    arquivos: ${fmtFiles(m.files, 20)}`;
  for (const sn of m.snippets || []) s += `\n    --- ${sn.path}${sn.lines ? `:${sn.lines}` : ''}\n${sn.text.split('\n').map((l) => `    ${l}`).join('\n')}`;
  if (m.redacted) s += `\n    (${m.redacted} segredo(s) removido(s) automaticamente)`;
  return s;
}
// Estado de aceite: "enviado" ≠ "assumido". Só um claim/ack do outro agente muda para assumido.
function acceptState(t) {
  if (t.status === 'done') return `concluída por ${t.byName}`;
  if (t.status === 'claimed') return `assumida por ${t.byName}${t.takeoverFromName ? ` (transferida de ${t.takeoverFromName}, que expirou)` : ''}`;
  return `enviada, aguardando ${t.toName || 'alguém'} assumir${t.abandonedBy ? ` (${t.abandonedBy} tinha assumido e expirou)` : ''}`;
}
function fmtBoard(b) {
  const lines = [];
  if (!b.tasks.length) lines.push('Nenhuma tarefa na sala.');
  for (const t of b.tasks) {
    lines.push(`${t.status === 'done' ? '✔' : t.status === 'claimed' ? '◐' : '○'} ${t.id}  ${t.type === 'handoff' ? '[handoff] ' : ''}${acceptState(t)}  · de ${t.fromName}${t.toName ? ` para ${t.toName}` : ''}: ${t.text.split('\n')[0].slice(0, 160)}`);
    if (t.files?.length) lines.push(`    arquivos: ${fmtFiles(t.files)}`);
    if (t.status === 'done' && t.result) lines.push(`    resultado: ${t.result.split('\n')[0].slice(0, 200)}`);
  }
  if (b.claims.length) {
    lines.push('Arquivos reservados:');
    for (const c of b.claims) lines.push(`  ${c.id}  ${c.byName}${c.task ? ` (tarefa ${c.task})` : ''}: ${fmtFiles(c.files)}`);
  }
  return lines.join('\n');
}
// Pedidos que esta sessão enviou e ainda não foram concluídos, e os que esperam o aceite dela.
function fmtPending(b, meId) {
  const lines = [];
  const sent = b.tasks.filter((t) => t.from === meId && t.status !== 'done');
  const forMe = b.tasks.filter((t) => t.to === meId && t.status === 'open');
  if (sent.length) {
    lines.push('Seus pedidos (task/handoff):');
    for (const t of sent) lines.push(`  ${t.id} ${t.type}${t.toName ? ` → ${t.toName}` : ''}: ${acceptState(t)}`);
  }
  if (forMe.length) {
    lines.push('Para você, aguardando o seu aceite (rode "ack <id>" se for assumir):');
    for (const t of forMe) lines.push(`  ${t.id} ${t.type} de ${t.fromName}: ${t.text.split('\n')[0].slice(0, 120)}`);
  }
  return lines.join('\n');
}

module.exports = {
  Hub, VERSION, TOOLS, TOOL_LABEL, TYPES, LINE_MAX, STALE_MS, READ_BATCH, HISTORY, FILES_MAX,
  projectRoom, normRoom, realDir, scrub, isSecretFile, parseSince, pidAlive, defaultHome,
  fmtSession, fmtMessage, fmtBoard, fmtPending, fmtFiles, acceptState, sha1, WAKE_MODES, CONFIG_DEFAULTS, KEEP_TAIL,
};
