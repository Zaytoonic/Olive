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
  setTheme: name => ipcRenderer.invoke('app:theme', name === 'classic' ? 'classic' : 'glass'),
  onThemeChosen: cb => { ipcRenderer.on('app:theme-chosen', (event, name) => cb(name === 'classic' ? 'classic' : 'glass')); }
});

contextBridge.exposeInMainWorld('appStartup', {
  get: () => ipcRenderer.invoke('startup:get'),
  set: on => ipcRenderer.invoke('startup:set', on === true)
});
