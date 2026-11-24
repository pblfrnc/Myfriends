#!/usr/bin/env node
// Instala a skill MyFriends nas IDEs encontradas nesta máquina (sem dependências).
//   node install.js                 mostra o que seria gravado (nada é alterado)
//   node install.js --yes           instala/atualiza onde a IDE existir
//   node install.js --yes --only claude,codex
//   node install.js --yes --no-hooks     instala só a skill, sem os avisos automáticos de mensagens
//   node install.js --remove-hooks        desliga os avisos automáticos (mantém a skill)
//   node install.js --yes --no-mcp       não liga o servidor MCP (Cursor, Copilot, VS Code, Antigravity, Windsurf, Claude Desktop)
//   node install.js --uninstall           desliga avisos automáticos e MCP (mantém skills e histórico)
// Também funciona como: npx github:pblfrnc/Myfriends install   ·   myfriends install
// Locais (pesquisados em nov/2026):
//   Claude Code  ~/.claude/skills/<nome>/SKILL.md                       (code.claude.com/docs/en/skills)
//   Codex        ~/.agents/skills/<nome>/SKILL.md (~/.codex/skills é legado)   (developers.openai.com/codex/skills)
//   Antigravity  ~/.gemini/config/skills/<nome>/SKILL.md (~/.gemini/antigravity/skills é legado) (antigravity.google/docs/skills)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VERSION } = require('./hub');
const HK = require('./hooks-install');
const MI = require('./mcp-install');
const { defaultHome } = require('./hub');

const SKILL_DIR = path.resolve(__dirname, '..');
const NAME = 'myfriends';
const TEMPLATE = 'scripts/skill-template.md';
const userHome = () => process.env.MYFRIENDS_TARGET_HOME || os.homedir();

const TARGETS = [
  {
    id: 'claude', label: 'Claude Code',
    dir: (h) => path.join(h, '.claude', 'skills', NAME),
    marks: (h) => [path.join(h, '.claude'), path.join(h, '.claude.json')],
    bins: ['claude'],
    docs: 'https://code.claude.com/docs/en/skills',
  },
  {
    id: 'codex', label: 'OpenAI Codex',
    dir: (h) => path.join(h, '.agents', 'skills', NAME),
    marks: (h) => [process.env.CODEX_HOME || path.join(h, '.codex')],
    bins: ['codex'],
    docs: 'https://developers.openai.com/codex/skills',
  },
  {
    id: 'antigravity', label: 'Google Antigravity',
    dir: (h) => path.join(h, '.gemini', 'config', 'skills', NAME),
    marks: (h) => [path.join(h, '.gemini', 'antigravity'), path.join(h, '.gemini', 'config'), path.join(h, '.gemini', 'antigravity-cli'),
      ...(process.platform === 'darwin' ? ['/Applications/Antigravity.app', path.join(h, 'Applications', 'Antigravity.app')] : []),
      ...(process.platform === 'win32' && process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity')] : [])],
    bins: ['antigravity', 'agy'],
    docs: 'https://antigravity.google/docs/skills',
  },
];

function onPath(bin) {
  if (process.env.MYFRIENDS_NO_PATH_DETECT === '1') return null;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) { const f = path.join(d, bin + e); try { if (fs.statSync(f).isFile()) return f; } catch {} }
  }
  return null;
}

function installedVersion(dir) { try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch { return fs.existsSync(path.join(dir, 'SKILL.md')) ? '?' : null; } }

// Quais IDEs existem e se a skill já está instalada em cada uma.
function targets({ home = userHome() } = {}) {
  return TARGETS.map((t) => {
    const mark = t.marks(home).find((m) => fs.existsSync(m));
    const bin = mark ? null : t.bins.map(onPath).find(Boolean);
    const dir = t.dir(home);
    const v = installedVersion(dir);
    return { id: t.id, label: t.label, detected: !!(mark || bin), detectedBy: mark || bin || null, dir, installed: !!v, version: v, upToDate: v === VERSION, latest: VERSION, docs: t.docs };
  });
}

// O que vai para a pasta da skill (o repositório tem também site, testes, plugin…).
const SHIP = new Set(['scripts', 'README.md', 'LICENSE', 'package.json']);
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.DS_Store' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    if (dir === base && !SHIP.has(e.name) && e.name !== 'SKILL.md') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

// Conteúdo de cada arquivo da skill, com o caminho real da CLI e a ferramenta preenchidos no SKILL.md.
function render(dest, tool, src = SKILL_DIR) {
  const cli = path.join(dest, 'scripts', 'myfriends.js');
  // O modelo original (com {{MYFRIENDS_CLI}} e {{TOOL}}) viaja junto, para reinstalar a partir de uma cópia instalada.
  const tplFile = fs.existsSync(path.join(src, TEMPLATE)) ? path.join(src, TEMPLATE) : path.join(src, 'SKILL.md');
  const template = fs.readFileSync(tplFile, 'utf8');
  const skillMd = template.replace(/\{\{MYFRIENDS_CLI\}\}/g, cli.replace(/\\/g, '/')).replace(/\{\{TOOL\}\}/g, tool);
  const files = walk(src).filter((rel) => rel !== 'VERSION' && rel !== 'SKILL.md' && rel.split(path.sep).join('/') !== TEMPLATE).map((rel) => {
    const data = fs.readFileSync(path.join(src, rel));
    return { rel, path: path.join(dest, rel), data, mode: /\.(sh|js)$/.test(rel) ? 0o755 : 0o644 };
  });
  return [{ rel: 'SKILL.md', path: path.join(dest, 'SKILL.md'), data: Buffer.from(skillMd), mode: 0o644 }, ...files,
    { rel: TEMPLATE, path: path.join(dest, TEMPLATE), data: Buffer.from(template), mode: 0o644 },
    { rel: 'VERSION', path: path.join(dest, 'VERSION'), data: Buffer.from(`${VERSION}\n`), mode: 0o644 }];
}

// Copia a skill para dest de forma segura: monta numa pasta temporária ao lado e troca de uma vez.
function copySkill(dest, tool, src = SKILL_DIR) {
  const files = render(dest, tool, src);
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });
  // A pasta temporária fica um nível acima (ex.: ~/.claude/.myfriends-tmp-…), para a IDE nunca ver uma skill duplicada pela metade.
  const stage = path.dirname(parent);
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(stage, `.${NAME}-tmp-${tag}`);
  const old = path.join(stage, `.${NAME}-old-${tag}`);
  try {
    for (const f of files) {
      const p = path.join(tmp, f.rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.data, { mode: f.mode });
    }
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(tmp, dest);
    fs.rmSync(old, { recursive: true, force: true });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(dest) && fs.existsSync(old)) fs.renameSync(old, dest);
    throw e;
  }
  return files.map((f) => ({ path: f.path, bytes: f.data.length }));
}

// O que seria gravado (para a confirmação do usuário).
function plan(ids, { home = userHome(), force = false } = {}) {
  const all = targets({ home });
  const chosen = all.filter((t) => (!ids || !ids.length || ids.includes(t.id)) && (t.detected || force));
  return chosen.map((t) => ({ id: t.id, label: t.label, dir: t.dir, replaces: t.installed, hooksFile: HK.SUPPORTED.includes(t.id) ? HK.file(t.id, home) : null, files: render(t.dir, t.id).map((f) => ({ path: f.path, bytes: f.data.length })) }));
}

// hooks (padrão: sim) liga os avisos automáticos de mensagens no Claude Code e no Codex.
function install(ids, { home = userHome(), force = false, hooks = true } = {}) {
  return plan(ids, { home, force }).map((p) => {
    const r = { id: p.id, label: p.label, dir: p.dir, files: copySkill(p.dir, p.id) };
    if (hooks && p.hooksFile) {
      try { r.hooks = HK.enable(p.id, p.dir, { h: home }); } catch (e) { r.hooksError = e.message; }
    }
    return r;
  });
}

// Cópia estável dos scripts para o servidor MCP (não depende de nenhuma IDE): <hub>/app.
function appDir() { return path.join(defaultHome(), 'app'); }
function copyApp(src = SKILL_DIR) {
  const dest = appDir();
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const rel of walk(src).filter((r) => r.split(path.sep)[0] === 'scripts' || r === 'package.json')) {
    const to = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(src, rel), to);
  }
  fs.writeFileSync(path.join(tmp, 'VERSION'), `${VERSION}\n`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  return path.join(dest, 'scripts', 'mcp.js');
}

function mcpPlan(ids, { home = userHome(), force = false } = {}) {
  return MI.targets(home).filter((t) => (!ids || !ids.length || ids.includes(t.id)) && (t.detected || (force && ids && ids.includes(t.id))));
}
function installMcp(ids, { home = userHome(), force = false } = {}) {
  const list = mcpPlan(ids, { home, force });
  if (!list.length) return [];
  const script = copyApp();
  return list.map((t) => { try { return { ...t, file: MI.enable(t.id, script, { h: home }), ok: true }; } catch (e) { return { ...t, ok: false, error: e.message }; } });
}

function uninstall({ home = userHome() } = {}) {
  const out = [];
  for (const id of HK.SUPPORTED) { try { const f = HK.disable(id, { h: home }); if (f) out.push(`avisos automáticos desligados: ${f}`); } catch (e) { out.push(`${id}: ${e.message}`); } }
  for (const t of MI.MCP_TARGETS) { try { const f = MI.disable(t.id, { h: home }); if (f) out.push(`MCP removido: ${f}`); } catch (e) { out.push(`${t.id}: ${e.message}`); } }
  return out;
}

function ask(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(/^(s|sim|y|yes)$/i.test(a.trim())); });
  });
}

// CLI: node install.js [...] · myfriends install [...] · npx github:pblfrnc/Myfriends install
async function cliMain(args = process.argv.slice(2), log = (s) => console.log(s)) {
  let yes = args.includes('--yes') || args.includes('-y');
  const force = args.includes('--force');
  const noHooks = args.includes('--no-hooks');
  const noMcp = args.includes('--no-mcp');
  if (args.includes('--remove-hooks')) {
    for (const id of HK.SUPPORTED) { try { const f = HK.disable(id); if (f) log(`✔ avisos automáticos desligados: ${f}`); } catch (e) { log(`✖ ${id}: ${e.message}`); } }
    return 0;
  }
  if (args.includes('--uninstall')) {
    const r = uninstall();
    log(r.length ? r.map((x) => `✔ ${x}`).join('\n') : 'Nada para desligar.');
    log('As skills e o histórico continuam no lugar. Para apagar tudo: remova as pastas "myfriends" das skills e a pasta ~/.myfriends.');
    return 0;
  }
  const oi = args.indexOf('--only');
  const only = oi >= 0 ? String(args[oi + 1] || '').split(',').filter(Boolean) : null;
  const skillIds = only ? only.filter((x) => TARGETS.some((t) => t.id === x)) : null;
  const mcpIds = only ? only.filter((x) => MI.MCP_TARGETS.some((t) => t.id === x)) : null;
  const ts = targets();
  const ms = MI.targets();
  log(`MyFriends ${VERSION} — ferramentas nesta máquina:`);
  for (const t of ts) log(`  ${t.detected ? '✔' : '·'} ${t.label.padEnd(24)} ${t.detected ? 'encontrada' : 'não encontrada'}${t.installed ? ` · skill ${t.version}${t.upToDate ? '' : ' (desatualizada)'}` : ''}`);
  for (const t of ms) log(`  ${t.detected ? '✔' : '·'} ${t.label.padEnd(24)} ${t.detected ? 'encontrada' : 'não encontrada'}${t.enabled ? ' · MCP ligado' : ''}  (via MCP)`);
  const p = only && !skillIds.length ? [] : plan(skillIds, { force });
  const mp = noMcp || (only && !mcpIds.length) ? [] : mcpPlan(mcpIds, { force });
  if (!p.length && !mp.length) { log('\nNenhuma ferramenta compatível encontrada. Use --force --only <id> para instalar mesmo assim.'); return 0; }
  log('\nSerá gravado:');
  for (const x of p) {
    log(`  ${x.label}: skill em ${x.dir}${x.replaces ? ' (substitui a versão instalada)' : ''}`);
    if (x.hooksFile && !noHooks) log(`     + avisos automáticos (hooks) em ${x.hooksFile} — outros ganchos mantidos; cópia de segurança .myfriends.bak`);
  }
  for (const x of mp) log(`  ${x.label}: servidor MCP "myfriends" em ${x.file} — o resto do arquivo é mantido; cópia de segurança .myfriends.bak`);
  if (!yes) yes = await ask('\nInstalar agora? [s/N] ');
  if (!yes) { log('\nNada foi alterado. Rode de novo com --yes para instalar.'); return 0; }
  const res = p.length ? install(skillIds, { force, hooks: !noHooks }) : [];
  for (const r of res) {
    log(`✔ ${r.label}: ${r.dir}`);
    if (r.hooks) log(`  ✔ avisos automáticos ligados (${r.hooks})`);
    if (r.hooksError) log(`  ✖ avisos automáticos: ${r.hooksError}`);
  }
  for (const r of mp.length ? installMcp(mcpIds, { force }) : []) log(r.ok ? `✔ ${r.label}: MCP ligado (${r.file})` : `✖ ${r.label}: ${r.error}`);
  log('\nPronto. Abra uma nova sessão do agente (ou reinicie a IDE) para carregar o MyFriends.');
  if (res.some((r) => r.id === 'codex' && r.hooks)) log('No Codex: na primeira vez, rode /hooks e marque os ganchos do MyFriends como confiáveis (o Codex exige essa revisão).');
  if (mp.length) log('Nas IDEs com MCP: confira se o servidor "myfriends" aparece ligado na lista de MCP (algumas pedem para você aprovar).');
  log('Ver tudo no navegador: myfriends painel   ·   Desligar avisos e MCP: myfriends uninstall');
  return 0;
}

module.exports = { targets, plan, install, copySkill, render, TARGETS, SKILL_DIR, VERSION, hooks: HK, mcp: MI, mcpPlan, installMcp, copyApp, appDir, uninstall, cliMain };

if (require.main === module) cliMain().then((c) => { process.exitCode = c; });
