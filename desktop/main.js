'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(1);
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) app.exit(2);
else launch();

function launch() {
  const origin = 'http://127.0.0.1:' + port;
  const data = path.resolve(process.env.MOBILETV_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'MobileTV', 'data'));
  const install = path.dirname(process.execPath);
  const root = app.isPackaged ? path.join(install, 'app') : path.join(__dirname, '..');
  const logs = path.join(data, 'logs');
  app.setName('MobileTV');
  app.setPath('userData', path.join(data, 'electron', String(port)));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const quit = args.includes('--quit');
  let show = !args.includes('--no-window');
  if (!app.requestSingleInstanceLock({ quit, show })) { app.exit(0); return; }
  if (quit) { app.exit(1); return; }

  let win, tray, receiver, ready = false, closing = false;
  const icon = nativeImage.createFromPath(path.join(root, 'desktop', 'icon.png'));

  function openWindow() {
    show = true;
    if (!ready || closing) return;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
      return;
    }
    win = new BrowserWindow({
      title: 'MobileTV', icon, width: 1280, height: 820, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const window = win;
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const restrictNavigation = (event, destination) => {
      if (destination.split('#')[0] !== origin + '/') event.preventDefault();
    };
    window.webContents.on('will-navigate', restrictNavigation);
    window.webContents.on('will-redirect', restrictNavigation);
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
      callback(contents === win?.webContents && contents.getURL().split('#')[0] === origin + '/' &&
        ['fullscreen', 'clipboard-sanitized-write'].includes(permission));
    });
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => { win = null; });
    window.loadURL(origin + '/').catch(error => { if (!closing && !window.isDestroyed()) fail(error); });
  }

  function fail(error) {
    if (closing) return;
    console.error(error);
    if (!args.includes('--self-test')) dialog.showErrorBox('MobileTV 启动失败', error.message);
    app.quit();
  }

  async function start() {
    fs.mkdirSync(logs, { recursive: true });
    const status = await fetch(origin + '/api/status', { redirect: 'error', signal: AbortSignal.timeout(1500) })
      .then(response => response.ok ? response.json() : null).catch(() => null);
    if (closing) return;
    if (!(status?.identity?.deviceName && status?.tvUrl && status?.state)) {
      const fd = fs.openSync(path.join(logs, 'receiver-' + Date.now() + '.log'), 'a');
      try {
        receiver = fork(path.join(root, 'desktop', 'receiver.js'), [], {
          execPath: app.isPackaged ? path.join(install, 'runtime', 'node.exe') : process.env.npm_node_execpath || 'node',
          cwd: root, execArgv: [], windowsHide: true, stdio: ['ignore', fd, fd, 'ipc'],
          env: { ...process.env, PORT: String(port), MOBILETV_DATA_DIR: data,
            PATH: app.isPackaged ? path.join(install, 'tools') + path.delimiter + process.env.PATH : process.env.PATH },
        });
      } finally { fs.closeSync(fd); }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('接收服务启动超时。运行日志位于 ' + logs)), 30000);
        receiver.once('message', message => { clearTimeout(timer); if (message === 'ready') resolve(); else reject(new Error('接收服务未就绪')); });
        receiver.once('error', error => { clearTimeout(timer); reject(error); });
        receiver.once('exit', () => {
          receiver = null;
          clearTimeout(timer);
          if (closing) { app.quit(); return; }
          const error = new Error('接收服务已退出。请查看 ' + logs);
          if (ready) fail(error); else reject(error);
        });
      });
    }
    if (closing) return;
    tray = new Tray(icon.resize({ width: 24, height: 24 }));
    tray.setToolTip('MobileTV · 接收服务已就绪');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开接收界面', click: openWindow },
      { label: '查看运行日志', click: () => shell.openPath(logs) },
      { type: 'separator' }, { label: '退出 MobileTV', click: () => app.quit() },
    ]));
    tray.on('double-click', openWindow);
    ready = true;
    if (show) openWindow();
  }

  app.on('second-instance', (_event, _argv, _cwd, request) => {
    if (request.quit) app.quit();
    else if (request.show) openWindow();
  });
  app.on('window-all-closed', () => { /* The tray keeps receiving casts. */ });
  app.on('before-quit', event => {
    closing = true;
    if (receiver) {
      event.preventDefault();
      if (receiver.connected) receiver.disconnect();
    }
  });
  app.whenReady().then(start).catch(fail);
}
