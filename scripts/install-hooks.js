// Añade (o quita con --remove) los hooks de Claude Code que avisan a Glass Island.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 47821;
const MARK = `127.0.0.1:${PORT}/hook`;
const COMMAND = `curl -s -m 1 -X POST -H "Content-Type: application/json" --data-binary @- http://${MARK} || exit 0`;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const WITH_MATCHER = new Set(['PreToolUse', 'PostToolUse']);

const file = path.join(os.homedir(), '.claude', 'settings.json');
const remove = process.argv.includes('--remove');

let settings = {};
if (fs.existsSync(file)) {
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.copyFileSync(file, file + '.bak');
}
settings.hooks = settings.hooks || {};

for (const ev of EVENTS) {
  const groups = (settings.hooks[ev] || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !(h.command || '').includes(MARK)) }))
    .filter((g) => g.hooks.length);
  if (!remove) {
    const group = { hooks: [{ type: 'command', command: COMMAND }] };
    if (WITH_MATCHER.has(ev)) group.matcher = '*';
    groups.push(group);
  }
  if (groups.length) settings.hooks[ev] = groups;
  else delete settings.hooks[ev];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? 'Hooks eliminados de' : 'Hooks instalados en'} ${file}${fs.existsSync(file + '.bak') ? ' (copia previa en settings.json.bak)' : ''}`);
