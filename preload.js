const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  installNativeSuppression: () => ipcRenderer.invoke('install-native-suppression'),
  // Screen/window share picker
  onPickSource: (cb) => ipcRenderer.on('pick-source', (_e, sources) => cb(sources)),
  pickSourceResult: (id) => ipcRenderer.send('pick-source-result', id)
});
