const api = window.islandAPI;
const $ = (id) => document.getElementById(id);
const UNITS = { tint: '%', dark: '%', sheen: '%', blurPx: ' px' };
const FIELDS = ['tint', 'dark', 'sheen', 'blur', 'blurPx', 'colorMode', 'color', 'focusMin', 'breakMin', 'openAtLogin', 'showVolume', 'showActions', 'showFavorites', 'showUsage', 'showGames', 'showLaunchers', 'showOffice'];

function show(s) {
  for (const k of FIELDS) {
    if (!(k in s)) continue;
    const el = $(k);
    if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
    const out = document.querySelector(`output[for="${k}"]`);
    if (out) out.textContent = s[k] + UNITS[k];
  }
  $('row-blurPx').classList.toggle('disabled', !$('blur').checked);
  $('row-color').classList.toggle('disabled', $('colorMode').value !== 'fixed');
}

for (const k of FIELDS) {
  const el = $(k);
  el.addEventListener(el.type === 'range' || el.type === 'color' ? 'input' : 'change', () => {
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'range' || el.type === 'number') {
      v = Math.round(Number(el.value));
      if (!Number.isFinite(v)) return;
      v = Math.min(Number(el.max), Math.max(Number(el.min), v));
    } else v = el.value;
    api.setSettings({ [k]: v });
    show({ [k]: v });
  });
}

$('reset').onclick = async () => {
  api.setSettings({ reset: true });
  show(await api.getSettings());
};

function showFavorites(list) {
  const box = $('fav-list');
  box.textContent = '';
  list.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'fav';
    let icon;
    if (f.icon) { icon = document.createElement('img'); icon.src = f.icon; icon.alt = ''; }
    else { icon = document.createElement('span'); icon.className = 'letter'; icon.textContent = (f.name[0] || '?').toUpperCase(); }
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = f.name; name.title = f.path;
    const del = document.createElement('button');
    del.textContent = 'Quitar';
    del.onclick = () => api.removeFavorite(i);
    row.append(icon, name, del);
    box.append(row);
  });
  const full = list.length >= 10;
  $('fav-add-app').disabled = $('fav-add-file').disabled = $('fav-add-folder').disabled = full;
  favorites = list;
  renderApps();
}

// ---------- Selector de aplicaciones instaladas ----------
let favorites = [];
let apps = null;
let pickerTarget = 'favorites'; // 'favorites' | 'games' | 'launchers'
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function renderApps() {
  if ($('picker').hidden || !apps) return;
  const q = norm($('app-search').value.trim());
  const full = pickerTarget === 'favorites' && favorites.length >= 10;
  const box = $('app-list');
  box.textContent = '';
  const shown = apps.filter((a) => !q || norm(a.name).includes(q));
  for (const a of shown) {
    const added = pickerTarget === 'favorites' && favorites.some((f) => (a.appId ? f.appId === a.appId : f.path === a.path));
    const b = document.createElement('button');
    let icon;
    if (a.icon) { icon = document.createElement('img'); icon.src = a.icon; icon.alt = ''; }
    else { icon = document.createElement('span'); icon.className = 'letter'; icon.textContent = (a.name[0] || '?').toUpperCase(); }
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = a.name;
    b.append(icon, name);
    if (added) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'Añadida'; b.append(t); }
    b.disabled = added || full;
    b.onclick = async () => {
      if (pickerTarget === 'favorites') return api.addFavoriteApp(a.id);
      await api.addLibrary(pickerTarget, a.id);
      $('picker').hidden = true;
    };
    box.append(b);
  }
  const status = $('app-status');
  status.hidden = shown.length > 0 && !full;
  status.textContent = full ? 'Ya tienes 10 favoritas: quita alguna para añadir más.'
    : apps.length ? 'Ninguna aplicación coincide con la búsqueda.' : 'No se encontraron aplicaciones. Usa "Examinar…" para elegir una a mano.';
}
async function loadApps(force) {
  apps = null;
  $('app-list').textContent = '';
  $('app-status').hidden = false;
  $('app-status').textContent = 'Buscando aplicaciones instaladas…';
  apps = await api.listApps(force);
  renderApps();
}
function openPicker(target) {
  pickerTarget = target;
  $('picker').hidden = false;
  $('app-search').value = '';
  $('app-search').focus();
  if (apps) renderApps(); else loadApps(false);
}
$('fav-add-app').onclick = () => openPicker('favorites');
$('lib-add-games').onclick = () => openPicker('games');
$('lib-add-launchers').onclick = () => openPicker('launchers');
$('lib-add-office').onclick = () => openPicker('office');

// ---------- Juegos y launchers ----------
function showLibraryList(boxId, list) {
  const box = $(boxId);
  box.textContent = '';
  for (const e of list) {
    const row = document.createElement('div');
    row.className = 'fav' + (e.hidden ? ' off' : '');
    let icon;
    if (e.icon) { icon = document.createElement('img'); icon.src = e.icon; icon.alt = ''; }
    else { icon = document.createElement('span'); icon.className = 'letter'; icon.textContent = (e.name[0] || '?').toUpperCase(); }
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = e.name;
    const src = document.createElement('span');
    src.className = 'src'; src.textContent = e.source || '';
    const btn = document.createElement('button');
    if (e.manual) { btn.textContent = 'Quitar'; btn.onclick = () => api.removeLibrary(e.id); }
    else { btn.textContent = e.hidden ? 'Mostrar' : 'Ocultar'; btn.onclick = () => api.hideLibrary(e.id, !e.hidden); }
    row.append(icon, name, src, btn);
    box.append(row);
  }
}
function showLibrary(lib) {
  showLibraryList('lib-games', lib.games || []);
  showLibraryList('lib-launchers', lib.launchers || []);
  showLibraryList('lib-office', lib.office || []);
}
$('lib-refresh').onclick = async () => {
  $('lib-refresh').disabled = true;
  $('lib-refresh').textContent = 'Buscando…';
  apps = null;
  await api.refreshLibrary();
  $('lib-refresh').disabled = false;
  $('lib-refresh').textContent = 'Volver a buscar';
};
api.onLibrary(showLibrary);
api.getLibrary().then(showLibrary);
$('app-close').onclick = () => { $('picker').hidden = true; };
$('app-refresh').onclick = () => loadApps(true);
$('app-search').addEventListener('input', renderApps);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('picker').hidden = true; });
$('fav-add-file').onclick = () => api.addFavorite('app');
$('fav-add-folder').onclick = () => api.addFavorite('folder');
api.onFavorites(showFavorites);
api.getFavorites().then(showFavorites);

// ---------- Vinculación con Claude Code ----------
function showLink(s) {
  const st = $('link-status');
  const btn = $('link-toggle');
  btn.disabled = false;
  btn.textContent = s.linked ? 'Desvincular' : 'Vincular';
  btn.dataset.linked = s.linked ? '1' : '';
  st.className = s.error ? 'warn' : s.linked ? 'ok' : '';
  st.textContent = s.error ? s.error
    : s.linked ? 'Vinculado con Claude Code'
    : s.claudeFound ? 'Sin vincular' : 'Sin vincular · no se encontró Claude Code en este equipo';
  const ub = $('usage-toggle');
  ub.disabled = s.usage === 'foreign';
  ub.textContent = s.usage === 'on' ? 'Desactivar' : 'Activar';
  ub.dataset.on = s.usage === 'on' ? '1' : '';
  $('usage-status').className = s.usage === 'on' ? 'ok' : s.usage === 'foreign' ? 'warn' : '';
  $('usage-status').textContent = s.usage === 'on' ? 'Consumo del plan: activado'
    : s.usage === 'foreign' ? 'Consumo del plan: ya tienes una barra de estado propia en Claude Code'
    : 'Consumo del plan: desactivado';
}
$('usage-toggle').onclick = async () => {
  $('usage-toggle').disabled = true;
  showLink(await api.setClaudeUsage(!$('usage-toggle').dataset.on));
};

// ---------- Actualizaciones ----------
function showUpdate(s) {
  const st = $('update-status');
  const btn = $('update-btn');
  const text = {
    dev: 'Versión de desarrollo: sin actualizaciones automáticas',
    idle: '',
    checking: 'Buscando actualizaciones…',
    none: 'Tienes la última versión',
    downloading: `Descargando la versión ${s.version}… ${s.percent || 0}%`,
    ready: `Versión ${s.version} lista para instalar`,
    error: `No se pudo comprobar: ${s.message || 'error desconocido'}`,
  }[s.state] || '';
  st.textContent = `Versión ${s.current}${text ? ' · ' + text : ''}`;
  st.className = s.state === 'ready' ? 'ok' : s.state === 'error' ? 'warn' : '';
  btn.textContent = s.state === 'ready' ? 'Reiniciar y actualizar' : 'Buscar actualizaciones';
  btn.dataset.ready = s.state === 'ready' ? '1' : '';
  btn.disabled = ['dev', 'checking', 'downloading'].includes(s.state);
}
$('update-btn').onclick = () => { if ($('update-btn').dataset.ready) api.installUpdate(); else api.checkUpdate(); };
api.onUpdateStatus(showUpdate);
api.getUpdate().then(showUpdate);
$('link-toggle').onclick = async () => {
  $('link-toggle').disabled = true;
  showLink(await api.setClaudeLink(!$('link-toggle').dataset.linked));
};
api.getClaudeLink().then(showLink);

function focusSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  $('picker').hidden = true;
  el.scrollIntoView({ block: 'start' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1500);
}
api.onFocusSection(focusSection);
if (location.hash) setTimeout(() => focusSection(location.hash.slice(1)), 100);

api.getSettings().then(show);
