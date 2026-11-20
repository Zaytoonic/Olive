// Exposes narrow bridges to the main process (Windows mic volume/mute, hotkeys, soundboard files...). Nothing else from Node reaches the page.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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

// Soundboard: add sounds (a file dialog, or files dropped on the window), read Olive's copies back, remove them.
contextBridge.exposeInMainWorld('appBoard', {
  pick: () => ipcRenderer.invoke('board:pick'),
  pathOf: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },   // one File at a time: a FileList doesn't cross the bridge
  importPaths: paths => ipcRenderer.invoke('board:import', Array.isArray(paths) ? paths.map(String) : []),
  read: file => ipcRenderer.invoke('board:read', String(file)),
  remove: file => ipcRenderer.invoke('board:remove', String(file)),
  setKeys: list => ipcRenderer.invoke('board:keys', Array.isArray(list) ? list.map(p => [String(p[0]), String(p[1])]) : []),
  onKey: cb => { ipcRenderer.on('board:key', (event, id) => cb(String(id))); }
});
