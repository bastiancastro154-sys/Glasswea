const api = window.islandAPI;
const $ = (id) => document.getElementById(id);
const UNITS = { tint: '%', dark: '%', sheen: '%', blurPx: ' px' };
const FIELDS = ['tint', 'dark', 'sheen', 'blur', 'blurPx', 'colorMode', 'color', 'focusMin', 'breakMin', 'openAtLogin', 'showVolume', 'showActions', 'showFavorites'];

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
  $('fav-add-app').disabled = $('fav-add-folder').disabled = full;
}
$('fav-add-app').onclick = () => api.addFavorite('app');
$('fav-add-folder').onclick = () => api.addFavorite('folder');
api.onFavorites(showFavorites);
api.getFavorites().then(showFavorites);

api.getSettings().then(show);
