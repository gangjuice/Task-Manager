const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const dataFilePath = path.join(app.getPath('documents'), '업무관리_데이터.json');
let mainWindow;
let widgetWindow = null; 

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 900,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

ipcMain.on('open-widget', () => {
    if (widgetWindow) {
        widgetWindow.focus();
        return;
    }
    widgetWindow = new BrowserWindow({
        width: 300,
        height: 480,
        frame: false,        
        transparent: true,   
        alwaysOnTop: true,   
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    widgetWindow.loadFile('widget.html');
    
    widgetWindow.on('closed', () => {
        widgetWindow = null;
    });
});

ipcMain.handle('load-data', () => {
    if (fs.existsSync(dataFilePath)) {
        return fs.readFileSync(dataFilePath, 'utf8');
    }
    return null; 
});

ipcMain.on('save-data', (event, data) => {
    // 1. 파일에 즉시 덮어쓰기
    fs.writeFileSync(dataFilePath, data);
    
    // 2. 📌 열려있는 모든 창(메인화면, 위젯)에 데이터가 변경되었다고 실시간 알림!
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('sync-data', data);
    });
});

ipcMain.handle('get-autostart', () => {
    return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on('set-autostart', (event, enable) => {
    app.setLoginItemSettings({
        openAtLogin: enable,
        path: app.getPath('exe') 
    });
});
