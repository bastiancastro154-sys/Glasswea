// Vinculación con Claude Code: añade o quita en ~/.claude/settings.json los hooks que avisan a Glass Island.
// Lo usan tanto la app (botón "Vincular") como scripts/install-hooks.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 47821;
const MARK = `127.0.0.1:${PORT}/hook`;
const COMMAND = `curl -s -m 1 -X POST -H "Content-Type: application/json" --data-binary @- http://${MARK} || exit 0`;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const WITH_MATCHER = new Set(['PreToolUse', 'PostToolUse']);
// Consumo del plan: Claude Code entrega esos datos a su "barra de estado". El comando se los reenvía a la
// isla y muestra en Claude Code la línea de texto que la isla le devuelve.
const SL_MARK = `127.0.0.1:${PORT}/statusline`;
const SL_COMMAND = `${process.platform === 'win32' ? 'curl.exe' : 'curl'} -s -m 2 -X POST -H "Content-Type: application/json" --data-binary "@-" http://${SL_MARK}`;

const claudeDir = () => path.join(os.homedir(), '.claude');
const settingsFile = () => path.join(claudeDir(), 'settings.json');

function read() {
  const file = settingsFile();
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  const data = JSON.parse(text); // si no es JSON válido se lanza el error: no se sobrescribe nada
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('settings.json no contiene un objeto');
  return data;
}

function isOurs(group) {
  return (group.hooks || []).some((h) => (h.command || '').includes(MARK));
}

function status() {
  const result = { linked: false, usage: 'off', claudeFound: fs.existsSync(claudeDir()), file: settingsFile(), error: null };
  try {
    const data = read();
    const hooks = data.hooks || {};
    const sl = data.statusLine;
    // 'foreign': el usuario ya tiene su propia barra de estado; no se toca.
    result.usage = !sl ? 'off' : String(sl.command || '').includes(SL_MARK) ? 'on' : 'foreign';
    result.linked = EVENTS.every((ev) => Array.isArray(hooks[ev]) && hooks[ev].some(isOurs));
  } catch (e) {
    result.error = `No se pudo leer ${settingsFile()}: ${e.message}`;
  }
  return result;
}

function set(link) {
  let settings;
  try { settings = read(); } catch (e) { return { ...status(), error: `No se pudo leer ${settingsFile()}: ${e.message}` }; }
  try {
    const file = settingsFile();
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
    for (const ev of EVENTS) {
      const groups = (Array.isArray(hooks[ev]) ? hooks[ev] : [])
        .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !(h.command || '').includes(MARK)) }))
        .filter((g) => g.hooks.length);
      if (link) {
        const group = { hooks: [{ type: 'command', command: COMMAND }] };
        if (WITH_MATCHER.has(ev)) group.matcher = '*';
        groups.push(group);
      }
      if (groups.length) hooks[ev] = groups; else delete hooks[ev];
    }
    if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (e) {
    return { ...status(), error: `No se pudo escribir la configuración: ${e.message}` };
  }
  return status();
}

function setUsage(on) {
  let settings;
  try { settings = read(); } catch (e) { return { ...status(), error: `No se pudo leer ${settingsFile()}: ${e.message}` }; }
  const sl = settings.statusLine;
  const ours = sl && String(sl.command || '').includes(SL_MARK);
  if (sl && !ours) return { ...status(), error: 'Ya tienes una barra de estado personalizada en Claude Code; no se modificó.' };
  try {
    const file = settingsFile();
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    if (on) settings.statusLine = { type: 'command', command: SL_COMMAND };
    else delete settings.statusLine;
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (e) {
    return { ...status(), error: `No se pudo escribir la configuración: ${e.message}` };
  }
  return status();
}

module.exports = { PORT, status, set, setUsage };
