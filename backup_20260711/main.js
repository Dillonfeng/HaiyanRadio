const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: '复古网络收音机',
    frame: false,
    transparent: false,
    webPreferences: {
      webSecurity: false,
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  ipcMain.on('window-action', (event, action) => {
    switch (action) {
      case 'minimize':
        mainWindow.minimize();
        break;
      case 'maximize':
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
        break;
      case 'close':
        app.quit();
        break;
    }
  });
}

ipcMain.on('app-action', (event, action) => {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow) return;
  
  switch (action) {
    case 'quit':
      app.quit();
      break;
    case 'reload':
      mainWindow.reload();
      break;
    case 'devtools':
      mainWindow.webContents.openDevTools();
      break;
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
