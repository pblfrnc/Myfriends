// Testes do MyFriends (node puro + assert, sem dependências). Cada teste usa pastas temporárias:
// HOME, MYFRIENDS_HOME e LASTGRAVITY_HOME nunca apontam para o HOME real.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'myfriends.js');
const H = require('../scripts/hub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myfriends-test-'));
const realHome = os.homedir();
const env = { ...process.env, HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'), MYFRIENDS_HOME: path.join(tmp, 'hub'), LASTGRAVITY_HOME: path.join(tmp, 'lg-home'), MYFRIENDS_NO_PATH_DETECT: '1' };
for (const k of ['MYFRIENDS_SESSION', 'MYFRIENDS_TOOL', 'CLAUDECODE']) delete env[k];
fs.mkdirSync(env.HOME);
process.env.MYFRIENDS_HOME = env.MYFRIENDS_HOME; // para o Hub usado direto no teste
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsN = 0;
function project(name = 'app') {
  const d = path.join(tmp, `p${++wsN}`, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function run(cwd, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
// --json: devolve o objeto; falha se houver erro (a não ser que allowError).
function j(cwd, args, { allowError = false, env: e } = {}) {
  const r = run(cwd, [...args, '--json'], e);
  let o;
  try { o = JSON.parse(r.out || '{}'); } catch { throw new Error(`saída não é JSON (${args.join(' ')}): ${r.out} ${r.err}`); }
  o._code = r.code;
  if (!allowError) assert.ok(!o.error && r.code === 0, `${args.join(' ')} → ${o.error} (${r.code})`);
  return o;
}
function runAsync(cwd, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}
const hub = new H.Hub({ dir: env.MYFRIENDS_HOME });
// Simula uma sessão que ficou sem sinal por mais de 10 min (a próxima listagem a remove).
function expire(id) {
  const f = path.join(env.MYFRIENDS_HOME, 'sessions', `${id}.json`);
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.lastSeen = Date.now() - 11 * 60 * 1000;
  fs.writeFileSync(f, JSON.stringify(s));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------------ fluxo básico
test('fluxo básico: join, who, send, read com cursor, task, claim, done', async () => {
  const ws = project('basico');
  const a = j(ws, ['join', '--tool', 'claude', '--name', 'Claude Code · basico']).session;
  const b = j(ws, ['join', '--tool', 'codex']).session;
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(a.room, H.projectRoom(ws));
  assert.strictEqual(a.room, b.room);
  const A = ['--session', a.id], B = ['--session', b.id];
  assert.deepStrictEqual(j(ws, ['who', ...B]).sessions.map((s) => s.id).sort(), [a.id, b.id].sort());
  j(ws, ['send', 'oi codex', ...A]);
  let r = j(ws, ['read', ...B]);
  assert.deepStrictEqual(r.messages.map((m) => m.text), ['oi codex']);
  assert.strictEqual(r.more, 0);
  assert.strictEqual(j(ws, ['read', ...B]).messages.length, 0, 'cursor não repete');
  assert.strictEqual(j(ws, ['read', ...A]).messages.length, 0, 'não recebe as próprias');
  assert.strictEqual(j(ws, ['read', '--since', '5m', ...B]).messages.length, 1, '--since');
  const t = j(ws, ['send', 'escrever testes', '--type', 'task', ...A]).message;
  assert.strictEqual(j(ws, ['claim', t.id, ...B]).task.id, t.id);
  const lose = j(ws, ['claim', t.id, ...A], { allowError: true });
  assert.ok(/já foi pega/.test(lose.error) && lose._code === 3);
  j(ws, ['done', t.id, 'feito', ...B]);
  const tk = j(ws, ['tasks', ...A]).tasks.find((x) => x.id === t.id);
  assert.strictEqual(tk.status, 'done');
  assert.strictEqual(tk.acceptance, 'concluido');
  assert.strictEqual(tk.result, 'feito');
  // sala nomeada pelo comando "room"
  assert.strictEqual(j(ws, ['room', 'Revisão Geral', ...B]).session.room, 'revisao-geral');
  assert.strictEqual(hub.getSession(b.id).room, 'revisao-geral');
  j(ws, ['leave', ...A]); j(ws, ['leave', ...B]);
  assert.ok(!hub.getSession(a.id) && !hub.getSession(b.id));
});

// ------------------------------------------------------------------ 1. duas janelas da mesma IDE
test('1. duas janelas da mesma IDE na mesma pasta são sessões diferentes', async () => {
  const ws = project('janelas');
  const w1 = run(ws, ['join', '--tool', 'codex']);
  assert.strictEqual(w1.code, 0);
  const id1 = w1.out.match(/SUA SESSÃO: (s_[a-f0-9]+)/)[1];
  assert.ok(w1.out.includes(`--session ${id1}`), 'diz para passar --session');
  const s2 = j(ws, ['join', '--tool', 'codex']).session;
  assert.notStrictEqual(s2.id, id1, 'join sempre cria uma sessão nova');
  assert.notStrictEqual(s2.name, hub.getSession(id1).name, 'nomes diferentes');
  const W1 = ['--session', id1], W2 = ['--session', s2.id];
  // cursores independentes
  const other = j(ws, ['join', '--tool', 'claude']).session;
  j(ws, ['send', 'para todos', '--session', other.id]);
  assert.strictEqual(j(ws, ['read', ...W1]).messages.length, 1);
  assert.strictEqual(j(ws, ['read', ...W2]).messages.length, 1, 'a segunda janela tem o próprio cursor');
  // reservas independentes
  j(ws, ['claim', '--files', 'src/x.js', ...W1]);
  const c = j(ws, ['claim', '--files', 'src/x.js', ...W2], { allowError: true });
  assert.ok(/reservados por outra sessão/.test(c.error) && c.error.includes(id1), c.error);
  // MYFRIENDS_SESSION funciona como --session
  assert.strictEqual(j(ws, ['status', 'pela env'], { env: { MYFRIENDS_SESSION: s2.id } }).session.id, s2.id);
  // sem --session: usa a mais recente da ferramenta e avisa da ambiguidade
  const amb = j(ws, ['status', 'sem id', '--tool', 'codex']);
  assert.strictEqual(amb.session.id, s2.id);
  assert.ok(/2 sessões codex vivas/.test(amb.warning) && amb.warning.includes('--session'), amb.warning);
  assert.ok(/aviso: .*--session/.test(run(ws, ['who', '--tool', 'codex']).out));
  // sem ambiguidade, sem aviso
  assert.ok(!j(ws, ['who', '--tool', 'claude']).warning);
  // --session desconhecido é erro (não cai em outra sessão)
  const bad = j(ws, ['who', '--session', 's_0123456789ab'], { allowError: true });
  assert.ok(/não encontrada/.test(bad.error) && bad._code !== 0);
  // join --session volta com o mesmo id
  const back = j(ws, ['join', ...W1]);
  assert.strictEqual(back.session.id, id1);
  assert.strictEqual(back.resumed, true);
  assert.ok(/inválido/.test(j(ws, ['join', '--session', 'xyz'], { allowError: true }).error));
});

// ------------------------------------------------------------------ 2. --to para outra sala
test('2. send --to para sessão em outra sala dá erro e não grava nada', async () => {
  const ws = project('salas');
  const a = j(ws, ['join', '--tool', 'claude']).session;
  const b = j(ws, ['join', '--tool', 'codex', '--room', 'outra-sala']).session;
  const before = hub.messages(a.room, { limit: 0 }).length;
  const r = run(ws, ['send', 'handoff', '--type', 'handoff', '--to', b.id, '--session', a.id]);
  assert.notStrictEqual(r.code, 0);
  assert.ok(r.err.includes('outra-sala') && /join .*--room outra-sala/.test(r.err) && /Não enviei/.test(r.err), r.err);
  assert.ok(!/Enviada/.test(r.out));
  assert.strictEqual(hub.messages(a.room, { limit: 0 }).length, before, 'nada gravado na sala do remetente');
  assert.strictEqual(hub.messages('outra-sala', { limit: 0 }).length, 0);
  // por ferramenta também
  assert.strictEqual(j(ws, ['send', 'x', '--to', b.name, '--session', a.id], { allowError: true })._code, 4);
  // entrando na sala dela, funciona
  j(ws, ['room', 'outra-sala', '--session', a.id]);
  j(ws, ['send', 'agora sim', '--to', b.id, '--session', a.id]);
  assert.ok(j(ws, ['read', '--session', b.id]).messages.some((m) => m.text === 'agora sim'));
});

// ------------------------------------------------------------------ 3. sessão que volta não recupera tarefa transferida
test('3. tarefa assumida por outra sessão depois que a dona expirou não volta para ela', async () => {
  const ws = project('retorno');
  fs.mkdirSync(path.join(ws, 'src'));
  const a = j(ws, ['join', '--tool', 'claude']).session;
  const b = j(ws, ['join', '--tool', 'codex']).session;
  const c = j(ws, ['join', '--tool', 'antigravity']).session;
  const A = ['--session', a.id], B = ['--session', b.id];
  const t = j(ws, ['send', 'refatorar login', '--type', 'task', '--files', 'src/login.js', '--session', c.id]).message;
  j(ws, ['claim', t.id, ...A]);
  const res = j(ws, ['claim', '--files', 'src/util.js', ...A]).message; // reserva avulsa
  expire(a.id);
  let board = j(ws, ['tasks', ...B]);
  assert.strictEqual(board.tasks.find((x) => x.id === t.id).status, 'open', 'dona expirou: tarefa aberta');
  const took = j(ws, ['claim', t.id, ...B]);
  assert.strictEqual(took.takeover, a.id, 'transferência registrada');
  j(ws, ['claim', '--files', 'src/util.js', ...B]);
  const raw = hub.messages(a.room, { limit: 0 }).filter((m) => m.type === 'claim' && m.from === b.id);
  assert.ok(raw.some((m) => m.takeover === a.id && m.ref === t.id), 'evento de takeover no log');
  assert.ok(raw.some((m) => (m.supersedes || []).includes(res.id)), 'reserva antiga substituída no log');
  // A volta com o mesmo id
  assert.strictEqual(j(ws, ['join', ...A]).session.id, a.id);
  board = j(ws, ['tasks', ...A]);
  const tk = board.tasks.find((x) => x.id === t.id);
  assert.strictEqual(tk.status, 'claimed');
  assert.strictEqual(tk.by, b.id, 'continua com B');
  assert.strictEqual(tk.takeoverFrom, a.id);
  assert.ok(!board.claims.some((x) => x.by === a.id), 'reservas antigas de A não voltam');
  assert.deepStrictEqual(board.claims.filter((x) => x.by === b.id).flatMap((x) => x.files).sort(), ['src/login.js', 'src/util.js']);
  const d = j(ws, ['done', t.id, 'eu terminei', ...A], { allowError: true });
  assert.ok(d.error && /está com/.test(d.error) && d._code === 3, 'done de A recusado');
  assert.ok(j(ws, ['claim', t.id, ...A], { allowError: true }).error, 'A não pega de volta');
  assert.ok(j(ws, ['done', res.id, 'ok', ...A], { allowError: true }).error, 'A não libera a reserva antiga');
  j(ws, ['done', t.id, 'feito por B', ...B]);
  assert.strictEqual(j(ws, ['tasks', ...A]).tasks.find((x) => x.id === t.id).byName, hub.getSession(b.id).name);
});

// ------------------------------------------------------------------ 4. claim reserva os arquivos da tarefa
test('4. claim de tarefa reserva os arquivos declarados e recusa conflito', async () => {
  const ws = project('auth');
  const a = j(ws, ['join', '--tool', 'claude']).session;
  const b = j(ws, ['join', '--tool', 'codex']).session;
  const c = j(ws, ['join', '--tool', 'antigravity']).session;
  const t1 = j(ws, ['send', 'trocar JWT por sessão', '--type', 'task', '--files', 'src/auth.js,src/session.js', '--session', c.id]).message;
  const t2 = j(ws, ['send', 'logar falhas de login', '--type', 'task', '--files', 'src/auth.js', '--session', c.id]).message;
  const [ra, rb] = await Promise.all([runAsync(ws, ['claim', t1.id, '--session', a.id, '--json']), runAsync(ws, ['claim', t2.id, '--session', b.id, '--json'])]);
  const ok = [ra, rb].filter((x) => x.code === 0), fail = [ra, rb].filter((x) => x.code !== 0);
  assert.strictEqual(ok.length, 1, `só uma pega: ${ra.out} | ${rb.out}`);
  const winner = ok[0] === ra ? a : b;
  const ferr = JSON.parse(fail[0].out).error;
  assert.ok(/Não peguei a tarefa/.test(ferr) && ferr.includes('src/auth.js') && ferr.includes(winner.name) && ferr.includes(winner.id), ferr);
  const board = j(ws, ['tasks', '--session', c.id]);
  assert.strictEqual(board.claims.length, 1);
  assert.strictEqual(board.claims[0].by, winner.id);
  assert.ok(board.claims[0].files.includes('src/auth.js'));
  assert.strictEqual(board.tasks.filter((t) => t.status === 'claimed').length, 1, 'a outra tarefa continua aberta');
  // reserva avulsa também conflita com o arquivo da tarefa
  const loser = winner === a ? b : a;
  assert.ok(/reservados/.test(j(ws, ['claim', '--files', 'src/auth.js', '--session', loser.id], { allowError: true }).error));
  // concluir libera e a outra tarefa pode ser pega
  const wt = winner === a ? t1 : t2, lt = winner === a ? t2 : t1;
  j(ws, ['done', wt.id, 'ok', '--session', winner.id]);
  assert.strictEqual(j(ws, ['tasks', '--session', c.id]).claims.length, 0);
  assert.ok(j(ws, ['claim', lt.id, '--session', loser.id]).files.includes('src/auth.js'));
  assert.ok(run(ws, ['tasks', '--session', c.id]).out.includes('Arquivos reservados'));
});

// ------------------------------------------------------------------ 5. reservas grandes completas
test('5. reserva de 34 arquivos guarda e protege todos (só a exibição corta)', async () => {
  const ws = project('grande');
  const a = j(ws, ['join', '--tool', 'claude']).session;
  const b = j(ws, ['join', '--tool', 'codex']).session;
  const files = Array.from({ length: 34 }, (_, i) => `src/modulos/muito/fundo/de/verdade/pasta-de-componentes-compartilhados/componente-com-nome-bem-comprido-${String(i).padStart(2, '0')}.js`);
  const r = j(ws, ['claim', '--files', files.join(','), '--session', a.id]);
  assert.strictEqual(r.message.files.length, 34);
  const line = fs.readFileSync(hub.roomFile(a.room), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === r.message.id);
  assert.ok(line.blob, 'a linha do log é resumida (blob)');
  const board = j(ws, ['tasks', '--session', b.id]);
  assert.strictEqual(board.claims[0].files.length, 34, 'lista completa no quadro');
  const last = j(ws, ['claim', '--files', files[33], '--session', b.id], { allowError: true });
  assert.ok(/reservados/.test(last.error) && last.error.includes(files[33]), 'o 34º arquivo está protegido');
  assert.ok(/\(\+24\)/.test(run(ws, ['tasks', '--session', b.id]).out), 'exibição mostra +N');
  // tarefa com 34 arquivos: claim reserva todos
  const t = j(ws, ['send', 'migrar tudo', '--type', 'task', '--files', files.map((f) => f.replace('src/', 'lib/')).join(','), '--session', a.id]).message;
  assert.strictEqual(j(ws, ['claim', t.id, '--session', b.id]).files.length, 34);
  assert.ok(j(ws, ['claim', '--files', files[20].replace('src/', 'lib/'), '--session', a.id], { allowError: true }).error);
});

// ------------------------------------------------------------------ 6. read com mais de 200 pendentes
test('6. read entrega em ordem, em lotes, sem pular mensagens; --wait funciona', async () => {
  const ws = project('muitas');
  const a = j(ws, ['join', '--tool', 'claude']).session;
  const b = j(ws, ['join', '--tool', 'codex']).session;
  for (let i = 0; i < 201; i++) hub.post(a.room, a.id, { text: `msg ${i}` });
  let r = j(ws, ['read', '--session', b.id]);
  assert.strictEqual(r.messages.length, 200);
  assert.strictEqual(r.messages[0].text, 'msg 0', 'as mais antigas primeiro');
  assert.strictEqual(r.messages[199].text, 'msg 199');
  assert.strictEqual(r.more, 1);
  assert.ok(run(ws, ['read', '--session', a.id, '--limit', '1']).out.includes('Nenhuma'), 'remetente não recebe as próprias');
  r = j(ws, ['read', '--session', b.id]);
  assert.deepStrictEqual(r.messages.map((m) => m.text), ['msg 200'], 'a segunda leitura traz o resto');
  assert.strictEqual(r.more, 0);
  assert.strictEqual(j(ws, ['read', '--session', b.id]).messages.length, 0);
  // texto avisa que há mais
  for (let i = 0; i < 3; i++) hub.post(a.room, a.id, { text: `extra ${i}` });
  const t = run(ws, ['read', '--limit', '2', '--session', b.id]).out;
  assert.ok(t.includes('extra 0') && t.includes('extra 1') && !t.includes('extra 2') && t.includes('há mais 1 mensagens, rode read de novo'), t);
  assert.ok(run(ws, ['read', '--session', b.id]).out.includes('extra 2'));
  // mensagens para outras sessões não contam e não travam o cursor
  const c = j(ws, ['join', '--tool', 'antigravity']).session;
  hub.post(a.room, a.id, { text: 'só para c', to: c.id });
  hub.post(a.room, a.id, { text: 'para todos' });
  assert.deepStrictEqual(j(ws, ['read', '--session', b.id]).messages.map((m) => m.text), ['para todos']);
  // quem entra depois recebe só o histórico recente (últimas 50), não a sala inteira
  const late = j(ws, ['join', '--tool', 'outro']).session;
  r = j(ws, ['read', '--session', late.id]);
  assert.strictEqual(r.messages.length, H.HISTORY - 1, 'últimas 50 mensagens (menos a direta para c)');
  assert.strictEqual(r.more, 0);
  // --wait
  const t0 = Date.now();
  const waiting = runAsync(ws, ['read', '--wait', '15', '--session', b.id, '--json']);
  await sleep(700);
  j(ws, ['send', 'ping', '--session', a.id]);
  const w = JSON.parse((await waiting).out);
  assert.deepStrictEqual(w.messages.map((m) => m.text), ['ping']);
  assert.ok(Date.now() - t0 < 8000);
});

// ------------------------------------------------------------------ 7. handoff: campos obrigatórios e aceite
test('7. handoff: campos exigidos, "enviado" vs "assumido" e ack', async () => {
  const ws = project('handoff');
  const a = j(ws, ['join', '--tool', 'claude']).session;
  const b = j(ws, ['join', '--tool', 'codex']).session;
  const A = ['--session', a.id], B = ['--session', b.id];
  const incomplete = j(ws, ['send', 'continua o login', '--type', 'handoff', '--to', b.id, ...A]);
  assert.ok(/Branch\/commit/.test(incomplete.warning) && /Último teste/.test(incomplete.warning) && /Próximo passo/.test(incomplete.warning), incomplete.warning);
  const full = j(ws, ['send', 'Login com sessão quase pronto', '--type', 'handoff', '--to', b.id, '--branch', 'feat/login @ 3f2c1ab', '--changes', 'src/auth.js não commitado', '--tests', 'npm test: 1 falha', '--next', 'corrigir cookie', '--files', 'src/auth.js', ...A]);
  assert.ok(!full.warning, full.warning);
  assert.strictEqual(full.state, 'enviado');
  assert.deepStrictEqual(full.message.data.handoff, { branch: 'feat/login @ 3f2c1ab', changes: 'src/auth.js não commitado', tests: 'npm test: 1 falha', next: 'corrigir cookie' });
  assert.ok(/Branch\/commit: feat\/login/.test(full.message.text));
  const txt = run(ws, ['send', 'outro', '--type', 'handoff', '--to', b.id, '--branch', 'main', '--changes', 'nada pendente', '--tests', 'npm test: ok', '--next', 'publicar', ...A]).out;
  assert.ok(/enviado, aguardando .* assumir/.test(txt), txt);
  const id = full.message.id;
  // antes do aceite
  let tk = j(ws, ['tasks', ...A]).tasks.find((t) => t.id === id);
  assert.strictEqual(tk.acceptance, 'enviado');
  assert.ok(/enviada, aguardando/.test(run(ws, ['tasks', ...A]).out));
  let who = j(ws, ['who', ...A]);
  assert.strictEqual(who.pending.sent.find((t) => t.id === id).status, 'open');
  assert.ok(j(ws, ['who', ...B]).pending.awaiting.some((t) => t.id === id), 'destinatário vê o que espera o aceite dele');
  assert.ok(/aguardando o seu aceite/.test(run(ws, ['who', ...B]).out));
  // ack de mensagem que não é task/handoff
  const chat = j(ws, ['send', 'bom dia', ...A]).message;
  assert.ok(/task.*handoff/.test(j(ws, ['ack', chat.id, ...B], { allowError: true }).error));
  // aceite
  const ack = j(ws, ['ack', id, 'assumindo o login', ...B]);
  assert.strictEqual(ack.task.id, id);
  assert.deepStrictEqual(ack.files, ['src/auth.js']);
  tk = j(ws, ['tasks', ...A]).tasks.find((t) => t.id === id);
  assert.strictEqual(tk.acceptance, 'assumido');
  assert.strictEqual(tk.by, b.id);
  assert.ok(/assumida por/.test(run(ws, ['tasks', ...A]).out));
  who = j(ws, ['who', ...A]);
  assert.strictEqual(who.pending.sent.find((t) => t.id === id).status, 'claimed');
  assert.ok(/assumida por/.test(run(ws, ['who', ...A]).out));
  // SKILL.md exige os campos e a diferença enviado/assumido
  const md = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  for (const s of ['branch or commit', 'uncommitted', 'last test run', 'next step', 'enviado, aguardando o outro agente assumir', 'ack <id>', '--session']) assert.ok(md.includes(s), `SKILL.md: ${s}`);
});

// ------------------------------------------------------------------ versão
test('versão 1.1.0 no hub, README e CHANGELOG', async () => {
  assert.strictEqual(H.VERSION, '1.1.0');
  assert.ok(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('vers%C3%A3o-1.1.0'));
  assert.ok(/## 1\.1\.0/.test(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')));
  assert.strictEqual(require('../package.json').version, '1.1.0');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`✓ ${t.name}`); } catch (e) { failed++; console.error(`✗ ${t.name}\n${e.stack}`); }
  }
  assert.ok(hub.dir.startsWith(tmp) && !hub.dir.startsWith(path.join(realHome, '.myfriends')), 'hub só no diretório temporário');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (failed) { console.error(`\n${failed} teste(s) falharam.`); process.exit(1); }
  console.log(`\nMyFriends: ${tests.length} testes OK.`);
})();
