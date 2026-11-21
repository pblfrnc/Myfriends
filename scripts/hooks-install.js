'use strict';
// Liga/desliga os ganchos (hooks) do MyFriends no Claude Code e no Codex.
// Os ganchos fazem as mensagens chegarem sozinhas: aparecem para você (aviso na IDE + notificação do
// sistema) e entram na conversa do agente. Os ganchos de outros programas ficam intactos.
//   Claude Code: ~/.claude/settings.json → "hooks"        (code.claude.com/docs/en/hooks)
//   Codex:       ~/.codex/hooks.json (ou $CODEX_HOME)       (developers.openai.com/codex/hooks)
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARK = /myfriends[\\/]scripts[\\/]hook\.js|myfriends-hook/;
const home = () => process.env.MYFRIENDS_TARGET_HOME || os.homedir();
const q = (p) => `"${String(p).replace(/"/g, '\\"')}"`;

function file(tool, h = home()) {
  if (tool === 'claude') return path.join(h, '.claude', 'settings.json');
  if (tool === 'codex') return path.join(process.env.MYFRIENDS_TARGET_HOME ? path.join(h, '.codex') : process.env.CODEX_HOME || path.join(h, '.codex'), 'hooks.json');
  return null;
}

// Os ganchos de cada IDE, apontando para o hook.js da skill instalada.
function wanted(tool, skillDir, node = process.execPath) {
  const base = `${q(node)} ${q(path.join(skillDir, 'scripts', 'hook.js'))} ${tool}`;
  const cmd = (extra = {}) => ({ type: 'command', command: base, timeout: 10, ...extra });
  const watcher = tool === 'claude'
    ? { type: 'command', command: `${base} watch`, asyncRewake: true }
    : { type: 'command', command: `${base} watch`, async: true };
  return {
    SessionStart: [{ hooks: [cmd(), watcher] }],
    UserPromptSubmit: [{ hooks: [cmd()] }],
    PostToolUse: [{ matcher: tool === 'claude' ? '*' : '.*', hooks: [cmd()] }],
    Stop: [{ hooks: [cmd(), watcher] }],
    SessionEnd: [{ hooks: [cmd({ timeout: tool === 'codex' ? 3 : 5 })] }],
  };
}

const ours = (h) => MARK.test(String(h?.command || ''));

// Tira os ganchos do MyFriends de um objeto "hooks", mantendo todo o resto.
function strip(hooks = {}) {
  const outH = {};
  for (const [ev, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) { outH[ev] = groups; continue; }
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const hs = g.hooks.filter((h) => !ours(h));
      if (hs.length) kept.push({ ...g, hooks: hs });
    }
    if (kept.length) outH[ev] = kept;
  }
  return outH;
}

function readJson(f) {
  if (!fs.existsSync(f)) return {};
  const txt = fs.readFileSync(f, 'utf8');
  if (!txt.trim()) return {};
  try { return JSON.parse(txt); } catch { throw new Error(`não consegui ler ${f} (JSON inválido); corrija o arquivo ou rode com --no-hooks`); }
}

function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const bak = `${f}.myfriends.bak`;
  if (fs.existsSync(f) && !fs.existsSync(bak)) fs.copyFileSync(f, bak);
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, f);
}

function status(tool, h = home()) {
  const f = file(tool, h);
  if (!f) return { tool, supported: false };
  try {
    const d = readJson(f);
    const hooks = tool === 'claude' ? d.hooks : d.hooks;
    const on = Object.values(hooks || {}).some((gs) => Array.isArray(gs) && gs.some((g) => g?.hooks?.some(ours)));
    return { tool, supported: true, file: f, enabled: on };
  } catch (e) { return { tool, supported: true, file: f, enabled: false, error: e.message }; }
}

function enable(tool, skillDir, { h = home(), node } = {}) {
  const f = file(tool, h);
  if (!f) return null;
  const d = readJson(f);
  const hooks = strip(d.hooks);
  for (const [ev, groups] of Object.entries(wanted(tool, skillDir, node))) hooks[ev] = [...(hooks[ev] || []), ...groups];
  writeJson(f, { ...d, hooks });
  return f;
}

function disable(tool, { h = home() } = {}) {
  const f = file(tool, h);
  if (!f || !fs.existsSync(f)) return null;
  const d = readJson(f);
  const hooks = strip(d.hooks);
  const outD = { ...d };
  if (Object.keys(hooks).length) outD.hooks = hooks; else delete outD.hooks;
  writeJson(f, outD);
  return f;
}

module.exports = { file, wanted, strip, status, enable, disable, SUPPORTED: ['claude', 'codex'] };
