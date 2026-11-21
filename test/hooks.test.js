// Testes dos ganchos (hooks) do Claude Code e do Codex: entrega automática de mensagens.
// Tudo em pastas temporárias: HOME e MYFRIENDS_HOME nunca apontam para o HOME real.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'hook.js');
const CLI = path.join(ROOT, 'scripts', 'myfriends.js');
const INSTALL = path.join(ROOT, 'scripts', 'install.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myfriends-hooks-'));
const HOME = path.join(tmp, 'home');
const env = { ...process.env, HOME, USERPROFILE: HOME, MYFRIENDS_HOME: path.join(tmp, 'hub'), MYFRIENDS_TARGET_HOME: HOME, MYFRIENDS_NO_PATH_DETECT: '1', MYFRIENDS_NOTIFY: '0' };
for (const k of ['MYFRIENDS_SESSION', 'MYFRIENDS_TOOL', 'CODEX_HOME']) delete env[k];
const proj = path.join(tmp, 'proj', 'app');
fs.mkdirSync(proj, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hook(tool, input, mode) {
  const r = spawnSync(process.execPath, [HOOK, tool, ...(mode ? [mode] : [])], { input: JSON.stringify({ cwd: proj, ...input }), env, encoding: 'utf8', timeout: 20000 });
  let json = null;
  if (r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch { json = { raw: r.stdout }; } }
  return { code: r.status, json, err: r.stderr };
}
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: proj, env, encoding: 'utf8', timeout: 20000 });
  return JSON.parse(r.stdout || '{}');
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('instalador liga os ganchos sem apagar os de outros programas, e --remove-hooks desliga', () => {
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
  const other = { type: 'command', command: 'echo outro-programa' };
  fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [other] }] } }));
  const r = spawnSync(process.execPath, [INSTALL, '--yes'], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /avisos automáticos ligados/);
  const cs = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(cs.model, 'opus');
  assert.ok(cs.hooks.PostToolUse.some((g) => g.hooks.some((h) => h.command === 'echo outro-programa')), 'gancho de outro programa mantido');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) assert.ok(JSON.stringify(cs.hooks[ev]).includes('hook.js'), ev);
  assert.ok(JSON.stringify(cs.hooks.Stop).includes('"asyncRewake":true'));
  assert.ok(fs.existsSync(path.join(HOME, '.claude', 'settings.json.myfriends.bak')), 'cópia de segurança');
  const cx = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'hooks.json'), 'utf8'));
  assert.ok(JSON.stringify(cx.hooks.Stop).includes('"async":true'));
  // Reinstalar não duplica.
  spawnSync(process.execPath, [INSTALL, '--yes'], { env, encoding: 'utf8' });
  const cs2 = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(cs2.hooks.SessionStart.length, 1);
  assert.strictEqual(cs2.hooks.PostToolUse.length, 2);
  // Desligar mantém o resto.
  spawnSync(process.execPath, [INSTALL, '--remove-hooks'], { env, encoding: 'utf8' });
  const cs3 = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(cs3.hooks, { PostToolUse: [{ matcher: 'Bash', hooks: [other] }] });
  assert.strictEqual(cs3.model, 'opus');
  const cx3 = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'hooks.json'), 'utf8'));
  assert.ok(!cx3.hooks);
});

test('SessionStart: cada janela vira uma sessão, e o agente recebe o próprio id', () => {
  const a = hook('claude', { session_id: 'janela-A', hook_event_name: 'SessionStart', source: 'startup' });
  const b = hook('claude', { session_id: 'janela-B', hook_event_name: 'SessionStart', source: 'startup' });
  assert.strictEqual(a.code, 0);
  const ida = a.json.hookSpecificOutput.additionalContext.match(/id (s_[a-f0-9]+)/)[1];
  const idb = b.json.hookSpecificOutput.additionalContext.match(/id (s_[a-f0-9]+)/)[1];
  assert.notStrictEqual(ida, idb);
  assert.match(b.json.hookSpecificOutput.additionalContext, /Claude Code · app \(2\)|Na mesma sala agora/);
  // A mesma janela de novo = mesma sessão.
  const a2 = hook('claude', { session_id: 'janela-A', hook_event_name: 'SessionStart', source: 'resume' });
  assert.ok(a2.json.hookSpecificOutput.additionalContext.includes(ida));
});

test('mensagem nova aparece para o usuário e entra na conversa no próximo passo', () => {
  hook('codex', { session_id: 'cx-1', hook_event_name: 'SessionStart' });
  const who = cli(['who', '--tool', 'codex']);
  void who;
  const claudeId = hook('claude', { session_id: 'janela-A', hook_event_name: 'SessionStart' }).json.hookSpecificOutput.additionalContext.match(/id (s_[a-f0-9]+)/)[1];
  const codexId = require('../scripts/hook').sidFor('codex', 'cx-1');
  const sent = cli(['send', 'Pode revisar o src/auth.js?', '--to', claudeId, '--session', codexId]);
  assert.ok(sent.message?.id || sent.id, JSON.stringify(sent));
  const r = hook('claude', { session_id: 'janela-A', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.match(r.json.systemMessage, /📨 MyFriends — Codex · app.*revisar o src\/auth\.js/);
  assert.match(r.json.hookSpecificOutput.additionalContext, /não pedidos do usuário/);
  assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  // Já entregue: não repete.
  const again = hook('claude', { session_id: 'janela-A', hook_event_name: 'UserPromptSubmit', prompt: 'oi' });
  assert.strictEqual(again.json, null);
  // A outra janela do Claude não recebe a mensagem direta.
  const other = hook('claude', { session_id: 'janela-B', hook_event_name: 'PostToolUse' });
  assert.strictEqual(other.json, null);
});

test('Stop: pedido para esta sessão faz o agente continuar; conversa geral só avisa', () => {
  const H = require('../scripts/hook');
  const claudeId = H.sidFor('claude', 'janela-A'), codexId = H.sidFor('codex', 'cx-1');
  cli(['send', 'Corrigir o login', '--type', 'task', '--to', claudeId, '--session', codexId]);
  const st = hook('claude', { session_id: 'janela-A', hook_event_name: 'Stop', stop_hook_active: false });
  assert.strictEqual(st.json.decision, 'block');
  assert.match(st.json.reason, /Corrigir o login/);
  assert.match(st.json.reason, /ack <id> --session s_/);
  cli(['send', 'bom dia, sala', '--session', codexId]);
  const st2 = hook('claude', { session_id: 'janela-A', hook_event_name: 'Stop', stop_hook_active: false });
  assert.ok(!st2.json.decision);
  assert.match(st2.json.systemMessage, /bom dia, sala/);
  // Continua pendente: chega com o próximo prompt.
  const up = hook('claude', { session_id: 'janela-A', hook_event_name: 'UserPromptSubmit', prompt: 'e aí?' });
  assert.match(up.json.hookSpecificOutput.additionalContext, /bom dia, sala/);
  // Sem laço: com stop_hook_active não bloqueia de novo.
  cli(['send', 'mais uma', '--to', claudeId, '--session', codexId]);
  const st3 = hook('claude', { session_id: 'janela-A', hook_event_name: 'Stop', stop_hook_active: true });
  assert.ok(!st3.json.decision);
  hook('claude', { session_id: 'janela-A', hook_event_name: 'UserPromptSubmit' });
});

test('vigia (asyncRewake) acorda o Claude quando chega um pedido e só existe um por sessão', async () => {
  const H = require('../scripts/hook');
  const claudeId = H.sidFor('claude', 'janela-A'), codexId = H.sidFor('codex', 'cx-1');
  const input = JSON.stringify({ cwd: proj, session_id: 'janela-A', hook_event_name: 'Stop' });
  const start = () => {
    const p = spawn(process.execPath, [HOOK, 'claude', 'watch'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.end(input);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    return { p, done: new Promise((r) => p.on('exit', (code) => r({ code, err: () => err }))) };
  };
  const w1 = start();
  await sleep(1200);
  const w2 = start();
  const r2 = await w2.done; // segundo vigia sai na hora
  assert.strictEqual(r2.code, 0);
  cli(['send', 'chat geral não acorda', '--session', codexId]);
  await sleep(2500);
  cli(['send', 'Revisa o PR?', '--type', 'task', '--to', claudeId, '--session', codexId]);
  const r1 = await Promise.race([w1.done, sleep(15000).then(() => ({ code: 'timeout' }))]);
  assert.strictEqual(r1.code, 2, 'código 2 acorda o Claude');
  assert.match(r1.err(), /Revisa o PR\?/);
  // O que foi entregue pelo vigia não volta no próximo passo.
  const next = hook('claude', { session_id: 'janela-A', hook_event_name: 'PostToolUse' });
  assert.ok(!next.json || !/Revisa o PR/.test(next.json.hookSpecificOutput?.additionalContext || ''));
});

test('SessionEnd tira a sessão da sala; erros nunca quebram a IDE', () => {
  const H = require('../scripts/hook');
  const r = hook('claude', { session_id: 'janela-B', hook_event_name: 'SessionEnd' });
  assert.strictEqual(r.code, 0);
  const who = cli(['who', '--all', '--tool', 'codex', '--session', H.sidFor('codex', 'cx-1')]);
  assert.ok(!(who.sessions || []).some((s) => s.id === H.sidFor('claude', 'janela-B')));
  const notDir = path.join(tmp, 'um-arquivo');
  fs.writeFileSync(notDir, 'x');
  const bad = spawnSync(process.execPath, [HOOK, 'claude'], { input: 'isto não é json', env: { ...env, MYFRIENDS_HOME: path.join(notDir, 'hub') }, encoding: 'utf8', timeout: 15000 });
  assert.strictEqual(bad.status, 0);
});

(async () => {
  let fail = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`✓ ${t.name}`); } catch (e) { fail++; console.log(`✗ ${t.name}\n  ${e.stack}`); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (fail) { console.log(`\n${fail} falha(s).`); process.exit(1); }
  console.log(`\nGanchos: ${tests.length} testes OK.`);
})();
