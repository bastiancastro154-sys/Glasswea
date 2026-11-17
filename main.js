const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, desktopCapturer, shell, dialog, Notification, powerMonitor } = require('electron');
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const claudeHooks = require('./hooks');

const HOOK_PORT = claudeHooks.PORT;
const DRAWER_W = 236; // ancho del panel lateral
const WIN_H_BASE = 640;
// La ventana es transparente y mayor que la isla: deja sitio a ambos lados para el panel lateral. Su tamaño
// depende del ancho elegido para la columna principal y de la escala.
function winSize() {
  const z = settings.scale / 100;
  return { w: Math.round((settings.mainWidth + 2 * (DRAWER_W + 24)) * z), h: Math.round(WIN_H_BASE * z) };
}
const AUDIO_SCRIPT = path.join(__dirname, 'scripts', 'audio.ps1').replace('app.asar', 'app.asar.unpacked');
const APPS_SCRIPT = path.join(__dirname, 'scripts', 'apps.ps1').replace('app.asar', 'app.asar.unpacked');
const MAX_FAVORITES = 30;
const MEDIA_SCRIPT = path.join(__dirname, 'scripts', 'media.ps1').replace('app.asar', 'app.asar.unpacked');

// Sin empaquetar, el arranque automático debe lanzar electron.exe apuntando a esta carpeta.
const LOGIN = app.isPackaged ? {} : { path: process.execPath, args: [`"${app.getAppPath()}"`] };

let win = null;
const DEFAULTS = { blur: true, blurPx: 18, tint: 50, dark: 30, sheen: 60, colorMode: 'auto', color: '#7f8cff', focusMin: 25, breakMin: 5,
  showVolume: true, showActions: true, showFavorites: true, showUsage: true,
  showGames: true, showLaunchers: true, showOffice: true, showProjects: true,
  showTools: true, showClaude: false, showBrowsers: true,
  hideEmptyTabs: true, scale: 100, mainWidth: 420 };
let settings = { ...DEFAULTS, favorites: [], extraGames: [], extraLaunchers: [], extraOffice: [], extraTools: [], extraBrowsers: [], hiddenLibrary: [] };
let settingsWin = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch { /* primera vez */ }
  for (const k of ['favorites', 'extraGames', 'extraLaunchers', 'extraOffice', 'extraTools', 'extraBrowsers', 'hiddenLibrary']) if (!Array.isArray(settings[k])) settings[k] = [];
}
// Escribe en un archivo temporal y lo renombra: si el equipo se apaga a mitad, el archivo anterior queda intacto.
function writeFileAtomic(file, text) {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch { /* sin permisos */ }
}
function saveSettings() { writeFileAtomic(settingsFile(), JSON.stringify(settings)); }
let tray = null;
let mediaProc = null;

if (!app.requestSingleInstanceLock()) app.quit();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Posición: por defecto arriba y al centro de la pantalla principal; si el usuario la arrastró, donde la dejó
// (settings.pos guarda el centro horizontal de la isla y su borde superior, en coordenadas de pantalla).
function placeWindow() {
  if (!win || win.isDestroyed()) return;
  const { w, h } = winSize();
  let cx;
  let top;
  const pos = settings.pos;
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    const b = screen.getDisplayNearestPoint({ x: Math.round(pos.x), y: Math.round(pos.y) }).bounds; // si esa pantalla ya no está, la más cercana
    cx = Math.min(b.x + b.width - 100, Math.max(b.x + 100, pos.x));
    top = Math.min(b.y + b.height - 80, Math.max(b.y, pos.y));
  } else {
    const b = screen.getPrimaryDisplay().bounds;
    cx = b.x + b.width / 2;
    top = b.y;
  }
  win.setBounds({ x: Math.round(cx - w / 2), y: Math.round(top), width: w, height: h });
}

function createWindow() {
  const { w, h } = winSize();
  win = new BrowserWindow({
    width: w, height: h,
    frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    // Es una ventana normal a efectos de foco (así se puede escribir en ella al hacer clic), pero de tipo
    // "barra de herramientas" para que no aparezca en la barra de tareas ni en Alt+Tab.
    skipTaskbar: true, alwaysOnTop: true, focusable: true, type: 'toolbar', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  const w0 = win;
  placeWindow();
  win.setAlwaysOnTop(true, 'screen-saver');
  // La ventana es más grande que la isla: los clics la atraviesan salvo cuando el ratón está sobre la isla.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!w0.isDestroyed()) w0.showInactive(); });
  win.webContents.on('did-finish-load', () => {
    send('settings', settings);
    if (lastMedia) send('media', lastMedia); // tras recrear la ventana, lo que ya estaba sonando
  });
  applyContentProtection();
}

// Recrea la ventana desde cero. Es la recuperación más fiable cuando Windows la deja en un estado incoherente
// (por ejemplo tras la suspensión: se despliega pero los clics la atraviesan).
let lastRecreate = 0;
function recreateWindow() {
  if (Date.now() - lastRecreate < 4000) return;
  lastRecreate = Date.now();
  const old = win;
  createWindow();
  if (old && !old.isDestroyed()) old.destroy();
}

// Arrastre: mientras dura, la ventana sigue al cursor; al soltar se guarda la posición.
let dragTimer = null;
function endDrag() {
  if (!dragTimer) return;
  clearInterval(dragTimer);
  dragTimer = null;
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  settings.pos = { x: Math.round(b.x + b.width / 2), y: b.y };
  saveSettings();
  placeWindow(); // la ajusta a los límites de la pantalla donde quedó
  send('blur-changed');
}
ipcMain.on('drag-start', () => {
  if (!win || win.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  const off = { dx: c.x - x, dy: c.y - y };
  const started = Date.now();
  clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed() || Date.now() - started > 60000) return endDrag();
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - off.dx, p.y - off.dy);
  }, 16);
});
ipcMain.on('drag-end', endDrag);
ipcMain.on('pos-reset', () => { settings.pos = null; saveSettings(); placeWindow(); send('blur-changed'); });

// ---------- Desenfoque ----------
// Electron no puede difuminar el escritorio detrás de una ventana transparente con forma libre.
// Se captura la pantalla a baja resolución y la isla muestra, difuminada, la zona que tiene detrás.
// La ventana se excluye de la captura para que la isla no se capture a sí misma.
function applyContentProtection() {
  if (win && !win.isDestroyed()) win.setContentProtection(settings.blur);
}

ipcMain.handle('blur-config', async () => {
  if (!settings.blur) return { enabled: false };
  const display = screen.getDisplayMatching(win.getBounds()); // la pantalla donde está la isla
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

let lastMedia = null;
const mediaThumbs = new Map();
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
        for (const s of d.sessions || []) if (s.thumbError) logMediaError(s.thumbError);
        // Se guarda el último estado con sus carátulas (que solo llegan al cambiar de canción).
        for (const x of d.sessions || []) {
          const key = `${x.id}|${x.title}|${x.artist}`;
          if ('thumb' in x) mediaThumbs.set(key, x.thumb || null);
        }
        lastMedia = { ...d, sessions: (d.sessions || []).map((x) => ({ ...x, trackChanged: true, thumb: mediaThumbs.get(`${x.id}|${x.title}|${x.artist}`) || null })) };
        if (mediaThumbs.size > 40) mediaThumbs.clear();
        send('media', d);
      } catch { /* línea incompleta */ }
    }
  });
  mediaProc.on('exit', () => { mediaProc = null; if (!app.isQuitting) setTimeout(startMediaWatcher, 3000); });
}

ipcMain.on('media-control', (_e, action, target) => {
  if (process.platform !== 'win32') return;
  if (!['toggle', 'next', 'prev', 'focus'].includes(action)) return;
  const args = ['-Action', action];
  if (typeof target === 'string' && target && target.length < 300) args.push('-Target', target); // reproductor concreto
  ps(args);
});

ipcMain.on('set-interactive', (_e, on) => {
  if (!win || win.isDestroyed()) return;
  if (on) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});

// Al volver de la suspensión o del bloqueo, Windows puede dejar la ventana en un estado incoherente (se
// despliega pero los clics la atraviesan). Se restablece todo: posición, primer plano y paso de clics, y
// se pide a la isla que se pliegue para que vuelva a sincronizarse al pasar el ratón.
function watchPower() {
  const recover = () => { setTimeout(recreateWindow, 1500); };
  for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, recover);
  // Algunos equipos (suspensión moderna) no avisan al reanudar: se detecta por el salto en el reloj.
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - lastTick > 45000) recover();
    lastTick = now;
  }, 10000);
  screen.on('display-metrics-changed', () => { placeWindow(); send('blur-changed'); });
  screen.on('display-removed', () => { placeWindow(); send('blur-changed'); });
}

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
// Abre una entrada: enlace de un launcher (steam://…), app del menú Inicio o archivo.
function launchEntry(e) {
  if (e.url) shell.openExternal(e.url);
  else if (e.appId) spawn('explorer.exe', [`shell:AppsFolder\\${e.appId}`], { detached: true, stdio: 'ignore' }).unref();
  else if (e.path) shell.openPath(e.path);
}
ipcMain.on('favorite-open', (_e, index) => {
  const f = settings.favorites[index];
  if (f) launchEntry(f);
});

// ---------- Juegos y launchers ----------
// Juegos: se leen las bibliotecas de Steam y Epic Games. Launchers: se reconocen por nombre entre las apps
// instaladas. En ambos casos se pueden añadir entradas a mano y ocultar las detectadas.
const LAUNCHERS = /^(steam|epic games launcher|ea|ea app|ea desktop|origin|ubisoft connect|battle\.net|gog galaxy|riot client|xbox|rockstar games launcher|amazon games|itch|playnite|heroic games launcher|geforce now|nvidia geforce now|minecraft launcher|bethesda\.net launcher)$/i;
const NOT_A_GAME = /steamworks|redistributable|proton|steam linux runtime|steamvr|soundtrack|dedicated server/i;
let library = { games: [], launchers: [], office: [], tools: [], browsers: [] };

// Utilidades: herramientas de Windows y navegadores. Se buscan por nombre entre las apps instaladas (para usar su
// icono real); las del sistema que no aparezcan ahí se lanzan por su ejecutable.
const TOOLS = [
  { label: 'Calculadora', re: /^(calculadora|calculator)$/i, exe: 'calc.exe' },
  { label: 'Bloc de notas', re: /^(bloc de notas|notepad)$/i, exe: 'notepad.exe' },
  { label: 'Explorador de archivos', re: /^(explorador de archivos|file explorer)$/i, exe: 'explorer.exe', root: true },
  { label: 'Recortes', re: /^(recortes|herramienta recortes|snipping tool)$/i, exe: 'SnippingTool.exe' },
  { label: 'Lupa', re: /^(lupa|magnifier)$/i, exe: 'magnify.exe' },
  { label: 'Paint', re: /^paint$/i, exe: 'mspaint.exe' },
  { label: 'Terminal', re: /^(terminal|windows terminal)$/i, exe: 'WindowsPowerShell\\v1.0\\powershell.exe' },
  { label: 'Administrador de tareas', re: /^(administrador de tareas|task manager)$/i, exe: 'Taskmgr.exe' },
  { label: 'Configuración', re: /^(configuración|settings)$/i, url: 'ms-settings:' },
  { label: 'Teclado en pantalla', re: /^(teclado en pantalla|on-screen keyboard)$/i, exe: 'osk.exe' },
  { label: 'Grabadora de sonido', re: /^(grabadora de sonido|grabadora de voz|sound recorder|voice recorder)$/i },
  { label: 'Reloj', re: /^(reloj|clock|alarmas y reloj|alarms & clock)$/i },
];
const BROWSERS = /^(google chrome|chrome|microsoft edge|edge|firefox|mozilla firefox|brave|brave browser|opera|opera gx|opera gx browser|navegador opera|vivaldi|comet|arc|duckduckgo|tor browser)$/i;
async function scanTools(apps) {
  const out = [];
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  for (const t of TOOLS) {
    const a = apps.find((x) => t.re.test(x.name.trim()));
    if (a) { out.push({ id: `app:${a.appId || a.path}`, name: a.name, source: 'Sistema', icon: a.icon, launch: a.appId ? { appId: a.appId } : { path: a.path } }); continue; }
    if (process.platform !== 'win32') continue;
    if (t.url) { out.push({ id: `tool:${t.label}`, name: t.label, source: 'Sistema', icon: null, launch: { url: t.url } }); continue; }
    if (!t.exe) continue;
    const exe = t.root ? path.join(process.env.SystemRoot || 'C:\\Windows', t.exe) : path.join(sys32, t.exe);
    if (fs.existsSync(exe)) out.push({ id: `tool:${t.label}`, name: t.label, source: 'Sistema', icon: await fileIcon(exe), launch: { path: exe } });
  }
  return out;
}

// ---------- Navegadores: marcadores y sitios fijados ----------
// Los navegadores basados en Chromium guardan sus marcadores en un archivo JSON legible. De Firefox no se leen.
const expandEnv = (p) => p.replace(/%([^%]+)%/g, (_m, v) => process.env[v] || '');
const BROWSER_DEFS = [
  { key: 'chrome', re: /^(google )?chrome$/i, data: '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
    exe: ['%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe', '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe', '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe'] },
  { key: 'edge', re: /^(microsoft )?edge$/i, data: '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data',
    exe: ['%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe', '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe'] },
  { key: 'brave', re: /^brave( browser)?$/i, data: '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data',
    exe: ['%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'] },
  { key: 'operagx', re: /^(navegador )?opera gx( browser)?$/i, data: '%APPDATA%\\Opera Software\\Opera GX Stable', flat: true,
    exe: ['%LOCALAPPDATA%\\Programs\\Opera GX\\opera.exe'] },
  { key: 'opera', re: /^(navegador )?opera( browser)?$/i, data: '%APPDATA%\\Opera Software\\Opera Stable', flat: true,
    exe: ['%LOCALAPPDATA%\\Programs\\Opera\\opera.exe'] },
  { key: 'vivaldi', re: /^vivaldi$/i, data: '%LOCALAPPDATA%\\Vivaldi\\User Data', exe: ['%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe'] },
  { key: 'comet', re: /^comet$/i, data: '%LOCALAPPDATA%\\Perplexity\\Comet\\User Data', exe: ['%LOCALAPPDATA%\\Perplexity\\Comet\\Application\\comet.exe'] },
  { key: 'firefox', re: /^(mozilla )?firefox$/i, data: null, exe: ['%ProgramFiles%\\Mozilla Firefox\\firefox.exe', '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe'] },
];
function scanBrowsers(apps) {
  return apps.filter((x) => BROWSERS.test(x.name.trim())).map((a) => {
    const def = BROWSER_DEFS.find((d) => d.re.test(a.name.trim()));
    let exe = def ? def.exe.map(expandEnv).find((p) => fs.existsSync(p)) || null : null;
    if (!exe && a.path && process.platform === 'win32') { // sin ruta conocida: la del acceso directo
      try { const t = shell.readShortcutLink(a.path).target; if (t && /\.exe$/i.test(t)) exe = t; } catch { /* no es un acceso directo */ }
    }
    return { id: `app:${a.appId || a.path}`, name: a.name, source: '', kind: def ? def.key : 'other', exe, icon: a.icon, launch: a.appId ? { appId: a.appId } : { path: a.path } };
  });
}
const isWebUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const bookmarkCache = new Map(); // id del navegador -> lista de marcadores de la última lectura
function readBookmarks(kind) {
  const def = BROWSER_DEFS.find((d) => d.key === kind);
  if (!def || !def.data) return [];
  const root = process.env.GLASS_ISLAND_BROWSER_DATA || expandEnv(def.data); // la variable es para pruebas
  const files = [];
  if (def.flat) files.push(path.join(root, 'Bookmarks'));
  else {
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name))) files.push(path.join(root, d.name, 'Bookmarks'));
      }
    } catch { return []; }
  }
  const out = [];
  const seen = new Set();
  const walk = (node, folder, bar) => {
    if (!node || out.length >= 3000) return;
    if (node.type === 'url') {
      if (!isWebUrl(node.url) || seen.has(node.url)) return;
      seen.add(node.url);
      out.push({ name: String(node.name || node.url).slice(0, 160), url: node.url, folder, bar, used: Number(node.date_last_used) || 0 });
    } else if (Array.isArray(node.children)) {
      for (const c of node.children) walk(c, node.name && folder !== null ? (folder ? `${folder} / ${node.name}` : node.name) : '', bar);
    }
  };
  for (const f of files) {
    try {
      const roots = JSON.parse(fs.readFileSync(f, 'utf8')).roots || {};
      walk(roots.bookmark_bar, null, true);
      walk(roots.other, null, false);
      walk(roots.synced, null, false);
    } catch { /* perfil sin marcadores */ }
  }
  // Primero los de la barra de marcadores, en su orden; después el resto, los usados más recientemente arriba.
  return [...out.filter((b) => b.bar), ...out.filter((b) => !b.bar).sort((a, b) => b.used - a.used)];
}
function browserPins(key) {
  if (!settings.browserPins || typeof settings.browserPins !== 'object' || Array.isArray(settings.browserPins)) settings.browserPins = {};
  if (!Array.isArray(settings.browserPins[key])) settings.browserPins[key] = [];
  return settings.browserPins[key];
}
const findBrowser = (id) => library.browsers.find((b) => b.id === id);
const pinKey = (b) => (b.kind && b.kind !== 'other' ? b.kind : b.id);
function browserData(id) {
  const b = findBrowser(id);
  if (!b) return { pinned: [], recents: [], bookmarks: false };
  const marks = readBookmarks(b.kind);
  bookmarkCache.set(id, marks);
  const pins = browserPins(pinKey(b));
  const pinnedUrls = new Set(pins.map((p) => p.url));
  return {
    bookmarks: !!(BROWSER_DEFS.find((d) => d.key === b.kind) || {}).data,
    pinned: pins.map((p, index) => ({ index, name: p.name, where: p.url })),
    recents: marks.map((m, i) => ({ id: `b:${i}`, name: m.name, where: m.url, folder: m.folder || '' })).filter((m) => !pinnedUrls.has(m.where)),
  };
}
// Convierte lo que se pide abrir o fijar en una dirección web: un marcador, un fijado o texto escrito.
function resolveBrowserItem(b, item) {
  if (typeof item === 'string' && item.startsWith('b:')) { const m = (bookmarkCache.get(b.id) || [])[Number(item.slice(2))]; return m ? { name: m.name, url: m.url } : null; }
  if (typeof item === 'string' && item.startsWith('p:')) { const p = browserPins(pinKey(b))[Number(item.slice(2))]; return p ? { name: p.name, url: p.url } : null; }
  if (item && typeof item === 'object' && typeof item.text === 'string') {
    const text = item.text.trim().slice(0, 500);
    if (!text) return null;
    if (item.search) return { name: text, url: `https://www.google.com/search?q=${encodeURIComponent(text)}` };
    try {
      const u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
      if (u.protocol === 'http:' || u.protocol === 'https:') return { name: u.hostname.replace(/^www\./, ''), url: u.href };
    } catch { /* no es una dirección */ }
  }
  return null;
}
ipcMain.handle('browser-data', (_e, id) => browserData(id));
ipcMain.on('browser-open', (_e, id, item) => {
  const b = findBrowser(id);
  const r = b && resolveBrowserItem(b, item);
  if (!r || !isWebUrl(r.url)) return;
  // Se abre en ese navegador concreto; si no se conoce su ejecutable, en el predeterminado.
  if (b.exe) spawn(b.exe, [r.url], { detached: true, stdio: 'ignore' }).unref();
  else shell.openExternal(r.url);
});
ipcMain.handle('browser-pin', (_e, id, item) => {
  const b = findBrowser(id);
  const r = b && resolveBrowserItem(b, item);
  if (r && isWebUrl(r.url)) {
    const pins = browserPins(pinKey(b));
    if (pins.length < 30 && !pins.some((p) => p.url === r.url)) { pins.push(r); saveSettings(); }
  }
  return browserData(id);
});
ipcMain.handle('browser-unpin', (_e, id, index) => {
  const b = findBrowser(id);
  if (b) { const pins = browserPins(pinKey(b)); if (Number.isInteger(index) && pins[index]) { pins.splice(index, 1); saveSettings(); } }
  return browserData(id);
});

// Office: cada app se reconoce por nombre y lleva asociadas las extensiones de sus documentos.
const OFFICE_APPS = [
  { kind: 'word', re: /^(microsoft )?word\b/i, ext: ['docx', 'doc', 'docm', 'dotx', 'rtf', 'odt'] },
  { kind: 'excel', re: /^(microsoft )?excel\b/i, ext: ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'ods'] },
  { kind: 'powerpoint', re: /^(microsoft )?powerpoint\b/i, ext: ['pptx', 'ppt', 'pptm', 'ppsx', 'pps', 'odp'] },
  { kind: 'access', re: /^(microsoft )?access\b/i, ext: ['accdb', 'mdb'] },
  { kind: 'publisher', re: /^(microsoft )?publisher\b/i, ext: ['pub'] },
  { kind: 'visio', re: /^(microsoft )?visio\b/i, ext: ['vsdx', 'vsd'] },
  { kind: 'project', re: /^(microsoft )?project\b/i, ext: ['mpp'] },
  { kind: 'onenote', re: /^(microsoft )?onenote\b/i, ext: [] },
  { kind: 'outlook', re: /^(microsoft )?outlook\b/i, ext: [] },
];
const officeKind = (name) => { const a = OFFICE_APPS.find((o) => o.re.test(name.trim())); return a ? a.kind : null; };

// Documentos recientes: Windows y Office dejan un acceso directo por cada archivo abierto.
const recentPaths = new Map();
function officeRecents(kind) {
  const app = OFFICE_APPS.find((o) => o.kind === kind);
  if (!app || !app.ext.length) return [];
  const dirs = process.env.GLASS_ISLAND_RECENT_DIRS ? process.env.GLASS_ISLAND_RECENT_DIRS.split(path.delimiter) // para pruebas
    : process.platform === 'win32' ? [path.join(process.env.APPDATA || '', 'Microsoft', 'Office', 'Recent'), path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Recent')]
    : [];
  const found = new Map();
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const m = f.match(/^(.+\.([a-z0-9]+))\.lnk$/i);
      if (!m || !app.ext.includes(m[2].toLowerCase())) continue;
      const full = path.join(dir, f);
      let at;
      try { at = fs.statSync(full).mtimeMs; } catch { continue; }
      const key = m[1].toLowerCase();
      if (!found.has(key) || found.get(key).at < at) found.set(key, { name: m[1], at, link: full });
    }
  }
  const pinnedNames = new Set(officePins(kind).filter((p) => !p.folder).map((p) => p.name.toLowerCase()));
  const out = [];
  let checked = 0;
  for (const r of [...found.values()].sort((a, b) => b.at - a.at)) {
    if (pinnedNames.has(r.name.toLowerCase())) continue; // ya aparece arriba, fijado
    let where = '';
    if (process.platform === 'win32' && checked++ < 80) {
      try { // se descartan los documentos locales que ya no existen
        const target = shell.readShortcutLink(r.link).target;
        if (target) {
          if (!target.startsWith('\\\\') && !fs.existsSync(target)) continue;
          where = path.dirname(target);
        }
      } catch { /* acceso directo ilegible: se intenta abrir igualmente */ }
    }
    const id = `${kind}:${r.name.toLowerCase()}`;
    recentPaths.set(id, r.link);
    out.push({ id, name: r.name, at: r.at, where });
    if (out.length >= 200) break;
  }
  return out;
}
// Documentos y carpetas fijados por el usuario en cada app de Office.
function officePins(kind) {
  if (!settings.officePins || typeof settings.officePins !== 'object' || Array.isArray(settings.officePins)) settings.officePins = {};
  if (!Array.isArray(settings.officePins[kind])) settings.officePins[kind] = [];
  return settings.officePins[kind];
}
function officeList(kind) {
  if (typeof kind !== 'string' || !OFFICE_APPS.some((o) => o.kind === kind)) return { pinned: [], recents: [] };
  return {
    pinned: officePins(kind).map((p, index) => ({ index, name: p.name, where: p.folder ? p.path : path.dirname(p.path), folder: !!p.folder })),
    recents: officeRecents(kind),
  };
}
function addPin(kind, file, folder) {
  const pins = officePins(kind);
  if (pins.some((p) => p.path === file)) return;
  pins.push({ name: path.basename(file).replace(/\.lnk$/i, '') || file, path: file, folder: !!folder });
  saveSettings();
}
ipcMain.handle('office-recents', (_e, kind) => officeList(kind));
ipcMain.on('office-open-recent', (_e, id) => {
  const link = recentPaths.get(id);
  if (link) shell.openPath(link);
});
ipcMain.handle('office-pin-recent', (_e, kind, id) => {
  const link = recentPaths.get(id);
  if (link && typeof id === 'string' && id.startsWith(`${kind}:`)) {
    let target = link; // si el acceso directo no se puede resolver, se fija el propio acceso directo
    if (process.platform === 'win32') { try { target = shell.readShortcutLink(link).target || link; } catch { /* se usa el .lnk */ } }
    addPin(kind, target, false);
  }
  return officeList(kind);
});
ipcMain.handle('office-pin-browse', async (_e, kind, what) => {
  const app = OFFICE_APPS.find((o) => o.kind === kind);
  if (!app) return officeList(kind);
  const opts = what === 'folder'
    ? { title: 'Fijar carpeta', properties: ['openDirectory'] }
    : { title: 'Fijar documentos', properties: ['openFile', 'multiSelections'],
        filters: [...(app.ext.length ? [{ name: 'Documentos', extensions: app.ext }] : []), { name: 'Todos los archivos', extensions: ['*'] }] };
  const r = await dialog.showOpenDialog(opts);
  if (!r.canceled) r.filePaths.forEach((f) => addPin(kind, f, what === 'folder'));
  return officeList(kind);
});
ipcMain.handle('office-unpin', (_e, kind, index) => {
  const pins = officePins(kind);
  if (Number.isInteger(index) && pins[index]) { pins.splice(index, 1); saveSettings(); }
  return officeList(kind);
});
ipcMain.on('office-open-pin', (_e, kind, index) => {
  const p = officePins(kind)[index];
  if (p) shell.openPath(p.path);
});

// ---------- Categorías propias: pestañas creadas por el usuario ----------
function categories() {
  if (!Array.isArray(settings.categories)) settings.categories = [];
  return settings.categories;
}
const findCategory = (id) => categories().find((c) => c.id === id);
async function publicCategories() {
  return Promise.all(categories().map(async (c) => ({
    id: c.id, name: c.name,
    items: await Promise.all(c.items.map(async (it) => ({ name: it.name, detail: it.path || it.appId || '', icon: it.icon || (it.path ? await fileIcon(it.path) : null) }))),
  })));
}
async function categoriesChanged() {
  saveSettings();
  const list = await publicCategories();
  send('categories', list);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('categories', list);
  return list;
}
ipcMain.handle('categories-get', publicCategories);
ipcMain.handle('category-create', () => {
  if (categories().length < 8) categories().push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: 'Categoría nueva', items: [] });
  return categoriesChanged();
});
ipcMain.on('category-rename', (_e, id, name) => {
  const c = findCategory(id);
  if (!c || typeof name !== 'string') return;
  c.name = name.trim().slice(0, 18) || 'Categoría';
  categoriesChanged();
});
ipcMain.on('category-delete', (_e, id) => { settings.categories = categories().filter((c) => c.id !== id); categoriesChanged(); });
ipcMain.handle('category-add-app', (_e, id, appId) => {
  const c = findCategory(id);
  const a = appsCache && appsCache[appId];
  if (c && a && c.items.length < 40 && !c.items.some((x) => (a.appId ? x.appId === a.appId : x.path === a.path))) {
    c.items.push(a.appId ? { name: a.name, appId: a.appId, icon: a.icon } : { name: a.name, path: a.path });
  }
  return categoriesChanged();
});
ipcMain.on('category-remove-item', (_e, id, index) => {
  const c = findCategory(id);
  if (!c || !Number.isInteger(index) || !c.items[index]) return;
  c.items.splice(index, 1);
  categoriesChanged();
});
ipcMain.on('category-open', (_e, id, index) => {
  const c = findCategory(id);
  if (c && c.items[index]) launchEntry(c.items[index]);
});

// Accesos directos, programas o carpetas soltados sobre la isla o sobre la configuración.
// target: 'favorites', un tipo de pestaña (games, launchers, office, tools, browsers) o 'cat:<id>'.
ipcMain.handle('drop-paths', async (_e, paths, target) => {
  if (!Array.isArray(paths) || typeof target !== 'string') return 0;
  let added = 0;
  const key = extraKey(target);
  const cat = target.startsWith('cat:') ? findCategory(target.slice(4)) : null;
  for (const p of paths.slice(0, 20)) {
    if (typeof p !== 'string' || !p || !fs.existsSync(p)) continue;
    const name = path.basename(p).replace(/\.(lnk|exe|url|bat|cmd)$/i, '') || p;
    if (target === 'favorites') {
      if (settings.favorites.length >= MAX_FAVORITES || settings.favorites.some((f) => f.path === p)) continue;
      settings.favorites.push({ name, path: p });
    } else if (key) {
      if (settings[key].some((x) => x.path === p)) continue;
      settings[key].push({ name, path: p, icon: await fileIcon(p) });
    } else if (cat) {
      if (cat.items.length >= 40 || cat.items.some((x) => x.path === p)) continue;
      cat.items.push({ name, path: p });
    } else continue;
    added++;
  }
  if (!added) return 0;
  if (target === 'favorites') { saveSettings(); await broadcastFavorites(); } else if (key) rebuildManual(); else await categoriesChanged();
  return added;
});

// ---------- Agenda: eventos, recordatorios y notas rápidas ----------
let agenda = { events: [], notes: '', tasks: [], taskLists: [] };
const agendaFile = () => path.join(app.getPath('userData'), 'agenda.json');
function loadAgenda() {
  try {
    const d = JSON.parse(fs.readFileSync(agendaFile(), 'utf8'));
    agenda = { events: Array.isArray(d.events) ? d.events : [], notes: typeof d.notes === 'string' ? d.notes : '', tasks: Array.isArray(d.tasks) ? d.tasks : [],
      taskLists: Array.isArray(d.taskLists) ? d.taskLists : [] };
  } catch { /* primera vez */ }
}
function saveAgenda() { writeFileAtomic(agendaFile(), JSON.stringify(agenda)); }
const dueTime = (e) => new Date(`${e.date}T${e.time || '09:00'}:00`).getTime(); // sin hora, el recordatorio avisa a las 9:00
function checkReminders() {
  const now = Date.now();
  let changed = false;
  for (const e of agenda.events) {
    if (e.type !== 'reminder' || e.notified) continue;
    const due = dueTime(e);
    if (!(due <= now)) continue;
    e.notified = true;
    changed = true;
    if (now - due > 12 * 3600 * 1000) continue; // demasiado antiguo (la isla estuvo cerrada): no se avisa
    send('reminder', { text: e.text, time: e.time });
    try { if (Notification.isSupported()) new Notification({ title: 'Recordatorio', body: e.text }).show(); } catch { /* sin notificaciones */ }
  }
  if (changed) { saveAgenda(); send('agenda', agenda); }
}
ipcMain.handle('agenda-get', () => agenda);
ipcMain.handle('agenda-add', (_e, item) => {
  if (!item || typeof item !== 'object' || agenda.events.length >= 1000) return agenda;
  const text = typeof item.text === 'string' ? item.text.trim().slice(0, 120) : '';
  const okDate = typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date);
  const time = typeof item.time === 'string' && /^\d{2}:\d{2}$/.test(item.time) ? item.time : '';
  if (!text || !okDate) return agenda;
  const ev = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, date: item.date, time, text, type: ['reminder', 'note'].includes(item.type) ? item.type : 'event' };
  if (ev.type === 'note') ev.time = '';
  if (ev.type === 'reminder' && dueTime(ev) <= Date.now()) ev.notified = true; // creado ya en el pasado: no avisar
  agenda.events.push(ev);
  saveAgenda();
  return agenda;
});
ipcMain.handle('agenda-remove', (_e, id) => {
  agenda.events = agenda.events.filter((e) => e.id !== id);
  saveAgenda();
  return agenda;
});

// Tareas al estilo del Bullet Journal: cada una guarda cuándo se registró, su fecha de inicio y cuándo se
// completó. Mientras siga abierta aparece en todos los días desde su inicio (la "migración" es automática).
ipcMain.handle('task-add', (_e, item) => {
  if (!item || typeof item !== 'object' || agenda.tasks.length >= 2000) return agenda;
  const text = typeof item.text === 'string' ? item.text.trim().slice(0, 120) : '';
  if (!text || typeof item.start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.start)) return agenda;
  // repeat: '' (una sola vez), 'daily', 'weekdays', 'weekly' o 'monthly'. Las repetitivas guardan en doneMap
  // cuándo se completó cada repetición (clave: la fecha de esa repetición).
  const repeat = ['daily', 'weekdays', 'weekly', 'monthly'].includes(item.repeat) ? item.repeat : '';
  const list = agenda.taskLists.some((l) => l.id === item.list) ? item.list : '';
  agenda.tasks.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, created: Date.now(), start: item.start, done: null, repeat, doneMap: {}, list });
  saveAgenda();
  return agenda;
});
// ---------- Categorías de tareas (listas con nombre y color) ----------
const LIST_COLORS = ['#7f8cff', '#ffb454', '#5fd38d', '#ff7a8a', '#4cc9f0', '#c792ea', '#f6d365', '#9aa5b1'];
function agendaChanged() {
  saveAgenda();
  send('agenda', agenda);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('agenda', agenda);
  return agenda;
}
ipcMain.handle('tasklist-create', (_e, name) => {
  const n = typeof name === 'string' ? name.trim().slice(0, 24) : '';
  if (!n || agenda.taskLists.length >= 20) return agenda;
  const used = new Set(agenda.taskLists.map((l) => l.color));
  const color = LIST_COLORS.find((c) => !used.has(c)) || LIST_COLORS[agenda.taskLists.length % LIST_COLORS.length];
  agenda.taskLists.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: n, color });
  return agendaChanged();
});
ipcMain.handle('tasklist-update', (_e, id, patch) => {
  const l = agenda.taskLists.find((x) => x.id === id);
  if (!l || !patch || typeof patch !== 'object') return agenda;
  if (typeof patch.name === 'string' && patch.name.trim()) l.name = patch.name.trim().slice(0, 24);
  if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) l.color = patch.color;
  return agendaChanged();
});
ipcMain.handle('tasklist-delete', (_e, id) => {
  agenda.taskLists = agenda.taskLists.filter((l) => l.id !== id);
  for (const t of agenda.tasks) if (t.list === id) t.list = ''; // las tareas se conservan, sin categoría
  return agendaChanged();
});
// Menú contextual de una tarea (clic derecho): mover a otra categoría o eliminarla.
ipcMain.on('task-menu', (_e, id) => {
  const t = agenda.tasks.find((x) => x.id === id);
  if (!t || !win || win.isDestroyed()) return;
  const move = (list) => { t.list = list; agendaChanged(); };
  Menu.buildFromTemplate([
    { label: 'Categoría', enabled: false },
    { label: 'Sin categoría', type: 'radio', checked: !t.list, click: () => move('') },
    ...agenda.taskLists.map((l) => ({ label: l.name, type: 'radio', checked: t.list === l.id, click: () => move(l.id) })),
    { type: 'separator' },
    { label: t.repeat ? 'Eliminar la tarea y sus repeticiones' : 'Eliminar tarea', click: () => { agenda.tasks = agenda.tasks.filter((x) => x.id !== id); agendaChanged(); } },
  ]).popup({ window: win });
});
ipcMain.handle('task-toggle', (_e, id, occ) => {
  const t = agenda.tasks.find((x) => x.id === id);
  if (!t) return agenda;
  if (t.repeat) {
    if (typeof occ !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(occ)) return agenda;
    if (!t.doneMap || typeof t.doneMap !== 'object') t.doneMap = {};
    if (t.doneMap[occ]) delete t.doneMap[occ]; else t.doneMap[occ] = Date.now();
  } else {
    t.done = t.done ? null : Date.now();
  }
  saveAgenda();
  return agenda;
});
ipcMain.handle('task-remove', (_e, id) => {
  agenda.tasks = agenda.tasks.filter((t) => t.id !== id);
  saveAgenda();
  return agenda;
});
let notesTimer = null;
ipcMain.on('notes-set', (_e, text) => {
  if (typeof text !== 'string') return;
  agenda.notes = text.slice(0, 20000);
  clearTimeout(notesTimer);
  notesTimer = setTimeout(saveAgenda, 600);
});

// ---------- Proyectos: conjuntos de archivos, carpetas, apps y webs que se abren de una vez ----------
function projects() {
  if (!Array.isArray(settings.projects)) settings.projects = [];
  return settings.projects;
}
const findProject = (id) => projects().find((p) => p.id === id);
function publicProjects() {
  return projects().map((p) => ({ id: p.id, name: p.name, items: p.items.map((it) => ({ type: it.type, name: it.name, detail: it.path || it.url || '' })) }));
}
function projectsChanged() {
  saveSettings();
  const list = publicProjects();
  send('projects', list);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('projects', list);
  return list;
}
ipcMain.handle('projects-get', publicProjects);
ipcMain.handle('project-create', () => {
  projects().push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: 'Proyecto nuevo', items: [] });
  return projectsChanged();
});
ipcMain.on('project-rename', (_e, id, name) => {
  const p = findProject(id);
  if (!p || typeof name !== 'string') return;
  p.name = name.trim().slice(0, 40) || 'Proyecto';
  projectsChanged();
});
ipcMain.on('project-delete', (_e, id) => {
  settings.projects = projects().filter((p) => p.id !== id);
  projectsChanged();
});
ipcMain.handle('project-add-item', async (_e, id, type, payload) => {
  const p = findProject(id);
  if (!p || p.items.length >= 20) return publicProjects();
  if (type === 'file' || type === 'folder') {
    const r = await dialog.showOpenDialog(settingsWin, type === 'folder'
      ? { title: 'Añadir carpeta al proyecto', properties: ['openDirectory'] }
      : { title: 'Añadir archivos al proyecto', properties: ['openFile', 'multiSelections'] });
    if (!r.canceled) {
      for (const f of r.filePaths) {
        if (p.items.length < 20 && !p.items.some((it) => it.path === f)) p.items.push({ type, name: path.basename(f) || f, path: f });
      }
    }
  } else if (type === 'app') {
    const a = appsCache && appsCache[payload];
    if (a) p.items.push(a.appId ? { type, name: a.name, appId: a.appId } : { type, name: a.name, path: a.path });
  } else if (type === 'url' && typeof payload === 'string') {
    let url;
    try { url = new URL(/^https?:\/\//i.test(payload.trim()) ? payload.trim() : `https://${payload.trim()}`); } catch { return publicProjects(); }
    if (url.protocol === 'http:' || url.protocol === 'https:') p.items.push({ type, name: url.hostname + (url.pathname.length > 1 ? url.pathname : ''), url: url.href });
  }
  return projectsChanged();
});
ipcMain.on('project-remove-item', (_e, id, index) => {
  const p = findProject(id);
  if (!p || !Number.isInteger(index) || !p.items[index]) return;
  p.items.splice(index, 1);
  projectsChanged();
});
ipcMain.on('project-open', (_e, id) => {
  const p = findProject(id);
  if (!p) return;
  // Se abren de uno en uno con una pequeña pausa para no saturar el equipo.
  p.items.forEach((it, i) => setTimeout(() => {
    if (it.type === 'url') shell.openExternal(it.url);
    else launchEntry(it);
  }, i * 350));
});

function regQuery(key, value) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const p = spawn('reg.exe', ['query', key, '/v', value], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', () => resolve(null));
    p.on('exit', () => { const m = out.match(/REG_SZ\s+(.+)/); resolve(m ? m[1].trim() : null); });
  });
}
const vdfValues = (text, key) => [...text.matchAll(new RegExp(`"${key}"\\s+"((?:[^"\\\\]|\\\\.)*)"`, 'gi'))].map((m) => m[1].replace(/\\\\/g, '\\'));

function squareIcon(file) {
  try {
    let img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const side = Math.min(width, height);
    if (width !== height) img = img.crop({ x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), width: side, height: side });
    return img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
  } catch { return null; }
}
function steamIcon(root, appid) {
  const base = path.join(root, 'appcache', 'librarycache');
  const candidates = [];
  try { // formato nuevo: una carpeta por juego; el icono es el .jpg con nombre hexadecimal
    const dir = path.join(base, appid);
    const files = fs.readdirSync(dir);
    candidates.push(...files.filter((f) => /^[0-9a-f]{40}\.jpg$/i.test(f)).map((f) => path.join(dir, f)));
    candidates.push(path.join(dir, 'library_600x900.jpg'), path.join(dir, 'header.jpg'));
  } catch { /* formato antiguo */ }
  candidates.push(path.join(base, `${appid}_icon.jpg`), path.join(base, `${appid}_library_600x900.jpg`), path.join(base, `${appid}_header.jpg`));
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const icon = squareIcon(f);
    if (icon) return icon;
  }
  return null;
}
async function scanSteam() {
  let root = process.env.GLASS_ISLAND_STEAM_DIR || null; // para pruebas
  if (!root && process.platform === 'win32') {
    const fromReg = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
    root = [fromReg, 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].find((p) => p && fs.existsSync(p)) || null;
  }
  if (!root) return [];
  const libs = new Set([path.normalize(root)]);
  try { vdfValues(fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'), 'path').forEach((p) => libs.add(path.normalize(p))); } catch { /* una sola biblioteca */ }
  const games = new Map();
  for (const lib of libs) {
    let files;
    try { files = fs.readdirSync(path.join(lib, 'steamapps')); } catch { continue; }
    for (const f of files) {
      if (!/^appmanifest_\d+\.acf$/i.test(f)) continue;
      try {
        const text = fs.readFileSync(path.join(lib, 'steamapps', f), 'utf8');
        const appid = vdfValues(text, 'appid')[0];
        const name = vdfValues(text, 'name')[0];
        if (!appid || !name || NOT_A_GAME.test(name) || games.has(appid)) continue;
        games.set(appid, { id: `steam:${appid}`, name, source: 'Steam', icon: steamIcon(root, appid), launch: { url: `steam://rungameid/${appid}` } });
      } catch { /* manifiesto ilegible */ }
    }
  }
  return [...games.values()];
}
async function scanEpic() {
  const dir = process.env.GLASS_ISLAND_EPIC_DIR
    || (process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests') : null);
  if (!dir) return [];
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const games = [];
  for (const f of files) {
    if (!/\.item$/i.test(f)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!m.DisplayName || !m.AppName || m.bIsIncompleteInstall) continue;
      if (Array.isArray(m.AppCategories) && !m.AppCategories.includes('games')) continue; // p. ej. Unreal Engine
      const exe = m.InstallLocation && m.LaunchExecutable ? path.join(m.InstallLocation, m.LaunchExecutable) : null;
      games.push({ id: `epic:${m.AppName}`, name: m.DisplayName, source: 'Epic Games', icon: exe ? await fileIcon(exe) : null,
        launch: { url: `com.epicgames.launcher://apps/${encodeURIComponent(m.AppName)}?action=launch&silent=true` } });
    } catch { /* manifiesto ilegible */ }
  }
  return games;
}
const manualEntries = (list, kind) => list.map((e) => ({
  id: `manual:${kind}:${e.appId || e.path}`, name: e.name, source: 'Añadido a mano', icon: e.icon || null, manual: true,
  launch: e.appId ? { appId: e.appId } : { path: e.path },
}));
const byName = (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
function publicLibrary(all) {
  const strip = (list) => list.filter((e) => all || !e.hidden).map(({ launch, ...rest }) => rest);
  const strip2 = (list) => strip(list).map(({ exe, ...rest }) => rest);
  return { games: strip(library.games), launchers: strip(library.launchers), office: strip(library.office), tools: strip(library.tools), browsers: strip2(library.browsers) };
}
function broadcastLibrary() {
  const hidden = new Set(settings.hiddenLibrary);
  for (const e of [...library.games, ...library.launchers, ...library.office, ...library.tools, ...library.browsers]) e.hidden = hidden.has(e.id);
  send('library', publicLibrary(false));
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('library', publicLibrary(true));
}
let libraryScan = null;
function refreshLibrary(force) {
  if (libraryScan) return libraryScan;
  libraryScan = (async () => {
    const [steam, epic, apps] = await Promise.all([scanSteam().catch(() => []), scanEpic().catch(() => []), listApps(force).catch(() => [])]);
    const detected = apps.filter((a) => LAUNCHERS.test(a.name.trim()))
      .map((a) => ({ id: `app:${a.appId || a.path}`, name: a.name, source: '', icon: a.icon, launch: a.appId ? { appId: a.appId } : { path: a.path } }));
    const officeApps = apps.filter((a) => officeKind(a.name))
      .map((a) => ({ id: `app:${a.appId || a.path}`, name: a.name, source: '', kind: officeKind(a.name), icon: a.icon, launch: a.appId ? { appId: a.appId } : { path: a.path } }));
    library = {
      games: [...steam, ...epic, ...manualEntries(settings.extraGames, 'games')].sort(byName),
      launchers: [...detected, ...manualEntries(settings.extraLaunchers, 'launchers')].sort(byName),
      office: [...officeApps, ...manualEntries(settings.extraOffice, 'office')].sort(byName),
      tools: [...await scanTools(apps), ...manualEntries(settings.extraTools, 'tools')], // en orden de utilidad, no alfabético
      browsers: [...scanBrowsers(apps), ...manualBrowsers()].sort(byName),
    };
    broadcastLibrary();
  })().finally(() => { libraryScan = null; });
  return libraryScan;
}
function rebuildManual() { // tras añadir o quitar a mano no hace falta volver a escanear
  library.games = [...library.games.filter((e) => !e.manual), ...manualEntries(settings.extraGames, 'games')].sort(byName);
  library.launchers = [...library.launchers.filter((e) => !e.manual), ...manualEntries(settings.extraLaunchers, 'launchers')].sort(byName);
  library.office = [...library.office.filter((e) => !e.manual), ...manualEntries(settings.extraOffice, 'office')].sort(byName);
  library.tools = [...library.tools.filter((e) => !e.manual), ...manualEntries(settings.extraTools, 'tools')];
  library.browsers = [...library.browsers.filter((e) => !e.manual), ...manualBrowsers()].sort(byName);
  saveSettings();
  broadcastLibrary();
}
const extraKey = (kind) => ({ games: 'extraGames', launchers: 'extraLaunchers', office: 'extraOffice', tools: 'extraTools', browsers: 'extraBrowsers' }[kind] || null);
function manualBrowsers() { // añadidos a mano: sin marcadores, pero con sitios fijados
  return manualEntries(settings.extraBrowsers, 'browsers').map((e) => {
    let exe = null;
    if (e.launch.path && process.platform === 'win32') {
      try { const t = shell.readShortcutLink(e.launch.path).target; if (t && /\.exe$/i.test(t)) exe = t; } catch { if (/\.exe$/i.test(e.launch.path)) exe = e.launch.path; }
    }
    return { ...e, kind: 'other', exe };
  });
}
ipcMain.handle('library-get', (e) => publicLibrary(!!settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents));
ipcMain.handle('library-refresh', () => refreshLibrary(true));
ipcMain.on('library-open', (_e, id) => {
  const entry = [...library.games, ...library.launchers, ...library.office, ...library.tools, ...library.browsers].find((x) => x.id === id);
  if (entry) launchEntry(entry.launch);
});
ipcMain.on('library-hide', (_e, id, hide) => {
  if (typeof id !== 'string') return;
  settings.hiddenLibrary = settings.hiddenLibrary.filter((x) => x !== id);
  if (hide) settings.hiddenLibrary.push(id);
  saveSettings();
  broadcastLibrary();
});
ipcMain.handle('library-add', async (_e, kind, appId) => {
  const key = extraKey(kind);
  const a = appsCache && appsCache[appId];
  if (!key || !a) return;
  if (settings[key].some((x) => (a.appId ? x.appId === a.appId : x.path === a.path))) return;
  settings[key].push(a.appId ? { name: a.name, appId: a.appId, icon: a.icon } : { name: a.name, path: a.path, icon: a.icon });
  rebuildManual();
});
ipcMain.on('library-remove', (_e, id) => {
  const m = typeof id === 'string' && id.match(/^manual:(games|launchers|office|tools|browsers):(.*)$/s);
  if (!m) return;
  const key = extraKey(m[1]);
  settings[key] = settings[key].filter((x) => (x.appId || x.path) !== m[2]);
  rebuildManual();
});

// ---------- Consumo del plan (lo envía la barra de estado de Claude Code) ----------
let usage = null;
const usageFile = () => path.join(app.getPath('userData'), 'usage.json');
function loadUsage() { try { usage = JSON.parse(fs.readFileSync(usageFile(), 'utf8')); } catch { usage = null; } }
function readWindow(w) {
  if (!w || !Number.isFinite(w.used_percentage)) return null;
  return { pct: Math.max(0, w.used_percentage), resetsAt: Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null };
}
// Recibe los datos de sesión de Claude Code y devuelve la línea que Claude Code mostrará en su barra de estado.
function onStatusLine(d) {
  const rl = d.rate_limits || {};
  const next = {
    fiveHour: readWindow(rl.five_hour), sevenDay: readWindow(rl.seven_day),
    model: d.model && typeof d.model.display_name === 'string' ? d.model.display_name : '',
    at: Date.now(),
  };
  // Al inicio de una sesión aún no llegan los límites: se conserva la última lectura.
  if (!next.fiveHour && !next.sevenDay && usage) { next.fiveHour = usage.fiveHour; next.sevenDay = usage.sevenDay; next.at = usage.at; }
  usage = next;
  try { fs.writeFileSync(usageFile(), JSON.stringify(usage)); } catch { /* sin permisos */ }
  send('usage', usage);
  const parts = [];
  if (next.model) parts.push(`[${next.model}]`);
  const ctx = d.context_window && d.context_window.used_percentage;
  if (Number.isFinite(ctx)) parts.push(`contexto ${Math.round(ctx)}%`);
  if (rl.five_hour && Number.isFinite(rl.five_hour.used_percentage)) parts.push(`5 h ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl.seven_day && Number.isFinite(rl.seven_day.used_percentage)) parts.push(`7 d ${Math.round(rl.seven_day.used_percentage)}%`);
  return parts.join(' · ');
}
ipcMain.handle('usage-get', () => usage);

// ---------- Claude Code (los hooks hacen POST aquí) ----------
function startHookServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/hook' && req.url !== '/statusline')) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (req.url === '/statusline') {
        let line = '';
        try { line = onStatusLine(JSON.parse(body)); } catch { /* JSON incompleto */ }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(line);
        return;
      }
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
      lastHookAt = Date.now();
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
let lastHookAt = 0; // último aviso recibido de Claude Code desde que se abrió la isla
ipcMain.handle('claude-link-status', () => ({ ...claudeHooks.status(), lastHookAt }));
ipcMain.handle('claude-link-set', (_e, link) => {
  const result = { ...claudeHooks.set(!!link), lastHookAt };
  send('claude-link', result);
  return result;
});
ipcMain.handle('claude-usage-set', (_e, on) => ({ ...claudeHooks.setUsage(!!on), lastHookAt }));
ipcMain.handle('settings-get', () => ({ ...settings, openAtLogin: app.getLoginItemSettings(LOGIN).openAtLogin }));
ipcMain.on('settings-set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  if (patch.reset) { patch = { ...DEFAULTS }; settings.pos = null; }
  if ('openAtLogin' in patch) app.setLoginItemSettings({ ...LOGIN, openAtLogin: !!patch.openAtLogin });
  const blurBefore = settings.blur;
  const geoBefore = `${settings.scale}|${settings.mainWidth}`;
  for (const k of Object.keys(DEFAULTS)) {
    if (k in patch && typeof patch[k] === typeof DEFAULTS[k]) settings[k] = patch[k];
  }
  saveSettings();
  send('settings', settings);
  settings.scale = Math.min(150, Math.max(70, Math.round(settings.scale)));
  settings.mainWidth = Math.min(640, Math.max(380, Math.round(settings.mainWidth)));
  if (settings.blur !== blurBefore) { applyContentProtection(); send('blur-changed'); }
  if (`${settings.scale}|${settings.mainWidth}` !== geoBefore) { placeWindow(); send('blur-changed'); }
});

// ---------- Actualizaciones (solo en la versión instalada; las publica GitHub Releases) ----------
let updateReady = null;
let autoUpdater = null;
// state: 'dev' (sin instalar) | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error'
let updateStatus = { state: app.isPackaged ? 'idle' : 'dev', current: app.getVersion() };
function setUpdateStatus(patch) {
  updateStatus = { current: app.getVersion(), ...patch };
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update-status', updateStatus);
}
function checkForUpdates() {
  if (!autoUpdater || ['checking', 'downloading', 'ready'].includes(updateStatus.state)) return;
  autoUpdater.checkForUpdates().catch(() => {});
}
function startUpdater() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.on('checking-for-update', () => setUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdateStatus({ state: 'none', checkedAt: Date.now() }));
  autoUpdater.on('update-available', (info) => setUpdateStatus({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => setUpdateStatus({ state: 'downloading', version: updateStatus.version, percent: Math.round(p.percent) }));
  autoUpdater.on('error', (e) => {
    setUpdateStatus({ state: 'error', message: String((e && e.message) || e).split('\n')[0].slice(0, 200) });
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), `${new Date().toISOString()} ${e && e.message}\n`); } catch { /* sin permisos */ }
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = { version: info.version, install: () => { app.isQuitting = true; autoUpdater.quitAndInstall(true, true); } };
    setUpdateStatus({ state: 'ready', version: info.version });
    buildTrayMenu();
    send('update-ready', info.version);
  });
  checkForUpdates();
  setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
}
ipcMain.handle('update-get', () => updateStatus);
ipcMain.on('update-check', checkForUpdates);
ipcMain.on('update-install', () => { if (updateReady) updateReady.install(); });

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
    { label: 'Reiniciar isla', click: () => { app.isQuitting = true; app.relaunch(); app.exit(0); } },
    { type: 'separator' },
    { label: `Versión ${app.getVersion()}`, enabled: false },
    ...(app.isPackaged && !updateReady ? [{ label: 'Buscar actualizaciones', click: () => { checkForUpdates(); openSettings('sistema'); } }] : []),
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

app.whenReady().then(() => {
  app.setAppUserModelId('local.glass.island'); // necesario para las notificaciones de Windows
  loadSettings();
  loadAgenda();
  setInterval(checkReminders, 15000);
  setTimeout(checkReminders, 5000);
  // Si la vinculación viene de una versión anterior, se reescribe con el comando actual.
  try { if (claudeHooks.status().outdated) claudeHooks.set(true); } catch { /* se deja como está */ }
  loadUsage();
  createWindow();
  createTray();
  startMediaWatcher();
  startHookServer();
  startAudio();
  startUpdater();
  watchPower();
  setTimeout(() => refreshLibrary(false), 4000); // en segundo plano, para no retrasar el arranque
});
app.on('before-quit', () => { app.isQuitting = true; clearTimeout(notesTimer); saveAgenda(); if (mediaProc) mediaProc.kill(); if (audioProc) audioProc.kill(); });
app.on('window-all-closed', () => { if (app.isQuitting) app.quit(); });
