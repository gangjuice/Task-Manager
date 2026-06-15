const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// PC의 '내 문서' 폴더에 task_data.json 이라는 이름으로 데이터를 저장합니다.
const dataFilePath = path.join(app.getPath('documents'), 'task_data.json');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,    // HTML에서 PC 파일 시스템에 접근할 수 있게 허용
            contextIsolation: false
        }
    });
    // 메뉴바 숨기기 (더 깔끔한 프로그램처럼 보이게)
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

// 📌 HTML에서 '저장해!' 라고 신호를 보내면 파일에 덮어씁니다 (경고창 없음!)
ipcMain.on('save-data', (event, data) => {
    fs.writeFileSync(dataFilePath, data);
});

// 📌 HTML에서 '데이터 줘!' 라고 신호를 보내면 파일을 읽어서 보내줍니다.
ipcMain.handle('load-data', () => {
    if (fs.existsSync(dataFilePath)) {
        return fs.readFileSync(dataFilePath, 'utf8');
    }
    return null; // 처음 실행해서 파일이 없으면 빈 값 반환
});
