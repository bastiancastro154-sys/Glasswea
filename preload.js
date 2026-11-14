const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('islandAPI', {
  onMedia: (cb) => ipcRenderer.on('media', (_e, d) => cb(d)),
  onClaude: (cb) => ipcRenderer.on('claude', (_e, d) => cb(d)),
  mediaControl: (action) => ipcRenderer.send('media-control', action),
  getBlurConfig: () => ipcRenderer.invoke('blur-config'),
  onBlurChanged: (cb) => ipcRenderer.on('blur-changed', () => cb()),
  onAudio: (cb) => ipcRenderer.on('audio', (_e, d) => cb(d)),
  getAudio: () => ipcRenderer.invoke('audio-get'),
  audioCommand: (cmd, value) => ipcRenderer.send('audio-command', cmd, value),
  quickAction: (name) => ipcRenderer.send('quick-action', name),
  onFavorites: (cb) => ipcRenderer.on('favorites', (_e, list) => cb(list)),
  getFavorites: () => ipcRenderer.invoke('favorites-get'),
  addFavorite: (kind) => ipcRenderer.invoke('favorites-add', kind),
  removeFavorite: (index) => ipcRenderer.send('favorites-remove', index),
  openFavorite: (index) => ipcRenderer.send('favorite-open', index),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, v) => cb(v)),
  openSettings: () => ipcRenderer.send('open-settings'),
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (patch) => ipcRenderer.send('settings-set', patch),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
  setInteractive: (on) => ipcRenderer.send('set-interactive', on),
});
