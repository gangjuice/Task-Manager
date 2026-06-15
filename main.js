});
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// 📌 사내 PC의 '내 문서' 폴더 안에 '업무관리_데이터.json' 이라는 이름으로 영구 저장됩니다.
const dataFilePath = path.join(app.getPath('documents'), '업무관리_데이터.json');

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1300,
        height: 900,
        webPreferences: {
            nodeIntegration: true,     // HTML에서 PC 폴더 접근 권한 부여
            contextIsolation: false
        }
    });
    
    // 상단 기본 메뉴바 숨기기 (더 깔끔한 프로그램 UI)
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

// 📌 HTML에서 'load-data'를 요청하면 파일에서 데이터를 읽어옵니다.
ipcMain.handle('load-data', () => {
    if (fs.existsSync(dataFilePath)) {
        return fs.readFileSync(dataFilePath, 'utf8');
    }
    return null; 
});

// 📌 HTML에서 'save-data'를 요청하면 파일에 즉시 덮어씁니다. (알림창 없음)
ipcMain.on('save-data', (event, data) => {
    fs.writeFileSync(dataFilePath, data);
});
