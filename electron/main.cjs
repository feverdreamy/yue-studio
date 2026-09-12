const { app, BrowserWindow, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installSpellingMenu } = require('./spelling.cjs');
const { startLocalWriter } = require('./local-writer.cjs');
const applicationRoot = path.resolve(__dirname, '..');
const appHome = process.env.YUE_STUDIO_HOME || (app.isPackaged ? path.resolve(path.dirname(process.execPath), '..') : applicationRoot);
app.setPath('userData', path.join(appHome, 'data', 'desktop-profile'));
let studio, localWriter, mainWindow, quitting = false;
async function closeStudio() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.webContents.executeJavaScript('window.yueStudioFlushDraft?.()').catch(() => {});
  }
  try {await studio?.close();} finally {await localWriter?.close();}
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    try {
      localWriter = await startLocalWriter(appHome);
      const {createStudioServer} = await import(pathToFileURL(path.join(applicationRoot, 'server', 'index.mjs')).href);
      studio = await createStudioServer({appHome, staticRoot: path.join(applicationRoot, 'dist'), port: 0,
        managedOllama: localWriter && {url:localWriter.url, previousUrl:localWriter.previousUrl},
        secretStorage: {
          isAvailable: () => safeStorage.isEncryptionAvailable(),
          encrypt: value => safeStorage.encryptString(value).toString('base64'),
          decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
        },
      });
      mainWindow = new BrowserWindow({
        width: 1480, height: 1000, minWidth: 960, minHeight: 680,
        title: 'YuE Studio', backgroundColor: '#ece8df', autoHideMenuBar: true,
        icon: path.join(applicationRoot, 'assets', 'icon.png'),
        show: false, webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: false},
      });
      mainWindow.setMenu(null);
      installSpellingMenu(mainWindow);
      mainWindow.webContents.setWindowOpenHandler(({url}) => { if (/^https:\/\/(github\.com|huggingface\.co|creativecommons\.org)\//.test(url)) void shell.openExternal(url); return {action: 'deny'}; });
      mainWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(studio.url + '/')) event.preventDefault(); });
      const mayWriteClipboard = (contents, permission, requestingUrl, details = {}) => {
        if (contents !== mainWindow.webContents || permission !== 'clipboard-sanitized-write' || details.isMainFrame === false) return false;
        try { return new URL(requestingUrl || contents.getURL()).origin === studio.url; } catch { return false; }
      };
      mainWindow.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) => mayWriteClipboard(contents, permission, origin, details));
      mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(mayWriteClipboard(contents, permission, details.requestingUrl, details)));
      mainWindow.webContents.session.on('will-download', (_event, item) => {
        item.setSaveDialogOptions({title: 'Export from YuE Studio', defaultPath: path.join(appHome, 'exports', item.getFilename())});
      });
      mainWindow.once('ready-to-show', () => {
        if (process.env.YUE_STUDIO_START_MINIMIZED === '1') {
          mainWindow.showInactive();
          mainWindow.minimize();
        } else mainWindow.show();
      });
      await mainWindow.loadURL(studio.url);
      mainWindow.on('close', event => {
        if (quitting) return;
        event.preventDefault(); quitting = true;
        void closeStudio().finally(() => { mainWindow.destroy(); app.quit(); });
      });
    } catch (error) {
      quitting = true;
      await closeStudio();
      dialog.showErrorBox('YuE Studio could not start', `${error.message}\n\nKeep the desktop, models, and runtime folders together inside YuE Studio.`);
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => { if (!quitting && studio) { event.preventDefault(); quitting = true; void closeStudio().finally(() => app.quit()); } });
}
