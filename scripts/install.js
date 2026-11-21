#!/usr/bin/env node
// Instala a skill MyFriends nas IDEs encontradas nesta máquina (sem dependências).
//   node install.js                 mostra o que seria gravado (nada é alterado)
//   node install.js --yes           instala/atualiza onde a IDE existir
//   node install.js --yes --only claude,codex
//   node install.js --yes --no-hooks     instala só a skill, sem os avisos automáticos de mensagens
//   node install.js --remove-hooks        desliga os avisos automáticos (mantém a skill)
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

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.DS_Store' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
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

module.exports = { targets, plan, install, copySkill, render, TARGETS, SKILL_DIR, VERSION, hooks: HK };

if (require.main === module) {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes') || args.includes('-y');
  const force = args.includes('--force');
  const noHooks = args.includes('--no-hooks');
  if (args.includes('--remove-hooks')) {
    for (const id of HK.SUPPORTED) { try { const f = HK.disable(id); if (f) console.log(`✔ avisos automáticos desligados: ${f}`); } catch (e) { console.log(`✖ ${id}: ${e.message}`); } }
    process.exit(0);
  }
  const oi = args.indexOf('--only');
  const only = oi >= 0 ? String(args[oi + 1] || '').split(',').filter(Boolean) : null;
  const ts = targets();
  console.log(`MyFriends ${VERSION} — IDEs nesta máquina:`);
  for (const t of ts) console.log(`  ${t.detected ? '✔' : '·'} ${t.label.padEnd(20)} ${t.detected ? `encontrada (${t.detectedBy})` : 'não encontrada'}${t.installed ? ` · instalada ${t.version}${t.upToDate ? '' : ' (desatualizada)'}` : ''}`);
  const p = plan(only, { force });
  if (!p.length) { console.log('\nNenhuma IDE compatível encontrada. Use --force --only <ide> para instalar mesmo assim.'); process.exit(0); }
  console.log('\nSerá gravado:');
  for (const x of p) { console.log(`  ${x.label}: ${x.dir}${x.replaces ? ' (substitui a versão instalada)' : ''}`); for (const f of x.files) console.log(`     ${f.path}  (${f.bytes} bytes)`);
    if (x.hooksFile && !noHooks) console.log(`     + avisos automáticos de mensagens (hooks) em ${x.hooksFile} — os outros ganchos são mantidos; cópia de segurança em ${path.basename(x.hooksFile)}.myfriends.bak`); }
  if (!yes) { console.log('\nNada foi alterado. Rode de novo com --yes para instalar.'); process.exit(0); }
  const res = install(only, { force, hooks: !noHooks });
  for (const r of res) {
    console.log(`✔ ${r.label}: ${r.dir}`);
    if (r.hooks) console.log(`  ✔ avisos automáticos ligados (${r.hooks})`);
    if (r.hooksError) console.log(`  ✖ avisos automáticos: ${r.hooksError}`);
  }
  console.log('\nPronto. Abra uma nova sessão do agente (ou reinicie a IDE) para carregar a skill.');
  if (res.some((r) => r.id === 'codex' && r.hooks)) console.log('No Codex: na primeira vez, rode /hooks e marque os ganchos do MyFriends como confiáveis (o Codex exige essa revisão).');
  if (!noHooks) console.log('Para desligar os avisos automáticos: node scripts/install.js --remove-hooks');
}
