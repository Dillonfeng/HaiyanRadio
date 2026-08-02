const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  quit: () => ipcRenderer.send('app-action', 'quit'),
  reload: () => ipcRenderer.send('app-action', 'reload'),
  openDevTools: () => ipcRenderer.send('app-action', 'devtools'),
  minimizeWindow: () => ipcRenderer.send('window-action', 'minimize'),
  maximizeWindow: () => ipcRenderer.send('window-action', 'maximize'),
  closeWindow: () => ipcRenderer.send('window-action', 'close'),
  getSchedulerStatus: () => ipcRenderer.invoke('scheduler-status'),
  runSchedulerNow: () => ipcRenderer.invoke('scheduler-run-now'),
  startScheduler: () => ipcRenderer.invoke('scheduler-start'),
  stopScheduler: () => ipcRenderer.invoke('scheduler-stop'),
  fetchLogo: (name, url) => ipcRenderer.invoke('fetch-logo', name, url)
});
