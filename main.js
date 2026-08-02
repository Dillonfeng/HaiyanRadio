const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const logoScheduler = require('./logoScheduler');

const MOBILE_PORT = 8080;

function startMobileServer() {
  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];

    if (pathname === '/api/fetch-logo') {
      const params = new URLSearchParams(req.url.split('?')[1]);
      const name = params.get('name');
      const url = params.get('url') || '';
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      
      logoScheduler.fetchSingleLogo(name, url).then(result => {
        res.end(JSON.stringify(result));
      }).catch(err => {
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
      return;
    }

    if (pathname === '/api/batch-fetch') {
      const params = new URLSearchParams(req.url.split('?')[1]);
      const batchSize = parseInt(params.get('size')) || 50;
      const delay = parseFloat(params.get('delay')) || 10;
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      
      logoScheduler.runBatch(batchSize, delay).then(result => {
        res.end(JSON.stringify(result));
      }).catch(err => {
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
      return;
    }

    let filePath;
    if (pathname === '/') {
      filePath = path.join(__dirname, 'mobile', 'www', 'index.html');
    } else {
      filePath = path.join(__dirname, 'mobile', 'www', pathname.replace(/^\//, ''));
    }

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
      case '.js':
        contentType = 'text/javascript';
        break;
      case '.css':
        contentType = 'text/css';
        break;
      case '.json':
        contentType = 'application/json';
        break;
      case '.png':
        contentType = 'image/png';
        break;
      case '.jpg':
        contentType = 'image/jpeg';
        break;
      case '.gif':
        contentType = 'image/gif';
        break;
      case '.svg':
        contentType = 'image/svg+xml';
        break;
    }

    fs.readFile(filePath, (error, content) => {
      if (error) {
        if (error.code === 'ENOENT') {
          res.writeHead(404);
          res.end('File not found');
        } else {
          res.writeHead(500);
          res.end('Server Error: ' + error.code);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
  });

  server.listen(MOBILE_PORT, '0.0.0.0', (err) => {
    if (err) {
      console.error(`服务器启动失败: ${err.message}`);
      return;
    }
    console.log(`Mobile server running on http://0.0.0.0:${MOBILE_PORT}`);
    console.log(`访问地址: http://localhost:${MOBILE_PORT}`);
  });

  server.on('error', (err) => {
    console.error(`服务器错误: ${err.message}`);
  });
}

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

ipcMain.handle('scheduler-status', async () => {
  return logoScheduler.getStatus();
});

ipcMain.handle('scheduler-run-now', async () => {
  try {
    await logoScheduler.runNow();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('scheduler-start', async () => {
  logoScheduler.startScheduler();
  return logoScheduler.getStatus();
});

ipcMain.handle('scheduler-stop', async () => {
  logoScheduler.stopScheduler();
  return logoScheduler.getStatus();
});

ipcMain.handle('fetch-logo', async (event, name, url) => {
  return logoScheduler.fetchSingleLogo(name, url);
});

app.whenReady().then(() => {
  createWindow();
  startMobileServer();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
