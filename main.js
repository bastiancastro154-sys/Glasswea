const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, desktopCapturer, shell, dialog } = require('electron');
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const claudeHooks = require('./hooks');

const HOOK_PORT = claudeHooks.PORT;
const WIN_W = 480;
const WIN_H = 400;
const AUDIO_SCRIPT = path.join(__dirname, 'scripts', 'audio.ps1').replace('app.asar', 'app.asar.unpacked');
const APPS_SCRIPT = path.join(__dirname, 'scripts', 'apps.ps1').replace('app.asar', 'app.asar.unpacked');
const MAX_FAVORITES = 10;
const MEDIA_SCRIPT = path.join(__dirname, 'scripts', 'media.ps1').replace('app.asar', 'app.asar.unpacked');

// Sin empaquetar, el arranque automático debe lanzar electron.exe apuntando a esta carpeta.
const LOGIN = app.isPackaged ? {} : { path: process.execPath, args: [`"${app.getAppPath()}"`] };

let win = null;
const DEFAULTS = { blur: true, blurPx: 18, tint: 50, dark: 30, sheen: 60, colorMode: 'auto', color: '#7f8cff', focusMin: 25, breakMin: 5,
  showVolume: true, showActions: true, showFavorites: true };
let settings = { ...DEFAULTS, favorites: [] };
let settingsWin = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch { /* primera vez */ }
  if (!Array.isArray(settings.favorites)) settings.favorites = [];
}
function saveSettings() { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch { /* sin permisos */ } }
let tray = null;
let mediaProc = null;

if (!app.requestSingleInstanceLock()) app.quit();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function placeWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  win.setBounds({ x: Math.round(bounds.x + (bounds.width - WIN_W) / 2), y: bounds.y, width: WIN_W, height: WIN_H });
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  placeWindow();
  win.setAlwaysOnTop(true, 'screen-saver');
  // La ventana es más grande que la isla: los clics la atraviesan salvo cuando el ratón está sobre la isla.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  screen.on('display-metrics-changed', () => { placeWindow(); send('blur-changed'); });
  win.webContents.on('did-finish-load', () => send('settings', settings));
  applyContentProtection();
}

// ---------- Desenfoque ----------
// Electron no puede difuminar el escritorio detrás de una ventana transparente con forma libre.
// Se captura la pantalla a baja resolución y la isla muestra, difuminada, la zona que tiene detrás.
// La ventana se excluye de la captura para que la isla no se capture a sí misma.
function applyContentProtection() {
  if (win && !win.isDestroyed()) win.setContentProtection(settings.blur);
}

ipcMain.handle('blur-config', async () => {
  if (!settings.blur) return { enabled: false };
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source) return { enabled: false };
  const b = win.getBounds();
  return {
    enabled: true, sourceId: source.id,
    screenW: display.bounds.width, screenH: display.bounds.height,
    winX: b.x - display.bounds.x, winY: b.y - display.bounds.y,
  };
});

// ---------- Música (Windows System Media Transport Controls vía PowerShell) ----------
function ps(args) {
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', MEDIA_SCRIPT, ...args],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

let lastMediaError = '';
function logMediaError(msg) {
  if (msg === lastMediaError) return;
  lastMediaError = msg;
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'media.log'), `${new Date().toISOString()} carátula: ${msg}\n`); } catch { /* sin permisos */ }
}

function startMediaWatcher() {
  if (process.platform !== 'win32') return;
  mediaProc = ps(['-Action', 'watch']);
  let buf = '';
  mediaProc.stdout.setEncoding('utf8');
  mediaProc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        if (d.thumbError) logMediaError(d.thumbError);
        send('media', d);
      } catch { /* línea incompleta */ }
    }
  });
  mediaProc.on('exit', () => { mediaProc = null; if (!app.isQuitting) setTimeout(startMediaWatcher, 3000); });
}

ipcMain.on('media-control', (_e, action) => {
  if (process.platform !== 'win32') return;
  if (['toggle', 'next', 'prev'].includes(action)) ps(['-Action', action]);
});

ipcMain.on('set-interactive', (_e, on) => {
  if (!win) return;
  if (on) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});

// ---------- Volumen y micrófono (ayudante de PowerShell; las órdenes van por un socket local) ----------
let audioProc = null;
let audioSocket = null;
let audioServer = null;
let audioState = null;
let audioRestarts = 0;

function startAudio() {
  if (process.platform !== 'win32') return;
  audioServer = net.createServer((sock) => {
    audioSocket = sock;
    sock.on('error', () => {});
    sock.on('close', () => { if (audioSocket === sock) audioSocket = null; });
  });
  audioServer.on('error', (e) => console.error('Audio:', e.message));
  audioServer.listen(0, '127.0.0.1', spawnAudio);
}

function spawnAudio() {
  const { port } = audioServer.address();
  audioProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', AUDIO_SCRIPT, '-Port', String(port)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  let err = '';
  audioProc.stdout.setEncoding('utf8');
  audioProc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { audioState = JSON.parse(line); audioRestarts = 0; send('audio', audioState); } catch { /* línea incompleta */ }
    }
  });
  audioProc.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
  audioProc.on('exit', () => {
    audioProc = null;
    if (err) { try { fs.appendFileSync(path.join(app.getPath('userData'), 'audio.log'), `${new Date().toISOString()}\n${err}\n`); } catch { /* sin permisos */ } }
    // Si falla varias veces seguidas no se insiste: el motivo queda en audio.log.
    if (!app.isQuitting && ++audioRestarts <= 3) setTimeout(spawnAudio, 3000);
  });
}

ipcMain.handle('audio-get', () => audioState);
ipcMain.on('audio-command', (_e, cmd, value) => {
  if (!audioSocket) return;
  if (cmd === 'vol' && Number.isFinite(value)) audioSocket.write(`vol ${Math.min(1, Math.max(0, value)).toFixed(3)}\n`);
  else if (cmd === 'mute' || cmd === 'mic') audioSocket.write(`${cmd}\n`);
});

// ---------- Acciones rápidas ----------
ipcMain.on('quick-action', (_e, name) => {
  if (process.platform !== 'win32') return;
  if (name === 'screenshot') shell.openExternal('ms-screenclip:');
  else if (name === 'lock') spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
});

// ---------- Apps favoritas ----------
const iconCache = new Map();
async function fileIcon(p) {
  if (!iconCache.has(p)) {
    let icon = null;
    try { icon = (await app.getFileIcon(p, { size: 'large' })).toDataURL(); } catch { /* sin icono: se muestra la inicial */ }
    iconCache.set(p, icon);
  }
  return iconCache.get(p);
}
function favoritesWithIcons() {
  // Las apps de la Tienda guardan su icono al añadirse; el resto se lee del archivo.
  return Promise.all(settings.favorites.map(async (f) => ({ ...f, icon: f.icon || (f.path ? await fileIcon(f.path) : null) })));
}

// Búsqueda de aplicaciones instaladas. En Windows la lista sale del propio menú Inicio (nombres e
// iconos como los muestra el sistema); si eso falla, se recurre a los accesos directos .lnk.
let appsCache = null;
const SKIP = /uninstall|desinstalar|readme|l[eé]eme|\bhelp\b|ayuda|documenta|website|sitio web|licen[sc]|release notes|manual|\bfaq\b/i;
const NOT_AN_APP = /^https?:|\.(url|chm|txt|html?|pdf|rtf)$/i;
function scanShortcuts() {
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    dirs.push(path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  if (process.env.GLASS_ISLAND_APP_DIRS) dirs.push(...process.env.GLASS_ISLAND_APP_DIRS.split(path.delimiter)); // para pruebas
  const found = new Map();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.lnk$/i.test(e.name)) {
        const name = e.name.slice(0, -4);
        if (SKIP.test(name)) continue;
        if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, path: full });
      }
    }
  };
  dirs.forEach((d) => walk(d, 0));
  return [...found.values()];
}
function scanStoreApps() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', APPS_SCRIPT],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => p.kill(), 45000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', () => { clearTimeout(timer); resolve([]); });
    p.on('exit', () => {
      clearTimeout(timer);
      try { const list = JSON.parse(out); resolve(Array.isArray(list) ? list : []); } catch { resolve([]); }
    });
  });
}
async function listApps(force) {
  if (appsCache && !force) return appsCache;
  const seen = new Set();
  let list = (await scanStoreApps())
    .filter((s) => s && typeof s.name === 'string' && s.name && typeof s.appId === 'string' && s.appId)
    .filter((s) => !SKIP.test(s.name) && !NOT_AN_APP.test(s.appId))
    .filter((s) => !seen.has(s.name.toLowerCase()) && seen.add(s.name.toLowerCase()))
    .map((s) => ({ name: s.name, appId: s.appId, icon: typeof s.icon === 'string' ? s.icon : null }));
  if (!list.length) list = await Promise.all(scanShortcuts().map(async (a) => ({ ...a, icon: await fileIcon(a.path) })));
  appsCache = list
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
    .map((a, id) => ({ ...a, id }));
  return appsCache;
}
ipcMain.handle('apps-list', (_e, force) => listApps(!!force));
ipcMain.handle('favorites-add-app', async (_e, id) => {
  const a = appsCache && appsCache[id];
  if (!a || settings.favorites.length >= MAX_FAVORITES) return;
  if (settings.favorites.some((f) => (a.appId ? f.appId === a.appId : f.path === a.path))) return;
  settings.favorites.push(a.appId ? { name: a.name, appId: a.appId, icon: a.icon } : { name: a.name, path: a.path });
  saveSettings();
  await broadcastFavorites();
});
async function broadcastFavorites() {
  const list = await favoritesWithIcons();
  send('favorites', list);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('favorites', list);
}
ipcMain.handle('favorites-get', favoritesWithIcons);
ipcMain.handle('favorites-add', async (_e, kind) => {
  if (settings.favorites.length >= MAX_FAVORITES) return;
  const startMenu = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const opts = kind === 'folder'
    ? { title: 'Elegir carpeta', properties: ['openDirectory'] }
    : { title: 'Elegir aplicación', defaultPath: startMenu, properties: ['openFile'],
        filters: [{ name: 'Aplicaciones y accesos directos', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }, { name: 'Todos los archivos', extensions: ['*'] }] };
  const r = await dialog.showOpenDialog(settingsWin, opts);
  if (r.canceled || !r.filePaths[0]) return;
  const p = r.filePaths[0];
  if (settings.favorites.some((f) => f.path === p)) return;
  settings.favorites.push({ name: path.parse(p).name || p, path: p });
  saveSettings();
  await broadcastFavorites();
});
ipcMain.on('favorites-remove', (_e, index) => {
  if (!Number.isInteger(index) || !settings.favorites[index]) return;
  settings.favorites.splice(index, 1);
  saveSettings();
  broadcastFavorites();
});
ipcMain.on('favorite-open', (_e, index) => {
  const f = settings.favorites[index];
  if (!f) return;
  if (f.appId) spawn('explorer.exe', [`shell:AppsFolder\\${f.appId}`], { detached: true, stdio: 'ignore' }).unref();
  else shell.openPath(f.path);
});

// ---------- Claude Code (los hooks hacen POST aquí) ----------
function startHookServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.writeHead(204).end();
      let ev;
      try { ev = JSON.parse(body); } catch { return; }
      const project = ev.cwd ? path.basename(ev.cwd) : '';
      const map = {
        SessionStart: { state: 'idle', detail: 'Sesión lista' },
        UserPromptSubmit: { state: 'working', detail: 'Pensando…' },
        PreToolUse: { state: 'working', detail: ev.tool_name || 'Trabajando…' },
        PostToolUse: { state: 'working', detail: 'Pensando…' },
        Notification: { state: 'attention', detail: ev.message || 'Necesita tu atención' },
        Stop: { state: 'done', detail: 'Terminó' },
        SessionEnd: { state: 'off', detail: '' },
      };
      const m = map[ev.hook_event_name];
      if (m) send('claude', { ...m, project, at: Date.now() });
    });
  });
  server.on('error', (e) => console.error('Servidor de hooks:', e.message));
  server.listen(HOOK_PORT, '127.0.0.1');
}

// ---------- Configuración ----------
function openSettings(section) {
  const hash = typeof section === 'string' && /^[a-z-]+$/.test(section) ? section : '';
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    if (hash) settingsWin.webContents.send('focus-section', hash);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 440, height: Math.min(900, screen.getPrimaryDisplay().workAreaSize.height - 80),
    useContentSize: true, resizable: false, maximizable: false, fullscreenable: false,
    title: 'Glass Island · Configuración', backgroundColor: '#16161d', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), hash ? { hash } : undefined);
}
ipcMain.on('open-settings', (_e, section) => openSettings(section));

// Vinculación con Claude Code (hooks en ~/.claude/settings.json)
ipcMain.handle('claude-link-status', () => claudeHooks.status());
ipcMain.handle('claude-link-set', (_e, link) => {
  const result = claudeHooks.set(!!link);
  send('claude-link', result);
  return result;
});
ipcMain.handle('settings-get', () => ({ ...settings, openAtLogin: app.getLoginItemSettings(LOGIN).openAtLogin }));
ipcMain.on('settings-set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  if (patch.reset) patch = { ...DEFAULTS };
  if ('openAtLogin' in patch) app.setLoginItemSettings({ ...LOGIN, openAtLogin: !!patch.openAtLogin });
  const blurBefore = settings.blur;
  for (const k of Object.keys(DEFAULTS)) {
    if (k in patch && typeof patch[k] === typeof DEFAULTS[k]) settings[k] = patch[k];
  }
  saveSettings();
  send('settings', settings);
  if (settings.blur !== blurBefore) { applyContentProtection(); send('blur-changed'); }
});

// ---------- Actualizaciones (solo en la versión instalada; las publica GitHub Releases) ----------
let updateReady = null;
function startUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.on('error', (e) => {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), `${new Date().toISOString()} ${e && e.message}\n`); } catch { /* sin permisos */ }
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = { version: info.version, install: () => { app.isQuitting = true; autoUpdater.quitAndInstall(true, true); } };
    buildTrayMenu();
    send('update-ready', info.version);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip(`Glass Island ${app.getVersion()}`);
  buildTrayMenu();
}
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(updateReady ? [{ label: `Reiniciar para actualizar a ${updateReady.version}`, click: () => updateReady.install() }, { type: 'separator' }] : []),
    { label: 'Mostrar / ocultar', click: () => (win.isVisible() ? win.hide() : win.showInactive()) },
    { label: 'Configuración…', click: () => openSettings() },
    { type: 'separator' },
    { label: `Versión ${app.getVersion()}`, enabled: false },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  createTray();
  startMediaWatcher();
  startHookServer();
  startAudio();
  startUpdater();
});
app.on('before-quit', () => { app.isQuitting = true; if (mediaProc) mediaProc.kill(); if (audioProc) audioProc.kill(); });
app.on('window-all-closed', () => { if (app.isQuitting) app.quit(); });
