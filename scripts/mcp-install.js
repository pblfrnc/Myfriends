'use strict';
// Liga o servidor MCP do MyFriends nas IDEs que falam MCP. Só mexe na entrada "myfriends" de cada
// arquivo; o resto da configuração fica como está, e é feita uma cópia de segurança na 1ª vez.
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = () => process.env.MYFRIENDS_TARGET_HOME || os.homedir();
const appData = (h) => (process.env.APPDATA && !process.env.MYFRIENDS_TARGET_HOME ? process.env.APPDATA : path.join(h, 'AppData', 'Roaming'));
const macSupport = (h) => path.join(h, 'Library', 'Application Support');
const xdg = (h) => process.env.XDG_CONFIG_HOME && !process.env.MYFRIENDS_TARGET_HOME ? process.env.XDG_CONFIG_HOME : path.join(h, '.config');
const userDir = (h, app) => process.platform === 'darwin' ? path.join(macSupport(h), app) : process.platform === 'win32' ? path.join(appData(h), app) : path.join(xdg(h), app);

// format: "mcpServers" (Cursor, Copilot CLI, Antigravity, Windsurf, Claude Desktop) ou "servers" (VS Code).
const MCP_TARGETS = [
  { id: 'cursor', label: 'Cursor', file: (h) => path.join(h, '.cursor', 'mcp.json'), marks: (h) => [path.join(h, '.cursor')], format: 'mcpServers', docs: 'https://cursor.com/docs/context/mcp' },
  { id: 'copilot', label: 'GitHub Copilot CLI', file: (h) => path.join(process.env.COPILOT_HOME && !process.env.MYFRIENDS_TARGET_HOME ? process.env.COPILOT_HOME : path.join(h, '.copilot'), 'mcp-config.json'), marks: (h) => [path.join(h, '.copilot')], format: 'mcpServers', docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers' },
  { id: 'vscode', label: 'VS Code (Copilot Chat)', file: (h) => path.join(userDir(h, 'Code'), 'User', 'mcp.json'), marks: (h) => [path.join(userDir(h, 'Code'), 'User')], format: 'servers', docs: 'https://code.visualstudio.com/docs/agents/reference/mcp-configuration' },
  { id: 'antigravity', label: 'Google Antigravity', file: (h) => path.join(h, '.gemini', 'config', 'mcp_config.json'), marks: (h) => [path.join(h, '.gemini', 'config'), path.join(h, '.gemini', 'antigravity'), path.join(h, '.gemini', 'antigravity-ide')], format: 'mcpServers', docs: 'https://antigravity.google/docs/mcp' },
  { id: 'windsurf', label: 'Windsurf', file: (h) => path.join(h, '.codeium', 'windsurf', 'mcp_config.json'), marks: (h) => [path.join(h, '.codeium', 'windsurf')], format: 'mcpServers', docs: 'https://docs.windsurf.com/windsurf/cascade/mcp' },
  { id: 'claude-desktop', label: 'Claude Desktop', file: (h) => path.join(userDir(h, 'Claude'), 'claude_desktop_config.json'), marks: (h) => [userDir(h, 'Claude')], format: 'mcpServers', docs: 'https://modelcontextprotocol.io/quickstart/user' },
];

const KEY = 'myfriends';

function readJson(f) {
  if (!fs.existsSync(f)) return {};
  const txt = fs.readFileSync(f, 'utf8');
  if (!txt.trim()) return {};
  try { return JSON.parse(txt); } catch { throw new Error(`não consegui ler ${f} (JSON inválido ou com comentários); adicione o MyFriends manualmente ou corrija o arquivo`); }
}
function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const bak = `${f}.myfriends.bak`;
  if (fs.existsSync(f) && !fs.existsSync(bak)) fs.copyFileSync(f, bak);
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, f);
}

function targets(h = home()) {
  return MCP_TARGETS.map((t) => {
    const file = t.file(h);
    const mark = t.marks(h).find((m) => fs.existsSync(m));
    let enabled = false;
    try { const d = readJson(file); enabled = !!(d[t.format] && d[t.format][KEY]); } catch {}
    return { id: t.id, label: t.label, file, format: t.format, detected: !!mark, detectedBy: mark || null, enabled, docs: t.docs };
  });
}

function entry(t, mcpScript, node = process.execPath) {
  const base = { command: node, args: [mcpScript, '--tool', t.id] };
  return t.format === 'servers' ? { type: 'stdio', ...base } : base;
}

function enable(id, mcpScript, { h = home(), node } = {}) {
  const t = MCP_TARGETS.find((x) => x.id === id);
  if (!t) return null;
  const file = t.file(h);
  const d = readJson(file);
  d[t.format] = { ...(d[t.format] || {}), [KEY]: entry(t, mcpScript, node) };
  writeJson(file, d);
  return file;
}

function disable(id, { h = home() } = {}) {
  const t = MCP_TARGETS.find((x) => x.id === id);
  if (!t) return null;
  const file = t.file(h);
  if (!fs.existsSync(file)) return null;
  const d = readJson(file);
  if (!d[t.format] || !d[t.format][KEY]) return null;
  delete d[t.format][KEY];
  writeJson(file, d);
  return file;
}

module.exports = { MCP_TARGETS, targets, enable, disable, entry, KEY };
