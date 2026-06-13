const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  installNativeSuppression: () => ipcRenderer.invoke('install-native-suppression')
});
