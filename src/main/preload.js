// Exposes a narrow bridge for Windows microphone volume/mute. Nothing else from Node reaches the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sysMic', {
  list: () => ipcRenderer.invoke('sysmic', 'list'),
  get: id => ipcRenderer.invoke('sysmic', 'get', String(id)),
  setVolume: (id, level) => ipcRenderer.invoke('sysmic', 'setvol', String(id), String(level)),
  setMute: (id, muted) => ipcRenderer.invoke('sysmic', 'setmute', String(id), muted ? '1' : '0')
});

contextBridge.exposeInMainWorld('appWindow', {
  onVisibility: cb => { ipcRenderer.on('window:visible', (event, visible) => cb(visible === true)); }
});

contextBridge.exposeInMainWorld('appMute', {
  onToggle: cb => { ipcRenderer.on('mute:toggle', () => cb()); },
  onMicKey: cb => { ipcRenderer.on('mute:mic-key', () => cb()); },
  setState: on => ipcRenderer.invoke('mute:state', on === true),
  setHotkey: accelerator => ipcRenderer.invoke('mute:hotkey', typeof accelerator === 'string' ? accelerator : null)
});

contextBridge.exposeInMainWorld('appInfo', {
  version: () => ipcRenderer.invoke('app:version'),
  notices: () => ipcRenderer.invoke('app:notices'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateProgress: cb => { ipcRenderer.on('update:progress', (event, p) => cb(Number(p))); },
  updateResult: () => ipcRenderer.invoke('update:result'),
  open: name => ipcRenderer.invoke('app:open', String(name))
});

contextBridge.exposeInMainWorld('appBadge', {
  set: (on, corner, preview) => ipcRenderer.invoke('badge:set', on === true, String(corner), preview === true)
});

contextBridge.exposeInMainWorld('appPtt', {
  set: vk => ipcRenderer.invoke('ptt:set', vk),
  onKey: cb => { ipcRenderer.on('ptt:key', (event, down) => cb(down === true)); }
});

contextBridge.exposeInMainWorld('appStartup', {
  get: () => ipcRenderer.invoke('startup:get'),
  set: on => ipcRenderer.invoke('startup:set', on === true)
});
