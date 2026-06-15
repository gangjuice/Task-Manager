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
        height: 600,
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
    fs.writeFileSync(dataFilePath, data);
});

// 📌 [신규 추가] 부팅 시 자동 실행 상태 확인하기
ipcMain.handle('get-autostart', () => {
    return app.getLoginItemSettings().openAtLogin;
});

// 📌 [신규 추가] 부팅 시 자동 실행 켜기/끄기 설정
ipcMain.on('set-autostart', (event, enable) => {
    app.setLoginItemSettings({
        openAtLogin: enable,
        path: app.getPath('exe') // 사내 PC에 설치된 이 프로그램의 경로를 자동으로 등록
    });
});
