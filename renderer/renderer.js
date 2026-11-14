const $ = (id) => document.getElementById(id);
const api = window.islandAPI || null; // null => modo demo en el navegador

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9.5 16.2L5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M12 22a2.2 2.2 0 0 0 2.2-2.2H9.800A2.2 2.2 0 0 0 12 22zm7-6v-5a7 7 0 0 0-5.5-6.800V3.500a1.5 1.5 0 0 0-3 0v.7A7 7 0 0 0 5 11v5l-2 2v1h18v-1z"/></svg>',
  timer: '<svg viewBox="0 0 24 24"><path d="M9 1h6v2H9zM12 5a9 9 0 1 0 9 9 9 9 0 0 0-9-9zm1 10h-2V8h2z"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm11.5-.9v7.8a4.5 4.5 0 0 0 0-7.8zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  volOff: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm18.6.8L20.2 8.4 18 10.600l-2.2-2.2-1.4 1.4 2.2 2.2-2.2 2.2 1.4 1.4 2.2-2.2 2.2 2.2 1.4-1.4-2.2-2.200z"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.900V22h2v-3.100A7 7 0 0 0 19 12z"/></svg>',
  micOff: '<svg viewBox="0 0 24 24"><path d="M3.4 2L2 3.400l7 7V12a3 3 0 0 0 4.3 2.700l1.5 1.500A5 5 0 0 1 7 12H5a7 7 0 0 0 6 6.900V22h2v-3.100a7 7 0 0 0 3.3-1.300l4.3 4.3 1.4-1.400zM15 5a3 3 0 0 0-6 0v.200l6 6zm4 7h-2a5 5 0 0 1-.3 1.700l1.5 1.500A7 7 0 0 0 19 12z"/></svg>',
};
const EQ = (paused) => `<span class="eq${paused ? ' paused' : ''}"><i></i><i></i><i></i></span>`;

let FOCUS = 25 * 60;
let BREAK = 5 * 60;
let cfg = { colorMode: 'auto', color: '#7f8cff' };

const state = {
  hover: false,
  music: { active: false, id: '', title: '', artist: '', playing: false, position: 0, duration: 0, thumb: null, at: 0 },
  sessions: [],
  pickId: null,
  autoId: null,
  claude: { state: 'off', detail: '', project: '', at: 0 },
  timer: { mode: 'focus', total: FOCUS, remaining: FOCUS, running: false, endAt: 0, finishedAt: 0 },
  audio: { volume: null, muted: false, micMuted: null },
  volFlashUntil: 0,
  claudeLinked: null,
  usage: null,
  updateNoteUntil: 0,
  updateVersion: '',
  favorites: [],
  library: { games: [], launchers: [], office: [] },
  projects: [],
};

const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- Color: la isla toma el color de la carátula ----------
function hashHue(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
function setAccent(rgb) {
  document.documentElement.style.setProperty('--accent', rgb.join(', '));
}
function accentFromImage(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 24, 24);
  const d = ctx.getImageData(0, 0, 24, 24).data;
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const max = Math.max(d[i], d[i + 1], d[i + 2]);
    const min = Math.min(d[i], d[i + 1], d[i + 2]);
    // Pesa más los píxeles saturados y de brillo medio: evita que gane el negro o el blanco.
    const weight = 0.05 + ((max - min) / 255) ** 2 * (max / 255);
    r += d[i] * weight; g += d[i + 1] * weight; b += d[i + 2] * weight; w += weight;
  }
  let rgb = [r / w, g / w, b / w];
  const peak = Math.max(...rgb, 1);
  const boost = Math.min(2, 190 / peak); // lleva el canal dominante hacia ~190
  return rgb.map((v) => Math.round(Math.min(255, v * boost)));
}
function updateAccent() {
  const m = state.music;
  if (cfg.colorMode === 'fixed') {
    const n = parseInt(cfg.color.slice(1), 16);
    return setAccent([n >> 16, (n >> 8) & 255, n & 255]);
  }
  if (!m.active) return setAccent([150, 160, 190]);
  if (m.thumb) {
    const img = $('art-img');
    const apply = () => { try { setAccent(accentFromImage(img)); } catch { setAccent(hslToRgb(hashHue(m.title), 0.5, 0.5)); } };
    if (img.complete && img.naturalWidth) apply(); else img.onload = apply;
  } else {
    setAccent(hslToRgb(hashHue(m.title + m.artist), 0.5, 0.5));
  }
}

// ---------- Estado derivado ----------
function musicPosition() {
  const m = state.music;
  if (!m.playing) return m.position;
  const p = m.position + (Date.now() - m.at) / 1000;
  return m.duration ? Math.min(p, m.duration) : p;
}
function timerRemaining() {
  const t = state.timer;
  return t.running ? Math.max(0, (t.endAt - Date.now()) / 1000) : t.remaining;
}
function claudeVisible() {
  const c = state.claude;
  if (c.state === 'off' || c.state === 'idle') return false;
  if (c.state === 'done') return Date.now() - c.at < 8000; // "Terminó" se muestra unos segundos
  return true;
}

// ---------- Render ----------
function renderCompact() {
  const { music: m, claude: c, timer: t } = state;
  const timerActive = t.running || Date.now() - t.finishedAt < 8000;
  let icon, text, side = '', pulse = false;

  // Indicador breve al cambiar el volumen (teclas multimedia, otra app…)
  const updateNote = Date.now() < state.updateNoteUntil;
  const flash = Date.now() < state.volFlashUntil && state.audio.volume != null;
  $('c-bar').style.display = flash ? 'block' : '';
  $('c-text').style.display = flash ? 'none' : '';

  if (flash) {
    const a = state.audio;
    icon = a.muted || a.volume === 0 ? ICONS.volOff : ICONS.vol;
    text = '';
    side = a.muted ? 'Silencio' : `${a.volume}%`;
    $('c-bar').firstElementChild.style.width = `${a.muted ? 0 : a.volume}%`;
  } else if (updateNote) {
    icon = ICONS.check; text = `Versión ${state.updateVersion} lista · reinicia`;
  } else if (c.state === 'attention') {
    icon = ICONS.bell; text = 'Claude te necesita'; pulse = true;
  } else if (Date.now() - t.finishedAt < 8000) {
    icon = ICONS.timer; text = t.mode === 'focus' ? '¡Descanso terminado!' : '¡Enfoque completado!'; pulse = true;
  } else if (claudeVisible()) {
    icon = c.state === 'done' ? ICONS.check : ICONS.spark.replace('<svg', '<svg class="spin"');
    text = c.state === 'done' ? 'Claude terminó' : c.detail || 'Claude trabajando';
    side = t.running ? fmt(timerRemaining()) : m.playing ? EQ(false) : '';
  } else if (t.running) {
    icon = ICONS.timer; text = `${t.mode === 'focus' ? 'Enfoque' : 'Descanso'} · ${fmt(timerRemaining())}`;
    side = m.playing ? EQ(false) : '';
  } else if (m.active && m.title) {
    icon = m.thumb ? `<img src="${m.thumb}" alt="">` : ICONS.play;
    text = m.title;
    side = EQ(!m.playing);
  } else {
    icon = ''; side = '';
    text = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  if ($('c-icon').dataset.k !== icon) { $('c-icon').innerHTML = icon; $('c-icon').dataset.k = icon; }
  $('c-icon').style.display = icon ? '' : 'none';
  $('c-text').textContent = text;
  if ($('c-side').dataset.k !== side || !side.startsWith('<')) { $('c-side').innerHTML = side; $('c-side').dataset.k = side; }
  $('c-side').style.display = side ? '' : 'none';
  $('island').classList.toggle('pulse', pulse && !state.hover);
  if (flash) return 200;
  return icon || side || timerActive ? Math.min(300, 96 + text.length * 7.2) : 96;
}

function renderExpanded() {
  const { music: m, claude: c, timer: t } = state;

  $('title').textContent = m.active && m.title ? m.title : 'Nada sonando';
  const mApp = appName(m.source);
  $('artist').textContent = m.active && m.title ? [m.artist, mApp].filter(Boolean).join(' · ') || '—' : 'Reproduce algo y aparecerá aquí';
  renderOthers();
  const img = $('art-img');
  if (m.thumb) { if (img.getAttribute('src') !== m.thumb) img.src = m.thumb; } else img.removeAttribute('src');
  const pos = musicPosition();
  $('bar-fill').style.width = m.duration ? `${(pos / m.duration) * 100}%` : '0%';
  $('t-pos').textContent = fmt(pos);
  $('t-dur').textContent = m.duration ? fmt(m.duration) : '–:––';
  const playIcon = m.playing ? ICONS.pause : ICONS.play;
  if ($('btn-play').dataset.k !== playIcon) { $('btn-play').innerHTML = playIcon; $('btn-play').dataset.k = playIcon; }

  $('claude').dataset.state = c.state;
  const cIcon = c.state === 'working' ? ICONS.spark.replace('<svg', '<svg class="spin"')
    : c.state === 'done' ? ICONS.check : c.state === 'attention' ? ICONS.bell : ICONS.spark;
  if ($('claude-icon').dataset.k !== cIcon) { $('claude-icon').innerHTML = cIcon; $('claude-icon').dataset.k = cIcon; }
  const label = { off: state.claudeLinked === false ? 'Vincular…' : 'Sin sesión activa', idle: 'En espera', working: c.detail || 'Trabajando…', done: 'Terminó', attention: c.detail || 'Necesita tu atención' }[c.state];
  $('claude-detail').textContent = label;
  $('claude-detail').title = label;
  document.querySelector('#claude .tile-label').textContent = c.project && c.state !== 'off' ? `Claude · ${c.project}`
    : state.claudeLinked && c.state === 'off' ? 'Claude Code · vinculado' : 'Claude Code';

  const rem = timerRemaining();
  $('timer-label').textContent = t.mode === 'focus' ? 'Enfoque' : 'Descanso';
  $('timer-value').textContent = fmt(rem);
  $('ring-fill').style.strokeDashoffset = 94.25 * (1 - rem / t.total);
  const tIcon = t.running ? ICONS.pause : ICONS.play;
  if ($('timer-toggle').dataset.k !== tIcon) { $('timer-toggle').innerHTML = tIcon; $('timer-toggle').dataset.k = tIcon; }

  renderUsage();

  const a = state.audio;
  const hasVol = a.volume != null;
  const silent = a.muted || a.volume === 0;
  setIcon('vol-mute', silent ? ICONS.volOff : ICONS.vol);
  $('volume').classList.toggle('muted', !!a.muted);
  $('vol-slider').disabled = !hasVol;
  if (hasVol && Date.now() - lastVolInput > 400) $('vol-slider').value = a.volume;
  $('vol-slider').style.setProperty('--v', `${hasVol ? $('vol-slider').value : 0}%`);
  $('vol-value').textContent = hasVol ? `${$('vol-slider').value}%` : '–';
  setIcon('act-mic', a.micMuted ? ICONS.micOff : ICONS.mic);
  $('act-mic').classList.toggle('off', a.micMuted === true);
  $('act-mic').disabled = a.micMuted == null;
  $('act-mic').title = a.micMuted == null ? 'Sin micrófono' : a.micMuted ? 'Activar micrófono' : 'Silenciar micrófono';
}
// Consumo del plan: una ventana deja de mostrarse cuando pasa su hora de reinicio (el dato ya no vale).
function untilText(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
function renderUsage() {
  const u = state.usage;
  const now = Date.now();
  const rows = [['u-5h', u && u.fiveHour, 'Límite de 5 horas'], ['u-7d', u && u.sevenDay, 'Límite semanal']];
  let shown = 0;
  for (const [id, w, name] of rows) {
    const el = $(id);
    const ok = !!w && (!w.resetsAt || w.resetsAt > now);
    el.hidden = !ok;
    if (!ok) continue;
    shown++;
    const pct = Math.min(100, Math.round(w.pct));
    el.querySelector('i').style.width = `${pct}%`;
    el.querySelector('.u-pct').textContent = `${pct}%`;
    el.classList.toggle('warn', pct >= 75 && pct < 90);
    el.classList.toggle('crit', pct >= 90);
    el.title = `${name}: ${pct}% usado` + (w.resetsAt ? ` · se reinicia en ${untilText(w.resetsAt - now)}` : '') + ` · leído hace ${untilText(now - u.at)}`;
  }
  $('u-5h').classList.toggle('single', shown === 1);
  $('u-7d').classList.toggle('single', shown === 1);
  $('usage').hidden = shown === 0 || cfg.showUsage === false;
}
function setIcon(id, svg) {
  if ($(id).dataset.k !== svg) { $(id).innerHTML = svg; $(id).dataset.k = svg; }
}

function render() {
  const island = $('island');
  const compactWidth = renderCompact();
  renderExpanded();
  $('drawer-handle').classList.toggle('running', state.timer.running);
  $('drawer-handle').title = state.timer.running ? `Enfoque y calendario · quedan ${fmt(timerRemaining())}` : 'Enfoque y calendario';
  if (state.hover) {
    // Con el panel lateral abierto la isla crece hacia la derecha: se desplaza la mitad de lo que crece
    // para que el borde izquierdo no se mueva.
    const extra = drawerOpen ? DRAWER_W : 0;
    island.dataset.mode = 'expanded';
    island.classList.toggle('drawer-open', drawerOpen);
    island.style.width = `${420 + extra}px`;
    island.style.height = `${Math.max($('expanded').offsetHeight, drawerOpen ? $('drawer').offsetHeight : 0)}px`;
    island.style.transform = `translateX(calc(-50% + ${extra / 2}px))`;
  } else {
    island.dataset.mode = 'compact';
    island.style.width = `${Math.round(compactWidth)}px`;
    island.style.height = '36px';
    island.style.transform = '';
  }
}

// ---------- Panel lateral: enfoque y calendario ----------
const DRAWER_W = 236;
let drawerOpen = false;
try { drawerOpen = localStorage.getItem('drawer') === '1'; } catch { /* sin almacenamiento */ }
const cal = { year: new Date().getFullYear(), month: new Date().getMonth(), builtFor: '' };
function buildCalendar() {
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  cal.builtFor = `${todayKey}|${cal.year}-${cal.month}`;
  const first = new Date(cal.year, cal.month, 1);
  const month = first.toLocaleDateString('es', { month: 'long' });
  $('cal-title').textContent = `${month[0].toUpperCase()}${month.slice(1)} ${cal.year}`;
  const grid = $('cal-grid');
  grid.textContent = '';
  for (const d of ['L', 'M', 'X', 'J', 'V', 'S', 'D']) {
    const el = document.createElement('div');
    el.className = 'dow'; el.textContent = d;
    grid.append(el);
  }
  const start = new Date(cal.year, cal.month, 1 - ((first.getDay() + 6) % 7)); // la semana empieza en lunes
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const el = document.createElement('div');
    el.className = 'day';
    if (d.getMonth() !== cal.month) el.classList.add('out');
    if (d.getDay() === 0 || d.getDay() === 6) el.classList.add('weekend');
    if (`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === todayKey) { el.classList.add('today'); el.setAttribute('aria-current', 'date'); }
    el.textContent = d.getDate();
    grid.append(el);
  }
}
function calendarTick() { // al cambiar de día se vuelve a marcar "hoy"
  const now = new Date();
  if (!cal.builtFor.startsWith(`${now.getFullYear()}-${now.getMonth()}-${now.getDate()}|`)) buildCalendar();
}
function moveMonth(delta) {
  const d = new Date(cal.year, cal.month + delta, 1);
  cal.year = d.getFullYear(); cal.month = d.getMonth();
  buildCalendar();
}
$('cal-prev').onclick = () => moveMonth(-1);
$('cal-next').onclick = () => moveMonth(1);
$('cal-today').onclick = () => { const n = new Date(); cal.year = n.getFullYear(); cal.month = n.getMonth(); buildCalendar(); };
$('drawer-handle').onclick = () => {
  drawerOpen = !drawerOpen;
  try { localStorage.setItem('drawer', drawerOpen ? '1' : '0'); } catch { /* sin almacenamiento */ }
  $('drawer-handle').setAttribute('aria-expanded', String(drawerOpen));
  render();
};
$('drawer-handle').setAttribute('aria-expanded', String(drawerOpen));
buildCalendar();

// ---------- Temporizador ----------
function timerTick() {
  const t = state.timer;
  if (t.running && Date.now() >= t.endAt) {
    t.running = false;
    t.finishedAt = Date.now();
    t.mode = t.mode === 'focus' ? 'break' : 'focus'; // prepara la siguiente fase
    t.total = t.remaining = t.mode === 'focus' ? FOCUS : BREAK;
    try { new Notification('Glass Island', { body: t.mode === 'break' ? 'Enfoque completado. Toca descansar.' : 'Descanso terminado. A enfocarse.' }); } catch { /* sin permiso */ }
  }
}
$('timer-toggle').onclick = () => {
  const t = state.timer;
  if (t.running) { t.remaining = timerRemaining(); t.running = false; }
  else { t.endAt = Date.now() + t.remaining * 1000; t.running = true; t.finishedAt = 0; }
  render();
};
$('timer-reset').onclick = () => {
  const t = state.timer;
  t.running = false; t.remaining = t.total; t.finishedAt = 0;
  render();
};
$('timer-mode').onclick = () => {
  const t = state.timer;
  t.running = false; t.finishedAt = 0;
  t.mode = t.mode === 'focus' ? 'break' : 'focus';
  t.total = t.remaining = t.mode === 'focus' ? FOCUS : BREAK;
  render();
};

// ---------- Música: varios reproductores a la vez ----------
// Windows expone cada reproductor (Spotify, el navegador, etc.) como una sesión. La tarjeta grande muestra
// una; las demás aparecen debajo con sus propios controles.
const NO_MUSIC = { active: false, id: '', title: '', artist: '', playing: false, position: 0, duration: 0, thumb: null, at: 0 };
const APP_NAMES = [[/spotify/i, 'Spotify'], [/chrome/i, 'Chrome'], [/msedge|edge/i, 'Edge'], [/firefox/i, 'Firefox'], [/brave/i, 'Brave'],
  [/opera/i, 'Opera'], [/vlc/i, 'VLC'], [/zunemusic|mediaplayer/i, 'Reproductor multimedia'], [/itunes|applemusic/i, 'Apple Music'], [/youtube/i, 'YouTube'], [/comet/i, 'Comet']];
function appName(source) {
  if (!source) return '';
  const known = APP_NAMES.find(([re]) => re.test(source));
  if (known) return known[1];
  const base = source.split('!').pop().split(/[\\/]/).pop().replace(/\.exe$/i, '').replace(/#\d+$/, '');
  return base.length > 24 ? '' : base;
}
function onMedia(d) {
  // Formato antiguo (una sola sesión) convertido al nuevo, para la demo.
  const incoming = d.sessions || (d.active ? [{ ...d, id: '_', source: '' }] : []);
  const now = Date.now();
  const prev = new Map(state.sessions.map((s) => [s.id, s]));
  state.sessions = incoming.filter((s) => s.title || s.playing).map((s) => {
    const old = prev.get(s.id);
    const changed = s.trackChanged || !old || s.title !== old.title || s.artist !== old.artist;
    const hold = old && now - old.localAt < 1500; // se acaba de pulsar play/pausa aquí: no pisar la respuesta inmediata
    return {
      active: true, id: s.id, source: s.source || '', title: s.title || '', artist: s.artist || '',
      playing: hold ? old.playing : !!s.playing, position: s.position || 0, duration: s.duration || 0, at: now,
      thumb: 'thumb' in s ? s.thumb || null : changed ? null : old.thumb, localAt: old ? old.localAt : 0,
    };
  });
  selectSession(d.current);
  render();
  updateAccent();
}
// Elige qué reproductor ocupa la tarjeta grande: el que fijó el usuario; si no, se mantiene el que ya estaba
// mientras siga sonando, y si no, el que esté sonando.
function selectSession(current) {
  const list = state.sessions;
  let sel = list.find((s) => s.id === state.pickId);
  if (!sel) {
    state.pickId = null;
    const before = list.find((s) => s.id === state.autoId);
    sel = (before && before.playing ? before : null)
      || list.find((s) => s.id === current && s.playing) || list.find((s) => s.playing)
      || before || list.find((s) => s.id === current) || list[0];
  }
  state.autoId = sel ? sel.id : null;
  state.music = sel || NO_MUSIC;
}
function mediaAction(session, action) {
  if (action === 'toggle') { // respuesta inmediata; el observador confirma después
    session.position = session.playing ? Math.min(session.position + (Date.now() - session.at) / 1000, session.duration || Infinity) : session.position;
    session.at = session.localAt = Date.now();
    session.playing = !session.playing;
    render();
  }
  (api ? api.mediaControl : demo.mediaControl)(action, session.id);
}
document.querySelectorAll('[data-media]').forEach((b) => {
  b.onclick = () => { if (state.music.active) mediaAction(state.music, b.dataset.media); };
});

let othersKey = '';
function renderOthers() {
  const others = state.sessions.filter((s) => s !== state.music).slice(0, 3);
  const box = $('others');
  box.hidden = others.length === 0;
  const key = others.map((s) => `${s.id}|${s.title}|${s.artist}|${s.playing}|${s.thumb ? s.thumb.length : 0}`).join('\n');
  if (key === othersKey) return; // solo se reconstruye cuando algo cambia
  othersKey = key;
  box.textContent = '';
  for (const s of others) {
    const row = document.createElement('div');
    row.className = 'other';
    const pick = document.createElement('button');
    pick.className = 'o-pick';
    pick.title = 'Mostrar este reproductor arriba';
    const app = appName(s.source);
    let icon;
    if (s.thumb) { icon = document.createElement('img'); icon.src = s.thumb; icon.alt = ''; }
    else { icon = document.createElement('span'); icon.className = 'letter'; icon.textContent = ((app || s.title)[0] || '?').toUpperCase(); }
    const text = document.createElement('span');
    text.className = 'o-text';
    text.textContent = s.title || 'Sin título';
    if (app) { const a = document.createElement('span'); a.className = 'o-app'; a.textContent = ` · ${app}`; text.append(a); }
    pick.append(icon, text);
    pick.onclick = () => { state.pickId = s.id; selectSession(); render(); updateAccent(); };
    const mk = (title, svg, action) => {
      const b = document.createElement('button');
      b.className = 'o-btn'; b.title = title; b.innerHTML = svg;
      b.onclick = () => mediaAction(s, action);
      return b;
    };
    row.append(pick, mk(s.playing ? 'Pausar' : 'Reproducir', s.playing ? ICONS.pause : ICONS.play, 'toggle'),
      mk('Siguiente', '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>', 'next'));
    box.append(row);
  }
}

// ---------- Claude Code ----------
function onClaude(d) {
  Object.assign(state.claude, d);
  render();
}

// ---------- Ratón: expandir y dejar pasar los clics fuera de la isla ----------
let leaveTimer = null;
$('island').addEventListener('mouseenter', () => {
  mouseInside = true;
  clearTimeout(leaveTimer);
  state.hover = true;
  api?.setInteractive(true);
  if (state.claude.state === 'attention') state.claude.state = 'idle';
  render();
});
$('island').addEventListener('mouseleave', () => {
  mouseInside = false;
  if (typing) { api?.setInteractive(false); return; } // sigue abierta hasta que el buscador pierda el foco
  leaveTimer = setTimeout(collapse, 250);
});

// ---------- Configuración ----------
function applySettings(s) {
  cfg = s;
  const root = document.documentElement.style;
  root.setProperty('--tint', s.tint / 100);
  root.setProperty('--dark', s.dark / 100);
  root.setProperty('--sheen', s.sheen / 100);
  root.setProperty('--blur', `${s.blurPx}px`);
  FOCUS = s.focusMin * 60;
  BREAK = s.breakMin * 60;
  const t = state.timer;
  const total = t.mode === 'focus' ? FOCUS : BREAK;
  if (!t.running && t.total !== total) { t.total = t.remaining = total; } // no altera una cuenta en marcha
  $('volume').hidden = !s.showVolume;
  $('actions').hidden = !s.showActions;
  $('vol-row').hidden = !s.showVolume && !s.showActions;
  $('vol-row').classList.toggle('no-volume', !s.showVolume);
  updateAccent();
  buildShelf();
}
$('btn-settings').onclick = () => api?.openSettings();
$('claude').onclick = () => api?.openSettings('claude');
$('claude').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') api?.openSettings('claude'); };
function onClaudeLink(s) { state.claudeLinked = !!(s && s.linked); render(); }

// ---------- Volumen y acciones rápidas ----------
let lastVolInput = 0;
function onAudio(d) {
  if (!d) return;
  const prev = state.audio;
  const changed = prev.volume != null && (prev.volume !== d.volume || prev.muted !== d.muted);
  state.audio = d;
  // No se avisa si el cambio lo acaba de hacer el usuario desde la propia isla.
  if (changed && !state.hover && Date.now() - lastVolInput > 800 && cfg.showVolume !== false) {
    state.volFlashUntil = Date.now() + 1800;
    setTimeout(render, 1850);
  }
  render();
}
$('vol-slider').addEventListener('input', (e) => {
  lastVolInput = Date.now();
  const v = Number(e.target.value);
  state.audio = { ...state.audio, volume: v, muted: v === 0 ? state.audio.muted : false };
  api?.audioCommand('vol', v / 100);
  render();
});
$('vol-mute').onclick = () => {
  lastVolInput = Date.now();
  state.audio = { ...state.audio, muted: !state.audio.muted };
  api?.audioCommand('mute');
  render();
};
document.querySelectorAll('[data-action]').forEach((b) => {
  b.onclick = () => {
    const name = b.dataset.action;
    if (name === 'mic') {
      if (state.audio.micMuted == null) return;
      state.audio = { ...state.audio, micMuted: !state.audio.micMuted };
      api?.audioCommand('mic');
      render();
    } else {
      api?.quickAction(name);
    }
  };
});

// ---------- Apps favoritas ----------
const TABS = [
  { id: 'apps', label: 'Apps', setting: 'showFavorites', empty: '＋ Agrega tus apps favoritas', section: undefined },
  { id: 'games', label: 'Juegos', setting: 'showGames', empty: 'No se encontraron juegos · añadir', section: 'juegos' },
  { id: 'launchers', label: 'Launchers', setting: 'showLaunchers', empty: 'No se encontraron launchers · añadir', section: 'juegos' },
  { id: 'projects', label: 'Proyectos', setting: 'showProjects', empty: '＋ Crea tu primer proyecto', section: 'proyectos' },
  { id: 'office', label: 'Office', setting: 'showOffice', empty: 'No se encontraron apps de Office · añadir', section: 'office' },
];
const RECENTS_KINDS = new Set(['word', 'excel', 'powerpoint', 'access', 'publisher', 'visio', 'project']);
let officeView = null; // app de Office cuyo desplegable de recientes está abierto
let currentTab = 'apps';
try { currentTab = localStorage.getItem('tab') || 'apps'; } catch { /* sin almacenamiento */ }

function shelfItems(tab) {
  if (tab === 'projects') {
    return state.projects.map((p) => ({
      name: p.name, chip: true, count: p.items.length,
      title: p.items.length ? `Abrir ${p.items.length} elemento(s):\n${p.items.map((it) => `· ${it.name}`).join('\n')}` : 'Proyecto vacío: añade elementos en Configuración',
      open: () => (p.items.length ? api?.openProject(p.id) : api?.openSettings('proyectos')),
    }));
  }
  if (tab === 'apps') return state.favorites.map((f, i) => ({ name: f.name, icon: f.icon, open: () => api?.openFavorite(i) }));
  return (state.library[tab] || []).map((e) => ({
    name: e.name, title: e.source ? `${e.name} · ${e.source}` : e.name, icon: e.icon, cover: tab === 'games',
    // Las apps de Office con documentos (Word, Excel…) despliegan sus recientes en lugar de abrirse directamente.
    open: () => (tab === 'office' && RECENTS_KINDS.has(e.kind) ? openRecents(e) : api?.openLibrary(e.id)),
  }));
}
// Reconstruye las pestañas y sus iconos. Solo se llama cuando cambian los datos, no en cada refresco.
function buildShelf() {
  const tabs = TABS.filter((t) => cfg[t.setting] !== false);
  $('shelf').hidden = tabs.length === 0;
  if (!tabs.length) return render();
  if (!tabs.some((t) => t.id === currentTab)) currentTab = tabs[0].id;
  const tab = tabs.find((t) => t.id === currentTab);

  const bar = $('shelf-tabs');
  bar.textContent = '';
  bar.hidden = tabs.length < 2;
  for (const t of tabs) {
    const b = document.createElement('button');
    b.textContent = t.label;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(t.id === currentTab));
    b.onclick = () => {
      officeView = null;
      currentTab = t.id;
      try { localStorage.setItem('tab', t.id); } catch { /* sin almacenamiento */ }
      buildShelf();
    };
    bar.append(b);
  }

  const box = $('favorites');
  box.textContent = '';
  box.scrollTop = 0;
  box.classList.toggle('recents', !!officeView && tab.id === 'office');
  if (officeView && tab.id === 'office') { buildRecents(box); return; }
  const items = shelfItems(tab.id);
  if (!items.length) {
    const b = document.createElement('button');
    b.className = 'empty';
    b.textContent = tab.empty;
    b.onclick = () => api?.openSettings(tab.section);
    box.append(b);
  }
  for (const it of items) {
    const b = document.createElement('button');
    b.className = it.chip ? 'chip' : 'fav';
    b.title = it.title || it.name;
    if (it.chip) {
      const n = document.createElement('span');
      n.className = 'chip-name'; n.textContent = it.name;
      const c = document.createElement('span');
      c.className = 'chip-count'; c.textContent = it.count;
      b.append(n, c);
    } else if (it.icon) {
      const img = document.createElement('img');
      img.src = it.icon; img.alt = '';
      if (it.cover) img.className = 'cover';
      b.append(img);
    } else {
      const sp = document.createElement('span');
      sp.className = 'letter';
      sp.textContent = (it.name[0] || '?').toUpperCase();
      b.append(sp);
    }
    b.onclick = it.open;
    box.append(b);
  }
  render();
}
// ---------- Desplegable de documentos recientes de Office ----------
function whenText(at) {
  const d = new Date(at);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days <= 0) return `hoy ${time}`;
  if (days === 1) return `ayer ${time}`;
  if (days < 7) return `hace ${days} días`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
const ICON_PIN = '<svg viewBox="0 0 24 24"><path d="M14 3l7 7-2 1-3 3 .5 5L15 20.5 10.5 16 5 21.5 3.5 20 9 14.5 4.5 10 6 8.5l5 .5 3-3z"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 5h6l2 2h10v12H3z"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 24 24"><path d="M6 2h8l5 5v15H6zm7 1.5V8h4.5z"/></svg>';
const fold = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

async function openRecents(entry) {
  officeView = { entry, data: null, query: '' };
  buildShelf();
  const data = api ? await api.getOfficeRecents(entry.kind) : { pinned: [], recents: [] };
  if (officeView && officeView.entry.id === entry.id) { officeView.data = data; buildShelf(); }
}
function setOfficeData(data) {
  if (!officeView) return;
  officeView.data = data;
  fillRecents();
}
function iconButton(cls, title, svg, onclick) {
  const b = document.createElement('button');
  b.className = cls; b.title = title; b.innerHTML = svg; b.onclick = onclick;
  return b;
}
function buildRecents(box) {
  const { entry } = officeView;
  const kind = entry.kind;
  const head = document.createElement('div');
  head.className = 'r-head';
  const back = document.createElement('button');
  back.className = 'r-back'; back.title = 'Volver'; back.textContent = '‹';
  back.onclick = () => { officeView = null; stopTyping(); buildShelf(); };
  const name = document.createElement('span');
  name.className = 'r-app'; name.textContent = entry.name;
  const search = document.createElement('input');
  search.type = 'search'; search.id = 'r-search'; search.placeholder = 'Buscar…';
  search.setAttribute('aria-label', 'Buscar documento');
  search.value = officeView.query;
  search.addEventListener('focus', startTyping);
  search.addEventListener('blur', stopTyping);
  search.addEventListener('input', () => { officeView.query = search.value; fillRecents(); });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (search.value) { search.value = ''; officeView.query = ''; fillRecents(); } else search.blur();
  });
  const launch = document.createElement('button');
  launch.className = 'r-launch'; launch.textContent = 'Abrir app';
  launch.onclick = () => api?.openLibrary(entry.id);
  head.append(back, name, search,
    iconButton('r-add', 'Fijar documento…', ICON_FILE, async () => setOfficeData(await api.pinOfficeBrowse(kind, 'file'))),
    iconButton('r-add', 'Fijar carpeta…', ICON_FOLDER, async () => setOfficeData(await api.pinOfficeBrowse(kind, 'folder'))),
    launch);
  const list = document.createElement('div');
  list.className = 'r-list'; list.id = 'r-list';
  box.append(head, list);
  fillRecents();
}
// Rellena la lista (fijados primero) aplicando el texto del buscador. No toca la cabecera para no perder el foco.
function fillRecents() {
  const list = $('r-list');
  if (!list || !officeView) return;
  const { entry, data, query } = officeView;
  const kind = entry.kind;
  list.textContent = '';
  const q = fold(query.trim());
  const match = (it) => !q || fold(it.name).includes(q);
  const pinned = data ? data.pinned.filter(match) : [];
  const recents = data ? data.recents.filter(match).slice(0, q ? 60 : 30) : [];

  const row = (it, isPinned) => {
    const r = document.createElement('div');
    r.className = 'r-item' + (isPinned ? ' pinned' : '');
    const open = document.createElement('button');
    open.className = 'r-open';
    open.title = it.where ? `${it.name}\n${it.where}` : it.name;
    const n = document.createElement('span');
    n.className = 'r-name'; n.textContent = it.name;
    const w = document.createElement('span');
    w.className = 'r-when'; w.textContent = isPinned ? (it.folder ? 'carpeta' : 'fijado') : whenText(it.at);
    open.append(n, w);
    open.onclick = () => (isPinned ? api?.openOfficePin(kind, it.index) : api?.openOfficeRecent(it.id));
    const pin = iconButton('r-pin', isPinned ? 'Quitar de fijados' : 'Fijar arriba', ICON_PIN,
      async () => setOfficeData(isPinned ? await api.unpinOffice(kind, it.index) : await api.pinOfficeRecent(kind, it.id)));
    r.append(open, pin);
    return r;
  };
  pinned.forEach((it) => list.append(row(it, true)));
  recents.forEach((it) => list.append(row(it, false)));
  if (!pinned.length && !recents.length) {
    const p = document.createElement('div');
    p.className = 'r-empty';
    p.textContent = !data ? 'Buscando documentos…' : q ? 'Ningún documento coincide' : 'Sin documentos recientes';
    list.append(p);
  }
  render();
}

// Mientras se escribe en el buscador la isla acepta teclado y no se pliega al salir el ratón.
let typing = false;
let mouseInside = false;
function startTyping() {
  if (typing) return;
  typing = true;
  api?.setFocusable(true);
}
function stopTyping() {
  if (!typing) return;
  typing = false;
  api?.setFocusable(false);
  if (!mouseInside) collapse();
}
function collapse() {
  state.hover = false;
  api?.setInteractive(false);
  render();
}

// ---------- Proyectos ----------
function onProjects(list) {
  state.projects = list || [];
  buildShelf();
}

function onFavorites(list) {
  state.favorites = list || [];
  buildShelf();
}
function onLibrary(lib) {
  state.library = { games: (lib && lib.games) || [], launchers: (lib && lib.launchers) || [], office: (lib && lib.office) || [] };
  buildShelf();
}

// ---------- Desenfoque del escritorio ----------
const blur = { cfg: null, stream: null, x: null, y: null };
function stopBlur() {
  blur.stream?.getTracks().forEach((t) => t.stop());
  blur.stream = null; blur.cfg = null;
  $('backdrop').srcObject = null;
  $('island').classList.remove('blur');
}
async function setupBlur() {
  stopBlur();
  try {
    const cfg = await api.getBlurConfig();
    if (!cfg.enabled) return;
    // Baja resolución y pocos fps: al ir difuminado no se nota y casi no consume.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: cfg.sourceId, maxWidth: 1280, maxHeight: 800, maxFrameRate: 20 } },
    });
    const v = $('backdrop');
    v.style.width = `${cfg.screenW}px`;
    v.style.height = `${cfg.screenH}px`;
    v.srcObject = stream;
    await v.play();
    blur.stream = stream; blur.cfg = cfg; blur.x = blur.y = null;
    $('island').classList.add('blur');
    stream.getVideoTracks()[0].onended = stopBlur;
  } catch (e) {
    console.error('Desenfoque no disponible:', e);
    stopBlur();
  }
}
// Mantiene el vídeo alineado con la pantalla mientras la isla cambia de tamaño.
function trackBlur() {
  if (blur.cfg) {
    const r = $('island').getBoundingClientRect();
    const x = -(blur.cfg.winX + r.left + 1), y = -(blur.cfg.winY + r.top + 1); // +1: borde de la isla
    if (x !== blur.x || y !== blur.y) {
      $('backdrop').style.transform = `translate(${x}px, ${y}px)`;
      blur.x = x; blur.y = y;
    }
  }
  requestAnimationFrame(trackBlur);
}

// ---------- Demo (sin Electron) ----------
const demo = {
  tracks: [
    { title: 'Luz de Medianoche', artist: 'Los Cristales', duration: 214, hue: 268 },
    { title: 'Costa Naranja', artist: 'Marea Alta', duration: 187, hue: 22 },
    { title: 'Verde Neón', artist: 'Circuito', duration: 243, hue: 150 },
  ],
  i: 0,
  cover(hue) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 128, 128);
    g.addColorStop(0, `hsl(${hue} 85% 60%)`);
    g.addColorStop(1, `hsl(${(hue + 50) % 360} 80% 30%)`);
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    x.fillStyle = 'rgba(255,255,255,.25)';
    x.beginPath(); x.arc(84, 46, 30, 0, 7); x.fill();
    return c.toDataURL();
  },
  load(playing = true) {
    const t = this.tracks[this.i];
    onMedia({ active: true, title: t.title, artist: t.artist, playing, position: 0, duration: t.duration, thumb: this.cover(t.hue), trackChanged: true });
  },
  mediaControl(a) {
    if (a === 'toggle') return;
    demo.i = (demo.i + (a === 'next' ? 1 : demo.tracks.length - 1)) % demo.tracks.length;
    demo.load(state.music.playing);
  },
  start() {
    document.body.classList.add('demo');
    this.load();
    onAudio({ volume: 42, muted: false, micMuted: false });
    onFavorites([{ name: 'Navegador' }, { name: 'Código' }, { name: 'Música' }]);
    onLibrary({ games: [{ id: 'a', name: 'Aventura', source: 'Steam' }, { id: 'b', name: 'Carreras', source: 'Epic Games' }], launchers: [{ id: 'c', name: 'Steam' }] });
    const steps = [
      { state: 'working', detail: 'Pensando…' }, { state: 'working', detail: 'Read' }, { state: 'working', detail: 'Edit' },
      { state: 'working', detail: 'Bash' }, { state: 'done', detail: 'Terminó' }, { state: 'idle', detail: '' }, { state: 'idle', detail: '' },
    ];
    let n = 0;
    if (!location.search.includes('static')) setInterval(() => onClaude({ ...steps[n++ % steps.length], project: 'mi-proyecto', at: Date.now() }), 2500);
  },
};

if (api) {
  api.onMedia(onMedia);
  api.onClaude(onClaude);
  api.onBlurChanged(setupBlur);
  api.onSettings(applySettings);
  api.getSettings().then(applySettings);
  api.onAudio(onAudio);
  api.onUpdateReady((v) => { state.updateVersion = v; state.updateNoteUntil = Date.now() + 15000; render(); });
  api.getAudio().then(onAudio);
  api.onFavorites(onFavorites);
  api.getFavorites().then(onFavorites);
  api.onLibrary(onLibrary);
  api.onProjects(onProjects);
  api.getProjects().then(onProjects);
  api.getLibrary().then(onLibrary);
  api.onClaudeLink(onClaudeLink);
  api.getClaudeLink().then(onClaudeLink);
  api.onUsage((u) => { state.usage = u; render(); });
  api.getUsage().then((u) => { state.usage = u; render(); });
  setupBlur();
  trackBlur();
} else {
  demo.start();
}

setInterval(() => { timerTick(); calendarTick(); render(); }, 1000);
render();
