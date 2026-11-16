const api = window.islandAPI;
const $ = (id) => document.getElementById(id);
const UNITS = { tint: '%', dark: '%', sheen: '%', blurPx: ' px', scale: '%', mainWidth: ' px' };
const FIELDS = ['tint', 'dark', 'sheen', 'blur', 'blurPx', 'colorMode', 'color', 'focusMin', 'breakMin', 'openAtLogin', 'showVolume', 'showActions', 'showFavorites', 'showUsage', 'showGames', 'showLaunchers', 'showOffice', 'showProjects', 'showTools', 'showClaude', 'showBrowsers', 'hideEmptyTabs', 'scale', 'mainWidth'];

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
  const full = list.length >= 30;
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
  const full = pickerTarget === 'favorites' && favorites.length >= 30;
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
      if (pickerTarget.startsWith('cat:')) {
        await api.addCategoryApp(pickerTarget.slice(4), a.id);
        $('picker').hidden = true;
        return;
      }
      if (pickerTarget.startsWith('project:')) {
        await api.addProjectItem(pickerTarget.slice(8), 'app', a.id);
        $('picker').hidden = true;
        return;
      }
      await api.addLibrary(pickerTarget, a.id);
      $('picker').hidden = true;
    };
    box.append(b);
  }
  const status = $('app-status');
  status.hidden = shown.length > 0 && !full;
  status.textContent = full ? 'Ya tienes 30 favoritas: quita alguna para añadir más.'
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
$('lib-add-tools').onclick = () => openPicker('tools');
$('lib-add-browsers').onclick = () => openPicker('browsers');

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
  showLibraryList('lib-tools', lib.tools || []);
  showLibraryList('lib-browsers', lib.browsers || []);
}
$('lib-refresh').onclick = async () => {
  $('lib-refresh').disabled = true;
  $('lib-refresh').textContent = 'Buscando…';
  apps = null;
  await api.refreshLibrary();
  $('lib-refresh').disabled = false;
  $('lib-refresh').textContent = 'Volver a buscar';
};
// ---------- Tamaño y posición ----------
$('pos-reset').onclick = () => api.resetPosition();

// ---------- Soltar accesos directos en la configuración ----------
function dropZone(el, target) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('over');
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) await api.dropPaths(paths, typeof target === 'function' ? target() : target);
  });
}
dropZone($('fav-drop'), 'favorites');
window.addEventListener('dragover', (e) => e.preventDefault()); // fuera de las zonas no se navega al archivo soltado
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- Categorías propias ----------
function showCategories(list) {
  const box = $('category-list');
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.category : null;
  box.textContent = '';
  for (const c of list) {
    const card = document.createElement('div');
    card.className = 'project';
    const head = document.createElement('div');
    head.className = 'project-head';
    const name = document.createElement('input');
    name.value = c.name; name.maxLength = 18; name.dataset.category = c.id;
    name.setAttribute('aria-label', 'Nombre de la categoría');
    name.addEventListener('change', () => api.renameCategory(c.id, name.value));
    const del = document.createElement('button');
    del.textContent = 'Eliminar';
    del.onclick = () => api.deleteCategory(c.id);
    head.append(name, del);
    const items = document.createElement('div');
    items.className = 'items';
    c.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'fav';
      let icon;
      if (it.icon) { icon = document.createElement('img'); icon.src = it.icon; icon.alt = ''; }
      else { icon = document.createElement('span'); icon.className = 'letter'; icon.textContent = (it.name[0] || '?').toUpperCase(); }
      const n = document.createElement('span');
      n.className = 'name'; n.textContent = it.name; n.title = it.detail || it.name;
      const rm = document.createElement('button');
      rm.textContent = 'Quitar';
      rm.onclick = () => api.removeCategoryItem(c.id, i);
      row.append(icon, n, rm);
      items.append(row);
    });
    const add = document.createElement('div');
    add.className = 'inline';
    const btn = document.createElement('button');
    btn.textContent = 'Añadir app…';
    btn.onclick = () => openPicker(`cat:${c.id}`);
    add.append(btn);
    const zone = document.createElement('div');
    zone.className = 'drop';
    zone.textContent = 'O arrastra aquí accesos directos, programas o carpetas';
    dropZone(zone, `cat:${c.id}`);
    card.append(head, items, add, zone);
    box.append(card);
  }
  $('category-new').disabled = list.length >= 8;
  if (focused) { const el = box.querySelector(`input[data-category="${focused}"]`); if (el) { el.focus(); if (el.value === 'Categoría nueva') el.select(); } }
}
$('category-new').onclick = async () => {
  const list = await api.createCategory();
  showCategories(list);
  const last = list[list.length - 1];
  const el = last && $('category-list').querySelector(`input[data-category="${last.id}"]`);
  if (el) { el.focus(); el.select(); }
};
api.onCategories(showCategories);
api.getCategories().then(showCategories);

// ---------- Proyectos ----------
const TYPE_LABEL = { file: 'Archivo', folder: 'Carpeta', app: 'App', url: 'Web' };
function showProjects(list) {
  const box = $('project-list');
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.project : null;
  box.textContent = '';
  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'project';
    const head = document.createElement('div');
    head.className = 'project-head';
    const name = document.createElement('input');
    name.value = p.name; name.maxLength = 40; name.dataset.project = p.id;
    name.setAttribute('aria-label', 'Nombre del proyecto');
    name.addEventListener('change', () => api.renameProject(p.id, name.value));
    const del = document.createElement('button');
    del.textContent = 'Eliminar';
    del.onclick = () => api.deleteProject(p.id);
    head.append(name, del);

    const items = document.createElement('div');
    items.className = 'items';
    p.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'fav';
      const type = document.createElement('span');
      type.className = 'type'; type.textContent = TYPE_LABEL[it.type] || '';
      const n = document.createElement('span');
      n.className = 'name'; n.textContent = it.name; n.title = it.detail || it.name;
      const rm = document.createElement('button');
      rm.textContent = 'Quitar';
      rm.onclick = () => api.removeProjectItem(p.id, i);
      row.append(type, n, rm);
      items.append(row);
    });

    const full = p.items.length >= 20;
    const add = document.createElement('div');
    add.className = 'inline';
    const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.disabled = full; b.onclick = fn; return b; };
    add.append(
      mk('Archivo…', () => api.addProjectItem(p.id, 'file')),
      mk('Carpeta…', () => api.addProjectItem(p.id, 'folder')),
      mk('App…', () => openPicker(`project:${p.id}`)),
    );
    const urlRow = document.createElement('div');
    urlRow.className = 'project-url';
    const url = document.createElement('input');
    url.placeholder = 'Dirección web (ej. github.com)'; url.disabled = full;
    url.setAttribute('aria-label', 'Dirección web');
    const addUrl = mk('Añadir web', async () => { if (url.value.trim()) await api.addProjectItem(p.id, 'url', url.value); });
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') addUrl.click(); });
    urlRow.append(url, addUrl);

    card.append(head, items, add, urlRow);
    box.append(card);
  }
  if (focused) { // la lista se reconstruye al guardar: se devuelve el foco al mismo campo
    const el = box.querySelector(`input[data-project="${focused}"]`);
    if (el) { el.focus(); if (el.value === 'Proyecto nuevo') el.select(); }
  }
}
$('project-new').onclick = async () => {
  const list = await api.createProject();
  showProjects(list);
  const last = list[list.length - 1];
  const el = last && $('project-list').querySelector(`input[data-project="${last.id}"]`);
  if (el) { el.focus(); el.select(); }
};
api.onProjects(showProjects);
api.getProjects().then(showProjects);

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
  const last = $('link-last');
  if (!s.linked) last.textContent = '';
  else if (s.lastHookAt) last.textContent = `Último aviso recibido de Claude Code: ${new Date(s.lastHookAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. La conexión funciona.`;
  else last.textContent = 'Aún no ha llegado ningún aviso desde que abriste la isla. La isla solo muestra actividad de Claude Code (el de la terminal o la pestaña "Code" de la app de escritorio); las conversaciones de claude.ai o del chat de la app no envían avisos. Abre una sesión nueva de Claude Code y escribe algo.';
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
setInterval(() => api.getClaudeLink().then(showLink), 5000); // refresca "último aviso recibido"

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
