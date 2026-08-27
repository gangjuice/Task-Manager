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

// 📌 데이터 파일은 여러 창이 함께 쓴다.
// 각 창은 자기가 바꾼 섹션만 보내고(save-sections), 파일 병합은 여기 한 곳에서만 한다.
// 창이 문서 전체를 통째로 써내면, 그 창이 들고 있던 낡은 값이 남의 데이터를 덮어쓴다.
function readDoc() {
    if (!fs.existsSync(dataFilePath)) return {};
    const raw = fs.readFileSync(dataFilePath, 'utf8');
    try {
        const doc = JSON.parse(raw);
        return (doc && typeof doc === 'object') ? doc : {};
    } catch (e) {
        // 파일이 깨졌다면 덮어쓰기 전에 원본을 남긴다. 그냥 진행하면 전체 데이터가 사라진다.
        try { fs.writeFileSync(dataFilePath.replace(/\.json$/, '') + '.손상됨.json', raw); } catch (e2) {}
        return {};
    }
}

function writeDoc(doc) {
    const json = JSON.stringify(doc, null, 2);
    const tmp = dataFilePath + '.tmp';
    try {
        // 임시 파일에 쓰고 바꿔치기한다. 쓰는 도중에 앱이 죽어도 원본이 남는다.
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, dataFilePath);
    } catch (e) {
        // OneDrive 등이 파일을 잠그면 rename이 실패할 수 있다. 그때는 직접 쓴다.
        fs.writeFileSync(dataFilePath, json);
    }
}

ipcMain.handle('load-data', () => readDoc());

// patch 예: { tasks: [...] } — 바뀐 섹션만 담긴 객체
ipcMain.on('save-sections', (event, patch) => {
    if (!patch || typeof patch !== 'object') return;

    const doc = readDoc();
    Object.keys(patch).forEach(section => { doc[section] = patch[section]; });
    writeDoc(doc);

    // 📌 저장을 요청한 창은 이미 최신 상태이므로 제외한다.
    // (자기 자신에게 되돌아온 신호 때문에 저장할 때마다 화면이 한 번 더 그려지던 문제)
    BrowserWindow.getAllWindows().forEach(win => {
        if (win.webContents.id !== event.sender.id) {
            win.webContents.send('sync-sections', patch);
        }
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
