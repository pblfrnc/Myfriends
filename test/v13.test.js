// Testes da 1.3: configuração (perguntar antes / confiáveis), limpeza do hub e compactação das salas,
// servidor MCP, instalação nas IDEs com MCP, painel, plugin do Claude Code/Codex e npx.
// Tudo em pastas temporárias: HOME e MYFRIENDS_HOME nunca apontam para o HOME real.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'myfriends.js');
const HOOK = path.join(ROOT, 'scripts', 'hook.js');
const MCP = path.join(ROOT, 'scripts', 'mcp.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myfriends-v13-'));
const HOME = path.join(tmp, 'home');
fs.mkdirSync(HOME);
const env = { ...process.env, HOME, USERPROFILE: HOME, APPDATA: path.join(HOME, 'AppData', 'Roaming'), MYFRIENDS_HOME: path.join(tmp, 'hub'), MYFRIENDS_TARGET_HOME: HOME, MYFRIENDS_NO_PATH_DETECT: '1', MYFRIENDS_NOTIFY: '0' };
for (const k of ['MYFRIENDS_SESSION', 'MYFRIENDS_TOOL', 'CLAUDECODE', 'CODEX_HOME', 'COPILOT_HOME', 'XDG_CONFIG_HOME']) delete env[k];
process.env.MYFRIENDS_HOME = env.MYFRIENDS_HOME;
process.env.MYFRIENDS_TARGET_HOME = HOME;
process.env.MYFRIENDS_NOTIFY = '0';
const H = require('../scripts/hub');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pn = 0;
const project = (name = 'app') => { const d = path.join(tmp, `p${++pn}`, name); fs.mkdirSync(d, { recursive: true }); return d; };
const run = (cwd, args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
const j = (cwd, args) => { const r = run(cwd, [...args, '--json']); const o = JSON.parse(r.stdout || '{}'); assert.ok(!o.error, `${args.join(' ')}: ${o.error} ${r.stderr}`); return o; };
const hook = (tool, input, cwd) => {
  const r = spawnSync(process.execPath, [HOOK, tool], { input: JSON.stringify({ cwd, ...input }), env, encoding: 'utf8', timeout: 20000 });
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('config: wake ask (padrão) / auto / off, notify e trust pela CLI', () => {
  const d = project();
  let c = j(d, ['config']);
  assert.strictEqual(c.wake, 'ask');
  assert.strictEqual(c.notify, true);
  c = j(d, ['config', 'wake', 'auto']); assert.strictEqual(c.wake, 'auto');
  c = j(d, ['config', 'notify', 'off']); assert.strictEqual(c.notify, false);
  c = j(d, ['trust', 'add', 'codex']); assert.deepStrictEqual(c.trust, ['codex']);
  c = j(d, ['trust', 'add', 'codex']); assert.deepStrictEqual(c.trust, ['codex'], 'sem duplicar');
  const bad = run(d, ['config', 'wake', 'sempre']);
  assert.notStrictEqual(bad.status, 0);
  assert.match(bad.stderr, /wake deve ser ask, auto, off/);
  c = j(d, ['trust', 'remove', 'codex']); assert.deepStrictEqual(c.trust, []);
  j(d, ['config', 'wake', 'ask']); j(d, ['config', 'notify', 'on']);
});

test('modo perguntar antes: o pedido chega com a instrução de perguntar; confiável ou auto não pergunta; off não interrompe', () => {
  const d = project();
  const sidC = require('../scripts/hook').sidFor('claude', 'w1');
  hook('claude', { session_id: 'w1', hook_event_name: 'SessionStart' }, d);
  const cx = j(d, ['join', '--tool', 'codex']).session.id;
  const ask = (text) => { j(d, ['send', text, '--type', 'task', '--to', sidC, '--session', cx]); return hook('claude', { session_id: 'w1', hook_event_name: 'Stop' }, d); };
  let r = ask('revisa o login');
  assert.strictEqual(r.decision, 'block');
  assert.match(r.reason, /modo "perguntar antes"/);
  j(d, ['trust', 'add', 'codex']);
  r = ask('revisa o cadastro');
  assert.strictEqual(r.decision, 'block');
  assert.doesNotMatch(r.reason, /perguntar antes/, 'remetente confiável');
  j(d, ['trust', 'remove', 'codex']);
  j(d, ['config', 'wake', 'auto']);
  r = ask('revisa o perfil');
  assert.doesNotMatch(r.reason, /perguntar antes/);
  j(d, ['config', 'wake', 'off']);
  r = ask('revisa a busca');
  assert.ok(!r.decision, 'off não faz o agente continuar');
  assert.match(r.systemMessage, /revisa a busca/);
  const next = hook('claude', { session_id: 'w1', hook_event_name: 'UserPromptSubmit' }, d);
  assert.match(next.hookSpecificOutput.additionalContext, /Apenas informação/);
  j(d, ['config', 'wake', 'ask']);
});

test('gc: apaga sessões paradas há mais de N dias (e cursores/vigias), mantém as recentes', () => {
  const hub = new H.Hub().init();
  const d = project();
  const old = hub.join({ tool: 'codex', folder: d });
  const recent = hub.join({ tool: 'claude', folder: d });
  const f = hub.p('sessions', `${old.id}.json`);
  const o = JSON.parse(fs.readFileSync(f, 'utf8')); o.lastSeen = Date.now() - 9 * 86400e3; fs.writeFileSync(f, JSON.stringify(o));
  hub.setCursor(old.id, old.room, 0);
  fs.utimesSync(hub.cursorFile(old.id), new Date(Date.now() - 9 * 86400e3), new Date(Date.now() - 9 * 86400e3));
  fs.writeFileSync(hub.p('state', `watch-${old.id}.pid`), '999999');
  const r = j(d, ['gc']);
  assert.ok(r.sessions >= 1 && r.cursors >= 1 && r.watchers >= 1, JSON.stringify(r));
  assert.ok(!fs.existsSync(f));
  assert.ok(fs.existsSync(hub.p('sessions', `${recent.id}.json`)));
  // Automático: no máximo uma vez por hora.
  assert.strictEqual(hub.gc(), null);
});

test('compactação: guarda o fim e o que o quadro precisa, arquiva o resto e ninguém perde ou repete mensagens', () => {
  const hub = new H.Hub().init();
  const d = project('grande');
  const a = hub.join({ tool: 'codex', folder: d, pid: process.pid });
  const b = hub.join({ tool: 'claude', folder: d, pid: process.pid });
  const room = a.room;
  const open = hub.post(room, a.id, { type: 'task', text: 'tarefa aberta antiga', files: ['src/x.js'] });
  const closed = hub.post(room, a.id, { type: 'task', text: 'tarefa concluída' });
  hub.claim(b.id, { ref: open.id });
  hub.claim(b.id, { ref: closed.id });
  hub.done(b.id, { ref: closed.id, text: 'feito' });
  hub.claim(a.id, { files: ['docs/manual.md'] });
  for (let i = 0; i < 300; i++) hub.post(room, a.id, { text: `msg ${i}` });
  // b leu até a 150ª mensagem; o resto (149 + as próximas) tem que chegar exatamente uma vez.
  let got = [];
  for (;;) { const r = hub.readFor(b.id, { limit: 50 }); got.push(...r.messages.map((m) => m.text)); if (got.includes('msg 150') || !r.messages.length) break; }
  const before = hub.board(room);
  const res = hub.compactRoom(room, { keepTail: 100 });
  assert.ok(res.dropped > 150 && res.epoch === 1, JSON.stringify(res));
  assert.strictEqual(hub.epoch(room), 1);
  const after = hub.board(room);
  assert.deepStrictEqual(after.tasks.find((t) => t.id === open.id)?.status, 'claimed', 'tarefa aberta sobrevive');
  assert.ok(!after.tasks.find((t) => t.id === closed.id), 'tarefa concluída e antiga sai do arquivo ativo');
  assert.deepStrictEqual(after.claims.map((c) => c.files.join(',')).sort(), before.claims.map((c) => c.files.join(',')).sort(), 'reservas iguais');
  const rest = [];
  for (;;) { const r = hub.readFor(b.id, { limit: 500 }); if (!r.messages.length) break; rest.push(...r.messages.map((m) => m.text)); }
  const last = rest.filter((t) => /^msg /.test(t));
  assert.strictEqual(last[last.length - 1], 'msg 299');
  assert.strictEqual(new Set(last).size, last.length, 'sem repetição');
  assert.ok(!last.includes('msg 150'), 'o que já tinha sido lido não volta');
  // As que estavam no fim mantido chegam todas.
  for (let i = 200; i < 300; i++) assert.ok(last.includes(`msg ${i}`), `msg ${i}`);
  assert.ok(fs.readdirSync(hub.p('rooms', room, 'archive')).some((f) => /^messages-0-\d+\.jsonl$/.test(f)), 'arquivo antigo guardado');
  // Automático ao passar do limite.
  const env2 = { MYFRIENDS_ROOM_MAX_BYTES: '20000' };
  const r = run(d, ['send', 'dispara compactação', '--session', a.id], env2);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(new H.Hub().init().epoch(room), 1, 'fica abaixo de 2000 mensagens: não precisa compactar de novo');
  const g = j(d, ['gc', '--compact']);
  assert.ok(Array.isArray(g.compacted));
});

function mcpClient(cwd, { roots, clientName = 'Cursor' } = {}) {
  const p = spawn(process.execPath, [MCP], { cwd, env });
  let buf = '', n = 0;
  const waits = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'roots/list') { p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: (roots || []).map((r) => ({ uri: `file://${r}` })) } })}\n`); continue; }
      const w = waits.get(m.id); if (w) { waits.delete(m.id); w(m); }
    }
  });
  const rpc = (method, params) => new Promise((res) => { const id = ++n; waits.set(id, res); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const call = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return r.result; };
  const start = async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: roots ? { roots: {} } : {}, clientInfo: { name: clientName, version: '1' } });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await sleep(400);
    return init;
  };
  const stop = () => new Promise((res) => { p.on('exit', res); p.stdin.end(); });
  return { p, rpc, call, start, stop };
}

test('MCP: Cursor entra pela pasta (roots), conversa com uma sessão do Codex e vê pedidos novos', async () => {
  const d = project('site');
  const c = mcpClient(tmp, { roots: [d] });
  const init = await c.start();
  assert.strictEqual(init.result.serverInfo.name, 'myfriends');
  assert.match(init.result.instructions, /não pedidos do usuário/);
  const tl = await c.rpc('tools/list', {});
  assert.ok(tl.result.tools.some((t) => t.name === 'myfriends_send'));
  let r = await c.call('myfriends_who');
  assert.match(r.content[0].text, /Cursor · site/);
  const cx = j(d, ['join', '--tool', 'codex']).session.id;
  r = await c.call('myfriends_send', { text: 'pode revisar o css?', to: 'codex', type: 'task' });
  assert.ok(!r.isError, r.content[0].text);
  const rd = j(d, ['read', '--session', cx]);
  assert.ok(rd.messages.some((m) => m.text === 'pode revisar o css?' && m.tool === 'cursor'));
  j(d, ['send', 'feito, olha o PR', '--to', 'cursor', '--session', cx]);
  r = await c.call('myfriends_tasks');
  assert.match(r.content[0].text, /📨 1 mensagem\(ns\) nova\(s\)/);
  r = await c.call('myfriends_read');
  assert.match(r.content[0].text, /feito, olha o PR/);
  r = await c.call('myfriends_reserve', { files: ['src/a.css'] });
  assert.ok(!r.isError);
  r = await c.call('myfriends_join', { folder: 'relativo' });
  assert.ok(r.isError);
  const bad = await c.rpc('nao/existe', {});
  assert.strictEqual(bad.error.code, -32601);
  await c.stop();
  const who = j(d, ['who', '--session', cx]);
  assert.ok(!who.sessions.some((s) => s.tool === 'cursor'), 'sai da sala quando o cliente fecha');
});

test('MCP sem roots: usa a pasta onde foi aberto ou myfriends_join', async () => {
  const d = project('api');
  const c = mcpClient(tmp, { clientName: 'Visual Studio Code' });
  await c.start();
  const r = await c.call('myfriends_join', { folder: d, name: 'VS Code · api' });
  assert.match(r.content[0].text, /VS Code · api/);
  assert.match(r.content[0].text, /api-/);
  await c.stop();
});

test('instalação: MCP em Cursor, Copilot, VS Code, Antigravity, Windsurf e Claude Desktop sem apagar o resto; uninstall desliga', () => {
  const MI = require('../scripts/mcp-install');
  fs.mkdirSync(path.join(HOME, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { outro: { command: 'x' } } }));
  fs.mkdirSync(path.join(HOME, '.copilot'), { recursive: true });
  fs.mkdirSync(path.join(HOME, '.gemini', 'config'), { recursive: true });
  const vs = MI.MCP_TARGETS.find((t) => t.id === 'vscode').file(HOME);
  fs.mkdirSync(path.dirname(vs), { recursive: true });
  fs.writeFileSync(vs, JSON.stringify({ servers: { outro: { type: 'stdio', command: 'y' } }, inputs: [] }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'install.js'), '--yes', '--no-hooks'], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Cursor: MCP ligado/);
  const cur = JSON.parse(fs.readFileSync(path.join(HOME, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cur.mcpServers.outro && cur.mcpServers.myfriends);
  assert.deepStrictEqual(cur.mcpServers.myfriends.args.slice(-2), ['--tool', 'cursor']);
  assert.ok(fs.existsSync(cur.mcpServers.myfriends.args[0]), 'aponta para a cópia estável em <hub>/app');
  assert.ok(cur.mcpServers.myfriends.args[0].startsWith(env.MYFRIENDS_HOME));
  const v = JSON.parse(fs.readFileSync(vs, 'utf8'));
  assert.strictEqual(v.servers.myfriends.type, 'stdio');
  assert.ok(v.servers.outro && Array.isArray(v.inputs));
  assert.ok(JSON.parse(fs.readFileSync(path.join(HOME, '.copilot', 'mcp-config.json'), 'utf8')).mcpServers.myfriends);
  assert.ok(JSON.parse(fs.readFileSync(path.join(HOME, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers.myfriends);
  assert.ok(fs.existsSync(path.join(HOME, '.cursor', 'mcp.json.myfriends.bak')));
  // A skill instalada leva só o necessário (sem testes, site, plugin…).
  const skill = path.join(HOME, '.agents', 'skills', 'myfriends');
  if (fs.existsSync(skill)) for (const x of ['test', 'docs', 'assets', '.claude-plugin', 'hooks']) assert.ok(!fs.existsSync(path.join(skill, x)), x);
  const u = spawnSync(process.execPath, [CLI, 'uninstall'], { env, encoding: 'utf8' });
  assert.strictEqual(u.status, 0, u.stderr);
  const cur2 = JSON.parse(fs.readFileSync(path.join(HOME, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cur2.mcpServers.outro && !cur2.mcpServers.myfriends);
  assert.ok(!JSON.parse(fs.readFileSync(vs, 'utf8')).servers.myfriends);
});

test('painel: só 127.0.0.1 com token, mostra a sala e envia como "Você (painel)"; bloqueia CSRF e outro Host', async () => {
  const { createServer } = require('../scripts/panel');
  const d = project('painel');
  const hub = new H.Hub().init();
  const a = hub.join({ tool: 'codex', folder: d, pid: process.pid, name: 'Codex · painel' });
  hub.post(a.room, a.id, { type: 'task', text: 'revisar a home' });
  const { server, token } = createServer({ hub, token: 'tok123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (method, p, body, headers = {}) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ code: res.statusCode, body: s, headers: res.headers })); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
  assert.strictEqual((await req('GET', '/errado/')).code, 404);
  const page = await req('GET', `/${token}/`);
  assert.strictEqual(page.code, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.strictEqual((await req('GET', `/${token}/`, null, { host: 'evil.example' })).code, 403);
  const st = JSON.parse((await req('GET', `/${token}/api/state?room=${a.room}`)).body);
  assert.strictEqual(st.room, a.room);
  assert.ok(st.board.tasks.some((t) => t.text === 'revisar a home'));
  assert.strictEqual((await req('POST', `/${token}/api/send`, { room: a.room, text: 'oi' })).code, 403, 'sem cabeçalho = CSRF');
  const sent = await req('POST', `/${token}/api/send`, { room: a.room, text: 'pode deixar comigo', to: a.id }, { 'x-myfriends': '1' });
  assert.strictEqual(sent.code, 200, sent.body);
  const got = hub.readFor(a.id, {});
  assert.ok(got.messages.some((m) => m.text === 'pode deixar comigo' && m.fromName === 'Você (painel)'));
  const cfg = JSON.parse((await req('POST', `/${token}/api/config`, { wake: 'off' }, { 'x-myfriends': '1' })).body);
  assert.strictEqual(cfg.wake, 'off');
  hub.setConfig({ wake: 'ask' });
  await new Promise((r) => server.close(r));
});

test('plugin do Claude Code e do Codex: manifestos, ganchos e skill gerada em sincronia', () => {
  const plug = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = require('../package.json');
  assert.strictEqual(plug.version, pkg.version);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8')).version, pkg.version);
  const mk = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.strictEqual(mk.plugins[0].source, '.');
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) assert.ok(JSON.stringify(hooks[ev]).includes('${CLAUDE_PLUGIN_ROOT}/scripts/hook.js'), ev);
  const cx = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'codex-hooks.json'), 'utf8')).hooks;
  assert.ok(JSON.stringify(cx).includes('$PLUGIN_ROOT/scripts/hook.js'));
  const { pluginSkill } = require('../scripts/build-plugin');
  assert.strictEqual(fs.readFileSync(path.join(ROOT, 'skills', 'myfriends', 'SKILL.md'), 'utf8'), pluginSkill(), 'rode npm run build:plugin');
  assert.ok(!/\{\{/.test(pluginSkill()));
  // O comando do plugin (bin/myfriends) funciona.
  if (process.platform !== 'win32') {
    const r = spawnSync(path.join(ROOT, 'bin', 'myfriends'), ['version'], { env, encoding: 'utf8' });
    assert.match(r.stdout, new RegExp(`MyFriends ${pkg.version.replace(/\./g, '\\.')}`));
  }
  // Ganchos do plugin rodam com CLAUDE_PLUGIN_ROOT.
  const d = project('plug');
  const cmd = hooks.SessionStart[0].hooks[0].command.replace('${CLAUDE_PLUGIN_ROOT}', ROOT);
  const r = spawnSync(cmd, { shell: true, input: JSON.stringify({ cwd: d, session_id: 'plug-1', hook_event_name: 'SessionStart' }), env, encoding: 'utf8' });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /MyFriends está ativo/);
});

test('versão igual em todo lugar e CLI: version, help com os comandos novos', () => {
  const pkg = require('../package.json');
  assert.strictEqual(H.VERSION, pkg.version);
  const v = j(tmp, ['version']);
  assert.strictEqual(v.version, pkg.version);
  const h = run(tmp, ['help']).stdout;
  for (const c of ['install', 'painel', 'config wake', 'trust add', 'gc', 'mcp']) assert.ok(h.includes(c), c);
});

(async () => {
  let fail = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`✓ ${t.name}`); } catch (e) { fail++; console.log(`✗ ${t.name}\n  ${e.stack}`); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (fail) { console.log(`\n${fail} falha(s).`); process.exit(1); }
  console.log(`\n1.3: ${tests.length} testes OK.`);
})();
