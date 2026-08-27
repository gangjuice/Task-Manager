const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const dataFilePath = path.join(app.getPath('documents'), '업무관리_데이터.json');
const iconPath = path.join(__dirname, 'assets', 'rocket.png');

let mainWindow;
let widgetWindow = null;
let tray = null;

// 트레이 메뉴의 '완전 종료'로만 true가 된다.
// 이 값이 false인 동안에는 창을 닫아도 숨기기만 한다.
let isQuitting = false;

// 위젯을 열 때 메인 창이 보이는 상태였는지. 위젯을 닫을 때 되돌릴지 판단한다.
let restoreMainOnWidgetClose = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 900,
        title: "Task Manager", // 창 이름 고정
        icon: iconPath,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');

    // 📌 창을 닫아도 앱은 트레이에 남는다.
    // 전화 아이콘처럼 상주해야 하는 것들이 메인 창과 함께 죽으면 안 되기 때문이다.
    // 완전 종료는 트레이 메뉴에서만 한다.
    mainWindow.on('close', (e) => {
        if (isQuitting) return;
        e.preventDefault();
        mainWindow.hide();
        notifyTrayOnce();
    });
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function createTray() {
    const image = nativeImage.createFromPath(iconPath);
    // 윈도우 트레이는 16px 기준이다. 256px 원본을 그대로 넘기면 뭉개진다.
    tray = new Tray(image.isEmpty() ? image : image.resize({ width: 16, height: 16 }));
    tray.setToolTip('Task Manager');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: '업무 창 열기', click: showMainWindow },
        { label: '달력 위젯 띄우기', click: openWidget },
        { type: 'separator' },
        { label: '완전 종료', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', showMainWindow);
}

// 창을 닫았는데 앱이 안 꺼지면 사용자는 당황한다. 딱 한 번만 알려준다.
function notifyTrayOnce() {
    const doc = readDoc();
    const settings = doc.settings || {};
    if (settings.trayNoticeShown) return;

    settings.trayNoticeShown = true;
    doc.settings = settings;
    writeDoc(doc);

    try {
        tray.displayBalloon({
            icon: nativeImage.createFromPath(iconPath),
            title: 'Task Manager는 계속 실행 중입니다',
            content: '창을 닫아도 트레이에 남아 있습니다. 완전히 끄려면 트레이의 로켓 아이콘을 우클릭하세요.'
        });
    } catch (e) {}
}

app.whenReady().then(() => {
    createWindow();
    createTray();
});

// 📌 창이 하나도 없어도 앱을 끝내지 않는다 (기본 동작은 종료).
// 트레이에 상주하는 것이 이 앱의 정상 상태다.
app.on('window-all-closed', () => {});

app.on('before-quit', () => { isQuitting = true; });

function openWidget() {
    if (widgetWindow) {
        widgetWindow.focus();
        return;
    }

    // 📌 위젯이 열리면 메인 창을 숨긴다.
    // 단, 원래 숨어 있었다면(트레이에서 위젯만 띄운 경우) 나중에 되살리지 않는다.
    restoreMainOnWidgetClose = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
    if (restoreMainOnWidgetClose) mainWindow.hide();
    
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

    // 📌 위젯을 열 때 숨겼던 경우에만 메인 창을 되돌린다.
    widgetWindow.on('closed', () => {
        widgetWindow = null;
        if (restoreMainOnWidgetClose) showMainWindow();
        restoreMainOnWidgetClose = false;
    });
}

ipcMain.on('open-widget', openWidget);

// 📌 위젯의 '메인 창 복귀' 버튼. 명시적 요청이므로 숨어 있었더라도 띄운다.
ipcMain.on('show-main', () => {
    restoreMainOnWidgetClose = true;
    if (widgetWindow) widgetWindow.close();
    else showMainWindow();
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
