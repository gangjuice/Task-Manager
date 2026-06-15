const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const dataFilePath = path.join(app.getPath('documents'), '업무관리_데이터.json');
let mainWindow;
let widgetWindow = null; // 📌 위젯 창 변수 추가

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

// 📌 위젯 창 띄우기 기능
ipcMain.on('open-widget', () => {
    // 이미 위젯이 켜져있으면 앞으로 가져오기만 함
    if (widgetWindow) {
        widgetWindow.focus();
        return;
    }
    // 테두리 없는 투명한 위젯 창 생성
    widgetWindow = new BrowserWindow({
        width: 300,
        height: 380,
        frame: false,        // 창 테두리(X버튼 등) 없애기
        transparent: true,   // 배경 투명하게
        alwaysOnTop: true,   // 다른 창들보다 항상 위에 띄우기
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    widgetWindow.loadFile('widget.html');
    
    // 위젯이 닫히면 변수 초기화
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
