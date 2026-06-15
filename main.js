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
        title: "Task Manager", // 창 이름 고정
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');
    
    // 📌 메인 창(대시보드)을 완전히 닫으면 프로그램 자체가 종료되도록 설정
    mainWindow.on('closed', () => {
        app.quit();
    });
}

app.whenReady().then(createWindow);

ipcMain.on('open-widget', () => {
    // 📌 위젯이 열리면 메인 창을 숨깁니다!
    if (mainWindow) {
        mainWindow.hide();
    }

    if (widgetWindow) {
        widgetWindow.focus();
        return;
    }
    
    widgetWindow = new BrowserWindow({
        width: 300,
        height: 480,
        frame: false,        
        transparent: true,   
        alwaysOnTop: true,   // 기본값: 항상 위
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    widgetWindow.loadFile('widget.html');
    
    // 📌 위젯이 닫히면 숨겨뒀던 메인 창을 다시 띄웁니다!
    widgetWindow.on('closed', () => {
        widgetWindow = null;
        if (mainWindow) mainWindow.show();
    });
});

// 📌 메인 창으로 복귀하라는 신호 (위젯 창을 닫아버림 -> 위 코드가 실행되며 메인창 뜸)
ipcMain.on('show-main', () => {
    if (widgetWindow) widgetWindow.close();
});

// 📌 위젯 항상 위 켜기/끄기 설정
ipcMain.on('set-always-on-top', (event, isTop) => {
    if (widgetWindow) widgetWindow.setAlwaysOnTop(isTop);
});

ipcMain.handle('load-data', () => {
    if (fs.existsSync(dataFilePath)) return fs.readFileSync(dataFilePath, 'utf8');
    return null; 
});

ipcMain.on('save-data', (event, data) => {
    fs.writeFileSync(dataFilePath, data);
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
