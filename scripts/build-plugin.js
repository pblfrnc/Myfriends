#!/usr/bin/env node
'use strict';
// Gera skills/myfriends/SKILL.md (a skill dos plugins do Claude Code e do Codex) a partir do SKILL.md
// da raiz, que é o modelo usado pelo instalador. Rode depois de mudar o SKILL.md: npm run build:plugin
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function pluginSkill(src = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')) {
  return src
    .replace(/node "\{\{MYFRIENDS_CLI\}\}"/g, 'myfriends')
    .replace(/ --tool \{\{TOOL\}\}/g, '')
    .replace(/^\(If the path above still shows a `\{\{…\}\}` placeholder.*$/m, '(`myfriends` is on your PATH when MyFriends is installed as a plugin or with npm. If the command is not found, use the exact command shown in the "MyFriends está ativo" note, or `node <this skill\'s folder>/../../scripts/myfriends.js`.)')
    .replace(/^Always pass `--tool \{\{TOOL\}\}` and run it/m, 'With the plugin, your session id is in the "MyFriends está ativo" note: pass `--session <id>` on every command, and run it')
    .replace(/\{\{TOOL\}\}/g, 'claude');
}

if (require.main === module) {
  const out = path.join(root, 'skills', 'myfriends', 'SKILL.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pluginSkill());
  console.log(`✔ ${path.relative(root, out)}`);
}
module.exports = { pluginSkill };
