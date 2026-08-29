const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, screen, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

// 📌 개발 실행과 설치본이 같은 데이터 폴더를 쓰도록 앱 이름을 고정한다.
// 이걸 안 하면 개발 중에는 ...\\Roaming\\Electron, 설치본은 ...\\Roaming\\Task Manager 를 써서
// 데이터가 사라진 것처럼 보인다. getPath('userData') 보다 먼저 불러야 한다.
app.setName('Task Manager');
// 📌 윈도우 알림에 뜨는 앱 이름. 이걸 안 정하면 개발 중에는 'Electron' 으로 뜬다.
app.setAppUserModelId('com.mycompany.taskmanager');

// 📌 예전에는 '내 문서'에 저장했는데, 윈도우 폴더 보호가 켜져 있으면 내 문서 자체가
// OneDrive 로 리디렉션된다. 저장할 때마다 동기화가 걸려 파일이 잠기고, rename 이 실패해
// 직접 쓰기로 물러나는 일이 생긴다. 프로그램 데이터의 표준 위치로 옮긴다.
const dataDir = app.getPath('userData');
const dataFilePath = process.env.TM_DATA_FILE || path.join(dataDir, '업무관리_데이터.json');
const legacyDataPath = path.join(app.getPath('documents'), '업무관리_데이터.json');
let migratedFrom = null;
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
        { label: '빠른 등록', click: openQuickAdd },
        { label: '메모 위젯', click: openWidget },
        { type: 'separator' },
        { label: '완전 종료', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', showMainWindow);
}

// 창을 닫았는데 앱이 안 꺼지면 사용자는 당황한다. 딱 한 번만 알려준다.
async function notifyTrayOnce() {
    const shown = await withDoc(doc => {
        const settings = doc.settings || {};
        if (settings.trayNoticeShown) return true;
        settings.trayNoticeShown = true;
        doc.settings = settings;
        return false;
    });
    if (shown) return;

    try {
        tray.displayBalloon({
            icon: nativeImage.createFromPath(iconPath),
            title: 'Task Manager는 계속 실행 중입니다',
            content: '창을 닫아도 트레이에 남아 있습니다. 완전히 끄려면 트레이의 로켓 아이콘을 우클릭하세요.'
        });
    } catch (e) {}
}

// 예전 위치(내 문서 = OneDrive)에 있던 파일을 새 위치로 한 번만 옮긴다.
// 원본은 지우지 않는다. 옮기다 잘못돼도 되돌릴 수 있어야 한다.
async function migrateLegacyData() {
    if (process.env.TM_DATA_FILE) return;   // 테스트용 경로는 건드리지 않는다
    try { await fs.promises.access(dataFilePath); return; } catch (e) {}   // 이미 새 위치에 있음
    try {
        const raw = await fs.promises.readFile(legacyDataPath, 'utf8');
        await fs.promises.mkdir(dataDir, { recursive: true });
        await fs.promises.writeFile(dataFilePath, raw);
        migratedFrom = legacyDataPath;
        console.log('데이터를 새 위치로 옮겼습니다:', legacyDataPath, '→', dataFilePath);
    } catch (e) { /* 예전 파일이 없으면 그냥 새로 시작한다 */ }
}

// 📌 모든 데이터가 파일 하나에 들어 있다. 깨지거나 실수로 지우면 전부 날아간다.
// 하루 한 번 복사본을 만들고 최근 7개만 남긴다.
async function makeDailyBackup() {
    if (process.env.TM_DATA_FILE) return;   // 테스트용 경로는 건드리지 않는다
    let raw;
    try { raw = await fs.promises.readFile(dataFilePath, 'utf8'); }
    catch (e) { return; }                    // 아직 데이터가 없으면 백업할 것도 없다

    const dir = path.join(dataDir, 'backups');
    const p2 = n => String(n).padStart(2, '0');
    const d = new Date();
    const today = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    const file = path.join(dir, '업무관리_데이터-' + today + '.json');

    try {
        await fs.promises.mkdir(dir, { recursive: true });
        try { await fs.promises.access(file); return; } catch (e) {}   // 오늘 것이 이미 있다
        await fs.promises.writeFile(file, raw);

        const files = (await fs.promises.readdir(dir))
            .filter(f => f.startsWith('업무관리_데이터-') && f.endsWith('.json'))
            .sort();
        for (const old of files.slice(0, Math.max(0, files.length - 7))) {
            await fs.promises.unlink(path.join(dir, old)).catch(() => {});
        }
    } catch (e) { /* 백업은 실패해도 앱은 계속 떠야 한다 */ }
}

// 'YYYY-MM-DD' 를 로컬 자정으로. UTC 로 해석되면 하루가 밀린다.
function localDate(str) {
    if (!str) return null;
    const [y, m, d] = String(str).split('T')[0].split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
}

// 📌 D-day 는 TO DO 탭을 열어야 보인다. 앱을 켤 때 한 번 알려준다.
// 기한이 지난 건은 세지 않는다 — 이미 아는 일이라 알림으로 또 보면 피로해진다.
async function notifyDeadlines() {
    if (!tray) return;
    const doc = await readDoc();
    const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = (today.getDay() + 6) % 7;      // 월=0 … 일=6
    const weekEnd = new Date(today);
    weekEnd.setDate(today.getDate() + (6 - dow));   // 이번 주 일요일

    let todayCount = 0, weekCount = 0;
    tasks.forEach(t => {
        if (t.status === '완료됨') return;
        const d = localDate(t.dueDate);
        if (!d) return;
        if (d.getTime() === today.getTime()) todayCount++;
        else if (d > today && d <= weekEnd) weekCount++;
    });

    if (!todayCount && !weekCount) return;
    const parts = [];
    if (todayCount) parts.push('오늘 마감 ' + todayCount + '건');
    if (weekCount) parts.push('이번 주 마감 ' + weekCount + '건');

    try {
        tray.displayBalloon({
            icon: nativeImage.createFromPath(iconPath),
            title: 'Task Manager',
            content: parts.join('  ·  ')
        });
    } catch (e) {}
}

app.whenReady().then(async () => {
    await fs.promises.mkdir(dataDir, { recursive: true }).catch(() => {});
    await migrateLegacyData();
    await makeDailyBackup();
    createWindow();
    createTray();
    applyHotkeyFromSettings();
    notifyDeadlines();
    startReminderTimer();
});

ipcMain.handle('get-data-path', () => ({ path: dataFilePath, migratedFrom: migratedFrom }));

ipcMain.on('open-data-folder', () => { shell.openPath(path.dirname(dataFilePath)); });

// ── 문서 보관함 ───────────────────────────────────────────────────
// 파일을 복사하지 않고 경로만 기억한다. 여는 것도 윈도우 기본 프로그램에 맡긴다.
ipcMain.handle('pick-files', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
        title: '보관함에 넣을 파일 고르기',
        properties: ['openFile', 'multiSelections']
    });
    return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('open-file', async (event, filePath) => {
    try { await fs.promises.access(filePath); }
    catch (e) { return { ok: false }; }
    const err = await shell.openPath(filePath);
    return { ok: !err };
});

// 원본이 옮겨졌는지 한 번에 확인한다. 눌렀을 때 알면 늦다.
ipcMain.handle('check-files', async (event, paths) => {
    return Promise.all((paths || []).map(async p => {
        try { await fs.promises.access(p); return false; } catch (e) { return true; }
    }));
});

ipcMain.on('show-in-folder', (event, filePath) => { shell.showItemInFolder(filePath); });


// 📌 창이 하나도 없어도 앱을 끝내지 않는다 (기본 동작은 종료).
// 트레이에 상주하는 것이 이 앱의 정상 상태다.
app.on('window-all-closed', () => {});

app.on('before-quit', () => { isQuitting = true; });

// 메모 위젯의 크기·위치를 기억한다. 스티키 메모는 놔둔 자리에 그대로 있어야 한다.
let widgetBoundsTimer = null;
function rememberWidgetBounds() {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    if (widgetBoundsTimer) clearTimeout(widgetBoundsTimer);
    const b = widgetWindow.getBounds();
    widgetBoundsTimer = setTimeout(() => { patchSettings({ memoWidget: b }); }, 400);
}

// 📌 getSettings 는 비동기다(파일을 읽는다). 동기처럼 쓰면 저장해 둔 크기·위치가
// 조용히 무시된다.
async function openWidget() {
    if (widgetWindow) {
        widgetWindow.show();
        widgetWindow.focus();
        return;
    }

    // 📌 메모 위젯은 메인 창과 같이 떠 있는다. 달력 위젯이던 시절에는 메인 창을
    // 숨겼는데, 스티키 메모는 다른 일을 하면서 옆에 두는 물건이라 숨기면 안 된다.
    const saved = (await getSettings()).memoWidget;
    const opts = {
        width: 320,
        height: 380,
        minWidth: 220,
        minHeight: 160,
        frame: false,
        transparent: false,
        resizable: true,
        alwaysOnTop: true,   // 기본값: 항상 위
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    };
    if (saved && typeof saved.x === 'number') {
        const fits = screen.getAllDisplays().some(d => {
            const a = d.workArea;
            return saved.x >= a.x - 40 && saved.y >= a.y - 40 &&
                   saved.x < a.x + a.width && saved.y < a.y + a.height;
        });
        if (fits) Object.assign(opts, { x: saved.x, y: saved.y, width: saved.width, height: saved.height });
    }

    widgetWindow = new BrowserWindow(opts);
    widgetWindow.setAlwaysOnTop(true, 'screen-saver');
    widgetWindow.loadFile('widget.html');
    widgetWindow.on('move', rememberWidgetBounds);
    widgetWindow.on('resize', rememberWidgetBounds);

    widgetWindow.on('closed', () => {
        widgetWindow = null;
        restoreMainOnWidgetClose = false;
    });
}

ipcMain.on('open-widget', openWidget);

// 📌 위젯의 '메인 창 복귀' 버튼. 명시적 요청이므로 숨어 있었더라도 띄운다.
// 메모 위젯의 🖥️ 버튼. 메모는 그대로 두고 업무 창만 띄운다.
ipcMain.on('show-main', () => {
    showMainWindow();
});

// 📌 위젯 항상 위 켜기/끄기 설정
ipcMain.on('set-always-on-top', (event, isTop) => {
    if (widgetWindow) widgetWindow.setAlwaysOnTop(isTop);
});

// 📌 데이터 파일은 여러 창이 함께 쓴다.
// 각 창은 자기가 바꾼 섹션만 보내고(save-sections), 파일 병합은 여기 한 곳에서만 한다.
// 창이 문서 전체를 통째로 써내면, 그 창이 들고 있던 낡은 값이 남의 데이터를 덮어쓴다.
//
// 📌 읽기/쓰기는 전부 비동기(fs.promises)로 한다. Sync 버전을 쓰면 디스크가 느릴 때
// (OneDrive 동기화, 백신 검사 등) 메인 프로세스의 UI 스레드가 그대로 멈춰서,
// 그 순간 열려 있는 모든 창(메인·위젯·빠른 등록)의 키보드 입력이 간헐적으로 먹통이 된다.
// 대신 저장 요청은 큐에 순서대로 태워서, 여러 창이 거의 동시에 저장해도 서로 덮어쓰지 않게 한다.
async function readDoc() {
    let raw;
    try {
        raw = await fs.promises.readFile(dataFilePath, 'utf8');
    } catch (e) {
        return {};   // 파일이 아직 없으면 빈 문서로 시작한다.
    }
    try {
        const doc = JSON.parse(raw);
        return (doc && typeof doc === 'object') ? doc : {};
    } catch (e) {
        // 파일이 깨졌다면 덮어쓰기 전에 원본을 남긴다. 그냥 진행하면 전체 데이터가 사라진다.
        try { await fs.promises.writeFile(dataFilePath.replace(/\.json$/, '') + '.손상됨.json', raw); } catch (e2) {}
        return {};
    }
}

async function writeDoc(doc) {
    const json = JSON.stringify(doc, null, 2);
    const tmp = dataFilePath + '.tmp';
    try {
        // 임시 파일에 쓰고 바꿔치기한다. 쓰는 도중에 앱이 죽어도 원본이 남는다.
        await fs.promises.writeFile(tmp, json);
        await fs.promises.rename(tmp, dataFilePath);
    } catch (e) {
        // OneDrive 등이 파일을 잠그면 rename이 실패할 수 있다. 그때는 직접 쓴다.
        await fs.promises.writeFile(dataFilePath, json);
    }
}

// 📌 읽고-고치고-쓰는 한 사이클을 큐에 순서대로 태운다.
// mutator(doc) 안에서 doc을 고치고, 필요하면 반환값을 돌려준다.
let docQueue = Promise.resolve();
function withDoc(mutator) {
    const result = docQueue.then(async () => {
        const doc = await readDoc();
        const ret = await mutator(doc);
        await writeDoc(doc);
        return ret;
    });
    docQueue = result.then(() => {}, () => {});   // 하나 실패해도 큐는 계속 이어진다
    return result;
}

ipcMain.handle('load-data', () => readDoc());

// patch 예: { tasks: [...] } — 바뀐 섹션만 담긴 객체
ipcMain.on('save-sections', async (event, patch) => {
    if (!patch || typeof patch !== 'object') return;

    await withDoc(doc => {
        Object.keys(patch).forEach(section => { doc[section] = patch[section]; });
    });

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

// ══════════════════════════════════════════════════════════════════
// 빠른 등록 · 전역 단축키
// ══════════════════════════════════════════════════════════════════

const DEFAULT_HOTKEY = 'F4';

let quickAddWindow = null;

async function getSettings() {
    const doc = await readDoc();
    return doc.settings || {};
}

function patchSettings(patch) {
    return withDoc(doc => {
        doc.settings = Object.assign({}, doc.settings || {}, patch);
        return doc.settings;
    });
}

function openContactsTab() {
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('open-contacts-tab');
    }
}

// ── 빠른 등록 창 ──────────────────────────────────────────────────

function openQuickAdd() {
    if (quickAddWindow && !quickAddWindow.isDestroyed()) {
        quickAddWindow.show();
        quickAddWindow.focus();
        quickAddWindow.webContents.send('quick-add-reset');
        return;
    }

    const W = 470, H = 280;
    // 마우스가 있는 화면에 띄운다. 모니터가 2대라 주 모니터 고정이면
    // 두 번째 화면에서 일하다가 시선을 옮겨야 한다.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const b = display.workArea;
    const x = Math.round(b.x + (b.width - W) / 2);
    const y = Math.round(b.y + (b.height - H) / 2);

    quickAddWindow = new BrowserWindow({
        width: W, height: H, x: x, y: y,
        frame: false, transparent: true, resizable: false,
        alwaysOnTop: true, skipTaskbar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    quickAddWindow.setAlwaysOnTop(true, 'screen-saver');
    quickAddWindow.loadFile('quickadd.html');
    quickAddWindow.on('closed', () => { quickAddWindow = null; });
}

ipcMain.on('open-quick-add', openQuickAdd);

ipcMain.on('close-quick-add', () => {
    if (quickAddWindow && !quickAddWindow.isDestroyed()) quickAddWindow.close();
});

// 📌 빠른 등록 창은 자기 사본을 통째로 저장하지 않는다.
// 항상 디스크의 최신 목록에 덧붙이고 결과를 돌려준다. 그래야 이 창이 떠 있는
// 동안 메인 창에서 추가한 것이 사라지지 않는다.
function broadcastSection(section, value, exceptId) {
    const patch = {};
    patch[section] = value;
    BrowserWindow.getAllWindows().forEach(win => {
        if (win.webContents.id !== exceptId) {
            win.webContents.send('sync-sections', patch);
        }
    });
}

function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

ipcMain.handle('add-contact', async (event, { name, phone, memo, customerNo }) => {
    const at = stamp();
    const digits = String(phone || '').replace(/[^0-9]/g, '');

    const list = await withDoc(doc => {
        const list = Array.isArray(doc.contacts) ? doc.contacts : [];
        list.push({
            id: Date.now(),
            name: name || '', title: '', org: '', email: '', customerNo: customerNo || '', tag: '',
            phones: digits ? [{ label: digits.startsWith('01') ? '휴대폰' : '사무실', value: digits }] : [],
            projects: [],
            notes: memo ? [{ at: at, text: memo }] : [],
            createdAt: at.split('T')[0],
            updatedAt: at,
            lastNoteAt: memo ? at.split('T')[0] : ''
        });
        doc.contacts = list;
        return list;
    });

    broadcastSection('contacts', list, event.sender.id);
    return { ok: true, contacts: list };
});

ipcMain.handle('add-note', async (event, { id, text }) => {
    const at = stamp();

    const result = await withDoc(doc => {
        const list = Array.isArray(doc.contacts) ? doc.contacts : [];
        const c = list.find(x => x.id === id);
        if (!c) return { ok: false };

        c.notes = c.notes || [];
        c.notes.push({ at: at, text: text });
        c.lastNoteAt = at.split('T')[0];
        c.updatedAt = at;

        doc.contacts = list;
        return { ok: true, contacts: list };
    });

    if (result.ok) broadcastSection('contacts', result.contacts, event.sender.id);
    return result;
});

// 업무도 같은 방식으로 덧붙인다.
ipcMain.handle('add-task', async (event, { content, dueDate }) => {
    const at = stamp();

    const tasks = await withDoc(doc => {
        const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
        const categories = (Array.isArray(doc.categories) && doc.categories.length)
            ? doc.categories : ['기타'];

        tasks.push({
            id: Date.now(),
            regDate: at.split('T')[0],
            dueDate: dueDate || '',
            content: content || '',
            // 메인 창의 신규 등록 폼과 같은 기본값. 나중에 투두리스트에서 고치면 된다.
            category: categories.includes('기타') ? '기타' : categories[0],
            firstAction: '',
            importance: '높음',
            urgency: '높음',
            priority: 1,
            timeReq: '',
            status: '대기중',
            remarks: ''
        });
        doc.tasks = tasks;
        return tasks;
    });

    broadcastSection('tasks', tasks, event.sender.id);
    return { ok: true, count: tasks.length };
});

// ── 전역 단축키 ───────────────────────────────────────────────────

// 📌 전역 단축키는 윈도우 전체에서 그 키를 가로챈다.
// 기본값 F4 는 엑셀의 절대참조를 내주는 대신 한 번만 누르면 되는 속도를 얻는 선택이다.
// 등록에 실패하면 반드시 알린다. 조용히 안 먹는 상태가 제일 나쁘다.
function applyHotkey(accel) {
    globalShortcut.unregisterAll();
    if (!accel) return { ok: true, accel: '' };
    try {
        const ok = globalShortcut.register(accel, openQuickAdd);
        return { ok: !!ok, accel: accel };
    } catch (e) {
        return { ok: false, accel: accel, error: e.message };
    }
}

async function applyHotkeyFromSettings() {
    const s = await getSettings();
    const accel = s.hotkey === undefined ? DEFAULT_HOTKEY : s.hotkey;
    const res = applyHotkey(accel);
    if (!res.ok && accel && tray) {
        try {
            tray.displayBalloon({
                icon: nativeImage.createFromPath(iconPath),
                title: '단축키를 등록하지 못했습니다',
                content: '‘' + accel + '’ 은(는) 다른 프로그램이 쓰고 있습니다. 설정에서 다른 키로 바꿔주세요.'
            });
        } catch (e) {}
    }
    return res;
}

ipcMain.handle('get-hotkey', async () => {
    const s = await getSettings();
    return { accel: s.hotkey === undefined ? DEFAULT_HOTKEY : s.hotkey };
});

ipcMain.handle('set-hotkey', async (event, accel) => {
    const res = applyHotkey(accel);
    if (res.ok) await patchSettings({ hotkey: accel });
    else await applyHotkeyFromSettings();   // 실패하면 원래 키로 되돌린다
    return res;
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });

// ══════════════════════════════════════════════════════════════════
// 리마인더 — 일정에 시각이 있으면 그때 알린다
// ══════════════════════════════════════════════════════════════════

let reminderWindow = null;
const snoozed = new Map();   // id → 다시 알릴 시각(ms). 앱을 끄면 사라진다.

function nowStamp2() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function todayStr2() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 알림 창은 화면 한가운데. 포커스를 가져간다 — 놓치면 안 되는 약속이라서.
function showReminder(ev, late) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const b = display.workArea;
    const W = 420, H = ev.memo ? 260 : 200;

    if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.close();

    reminderWindow = new BrowserWindow({
        width: W, height: H,
        x: Math.round(b.x + (b.width - W) / 2),
        y: Math.round(b.y + (b.height - H) / 2),
        frame: false, transparent: true, resizable: false, movable: true,
        alwaysOnTop: true, skipTaskbar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    reminderWindow.setAlwaysOnTop(true, 'screen-saver');
    reminderWindow.loadFile('reminder.html');
    reminderWindow.once('ready-to-show', () => {
        reminderWindow.show();
        reminderWindow.focus();
        reminderWindow.webContents.send('reminder', {
            id: ev.id, title: ev.title, memo: ev.memo, date: ev.date, time: ev.time, late: !!late
        });
    });
    reminderWindow.on('closed', () => { reminderWindow = null; });

    if (tray) {
        try {
            tray.displayBalloon({
                icon: nativeImage.createFromPath(iconPath),
                title: '🔔 ' + (ev.time || '') + ' 알림',
                content: ev.title || ''
            });
        } catch (e) {}
    }
}

// 알린 것은 파일에 표시해 둔다. 앱을 껐다 켜도 같은 알림이 다시 뜨지 않는다.
async function markNotified(id) {
    await withDoc(doc => {
        const list = Array.isArray(doc.events) ? doc.events : [];
        const ev = list.find(x => x.id === id);
        if (ev) ev.notifiedAt = nowStamp2();
    });
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('reminder-updated');
    });
}

ipcMain.on('reminder-done', async (event, id) => {
    if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.close();
    if (id) await markNotified(id);
});

ipcMain.on('reminder-snooze', (event, id) => {
    if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.close();
    if (id) snoozed.set(id, Date.now() + 10 * 60 * 1000);
});

// 1분마다 확인한다. 초 단위로 볼 이유가 없다.
async function checkReminders() {
    const doc = await readDoc();
    const list = Array.isArray(doc.events) ? doc.events : [];
    const today = todayStr2();
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    for (const ev of list) {
        if (!ev.time || !ev.remind || ev.notifiedAt) continue;   // 알림을 걸어 둔 것만

        const snoozeUntil = snoozed.get(ev.id);
        if (snoozeUntil) {
            if (Date.now() < snoozeUntil) continue;
            snoozed.delete(ev.id);
            showReminder(ev, false);
            return;                      // 한 번에 하나만 띄운다
        }

        if (ev.date !== today) continue;
        const [h, m] = String(ev.time).split(':').map(Number);
        if (isNaN(h) || isNaN(m)) continue;
        if (h * 60 + m > nowMin) continue;   // 아직 시각 전

        // 지난 시각인데 아직 안 알린 것 = 앱이 꺼져 있던 동안 지나간 알림
        showReminder(ev, h * 60 + m < nowMin - 1);
        return;
    }
}

function startReminderTimer() {
    checkReminders();
    setInterval(checkReminders, 60 * 1000);
}

// 빠른 등록 창에서 리마인더(시각이 있는 일정)를 넣는다.
ipcMain.handle('add-event', async (event, { title, date, time, memo, remind }) => {
    const stampNow = nowStamp2();
    const list = await withDoc(doc => {
        const events = Array.isArray(doc.events) ? doc.events : [];
        events.push({
            id: Date.now(),
            title: title || '',
            date: date || todayStr2(),
            time: time || '',
            remind: !!remind,
            memo: memo || '',
            createdAt: stampNow.split('T')[0],
            updatedAt: stampNow
        });
        doc.events = events;
        return events;
    });
    BrowserWindow.getAllWindows().forEach(win => {
        if (win.webContents.id !== event.sender.id) {
            win.webContents.send('sync-sections', { events: list });
        }
    });
    return { ok: true, count: list.length };
});

