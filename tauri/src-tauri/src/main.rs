// Task Manager — Electron 판 main.js 를 옮긴 것
//
// 화면(index.html 등)은 Electron 판과 같은 파일을 그대로 쓴다. 이 파일은
// main.js 741줄이 하던 일 — 파일 저장, 창 관리, 트레이, 전역 단축키,
// 리마인더 — 을 대신한다. 채널 이름과 주고받는 값의 모양은 그대로 맞췄다.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::{Datelike, Local, Timelike};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const DEFAULT_HOTKEY: &str = "F4";

/// 📌 창이 안 뜨는 것 같은 문제는 화면에 아무것도 안 남는다. 파일로 남긴다.
/// %APPDATA% 아래 Task Manager 폴더의 tauri.log
fn log(msg: &str) {
    use std::io::Write;
    let _ = fs::create_dir_all(data_dir());
    let p = data_dir().join("tauri.log");
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = writeln!(f, "{} {}", Local::now().format("%H:%M:%S"), msg);
    }
}


// ══════════════════════════════════════════════════════════════════
// 데이터 파일
// ══════════════════════════════════════════════════════════════════

/// Electron 판과 같은 폴더를 쓴다. 두 판이 같은 자료를 본다.
fn data_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Task Manager")
}

fn data_file() -> PathBuf {
    if let Ok(p) = std::env::var("TM_DATA_FILE") {
        return PathBuf::from(p);
    }
    data_dir().join("업무관리_데이터.json")
}

/// 예전 위치(내 문서 = OneDrive). 한 번만 옮겨 오고 원본은 지우지 않는다.
fn legacy_file() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").ok()?;
    Some(PathBuf::from(home).join("Documents").join("업무관리_데이터.json"))
}

fn read_doc() -> Map<String, Value> {
    let path = data_file();
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return Map::new(), // 아직 파일이 없으면 빈 문서로 시작한다
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(m)) => m,
        _ => {
            // 깨진 파일을 그냥 덮어쓰면 전체 자료가 사라진다. 원본을 남긴다.
            let backup = path.with_extension("손상됨.json");
            let _ = fs::write(backup, &raw);
            Map::new()
        }
    }
}

/// 📌 임시 파일에 쓰고 이름을 바꾼다. 쓰는 도중에 죽어도 원본이 남는다.
/// 동기화 폴더가 파일을 잠그면 rename 이 실패하므로 그때는 직접 쓴다.
fn write_doc(doc: &Map<String, Value>) -> Result<(), String> {
    let path = data_file();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(doc.clone())).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, &text).is_ok() && fs::rename(&tmp, &path).is_ok() {
        return Ok(());
    }
    let _ = fs::remove_file(&tmp);
    fs::write(&path, &text).map_err(|e| e.to_string())
}

/// 📌 파일 하나를 여러 창이 나눠 쓴다. 읽고-고치고-쓰는 한 사이클을 통째로
/// 잠근다. 잠그지 않으면 두 창이 거의 동시에 저장할 때 나중 것이 앞 것을 지운다.
fn doc_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn with_doc<T, F: FnOnce(&mut Map<String, Value>) -> T>(f: F) -> T {
    let _guard = doc_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_doc();
    let out = f(&mut doc);
    let _ = write_doc(&doc);
    out
}

fn settings() -> Map<String, Value> {
    match read_doc().get("settings") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

fn patch_settings(patch: Vec<(&str, Value)>) {
    with_doc(|doc| {
        let mut s = match doc.get("settings") {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        for (k, v) in patch {
            s.insert(k.to_string(), v);
        }
        doc.insert("settings".into(), Value::Object(s));
    });
}

// ── 시각 ──────────────────────────────────────────────────────────

fn stamp() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}
fn stamp_min() -> String {
    Local::now().format("%Y-%m-%dT%H:%M").to_string()
}
fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

// ── 옮겨 오기 · 백업 ──────────────────────────────────────────────

/// 예전 위치에 있던 파일을 새 위치로 한 번만 옮긴다. 원본은 지우지 않는다.
fn migrate_legacy() -> Option<String> {
    if std::env::var("TM_DATA_FILE").is_ok() {
        return None;
    }
    if data_file().exists() {
        return None;
    }
    let old = legacy_file()?;
    let raw = fs::read_to_string(&old).ok()?;
    fs::create_dir_all(data_dir()).ok()?;
    fs::write(data_file(), raw).ok()?;
    Some(old.to_string_lossy().to_string())
}

/// 📌 모든 자료가 파일 하나에 들어 있다. 하루 한 번 복사본을 만들고 7개만 남긴다.
fn daily_backup() {
    if std::env::var("TM_DATA_FILE").is_ok() {
        return;
    }
    let raw = match fs::read_to_string(data_file()) {
        Ok(r) => r,
        Err(_) => return,
    };
    let dir = data_dir().join("backups");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let file = dir.join(format!("업무관리_데이터-{}.json", today()));
    if file.exists() {
        return; // 오늘 것이 이미 있다
    }
    if fs::write(&file, raw).is_err() {
        return;
    }

    let mut olds: Vec<PathBuf> = fs::read_dir(&dir)
        .map(|it| {
            it.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with("업무관리_데이터-") && n.ends_with(".json"))
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    olds.sort();
    if olds.len() > 7 {
        for p in &olds[..olds.len() - 7] {
            let _ = fs::remove_file(p);
        }
    }
}

// ══════════════════════════════════════════════════════════════════
// 창
// ══════════════════════════════════════════════════════════════════

/// 마우스가 있는 화면의 작업 영역. 모니터가 두 대일 때 주 모니터에 고정되면
/// 다른 화면에서 일하다가 시선을 옮겨야 한다.
fn cursor_work_area(app: &AppHandle) -> (f64, f64, f64, f64) {
    if let Ok(pos) = app.cursor_position() {
        if let Ok(Some(m)) = app.monitor_from_point(pos.x, pos.y) {
            let p = m.position();
            let s = m.size();
            let sf = m.scale_factor();
            return (
                p.x as f64 / sf,
                p.y as f64 / sf,
                s.width as f64 / sf,
                s.height as f64 / sf,
            );
        }
    }
    (0.0, 0.0, 1920.0, 1080.0)
}

/// 창마다 심는다. __TAURI__ 가 아직 없을 수 있으므로 이벤트가 날 때 꺼내 쓴다.
const ERR_CATCHER: &str = r#"
window.addEventListener('error', function (e) {
    try {
        window.__TAURI__.core.invoke('js_log', {
            payload: 'JS오류 ' + e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0)
        });
    } catch (x) {}
});
window.addEventListener('unhandledrejection', function (e) {
    try {
        window.__TAURI__.core.invoke('js_log', { payload: '처리 안 된 거부 ' + e.reason });
    } catch (x) {}
});
document.addEventListener('DOMContentLoaded', function () {
    try {
        window.__TAURI__.core.invoke('js_log', {
            payload: 'DOM 준비됨 · body 길이 ' + (document.body ? document.body.innerHTML.length : -1)
        });
    } catch (x) {}
});
"#;

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 메모 위젯 — 스티키 메모처럼 놔둔 자리에 그대로 있어야 한다.
/// 📌 창 만들기는 메인 스레드에서 부르면 안 된다. 명령과 트레이 메뉴 처리는
/// 메인 스레드에서 도는데, build() 는 그 메인 이벤트 루프가 한 바퀴 돌아야
/// 끝난다. 서로 기다려 멈춘다 — 창 껍데기는 뜨는데 안이 하얗게 비는 증상이
/// 그것이다. 다른 스레드로 넘겨서 부른다.
fn open_widget_window(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        build_widget(&app);
    });
}

fn build_widget(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("widget") {
        log("위젯이 이미 있음 — 다시 보이게 함");
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }

    let mut b = WebviewWindowBuilder::new(app, "widget", WebviewUrl::App("widget.html".into()))
        .title("메모")
        .inner_size(320.0, 380.0)
        .min_inner_size(220.0, 160.0)
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .initialization_script(ERR_CATCHER)
        .on_page_load(|w, p| log(&format!("[{}] 페이지 {:?} {}", w.label(), p.event(), p.url())));

    // 저장해 둔 크기·위치. 모니터를 뺐을 때를 대비해 화면 안에 드는지 본다.
    if let Some(Value::Object(m)) = settings().get("memoWidget") {
        let get = |k: &str| m.get(k).and_then(|v| v.as_f64());
        if let (Some(x), Some(y), Some(w), Some(h)) =
            (get("x"), get("y"), get("width"), get("height"))
        {
            let fits = app
                .available_monitors()
                .map(|ms| {
                    ms.iter().any(|mo| {
                        let p = mo.position();
                        let s = mo.size();
                        let sf = mo.scale_factor();
                        let (mx, my) = (p.x as f64 / sf, p.y as f64 / sf);
                        let (mw, mh) = (s.width as f64 / sf, s.height as f64 / sf);
                        x >= mx - 40.0 && y >= my - 40.0 && x < mx + mw && y < my + mh
                    })
                })
                .unwrap_or(false);
            if fits {
                b = b.position(x, y).inner_size(w, h);
            }
        }
    }

    match b.build() {
        Err(e) => log(&format!("위젯 창 만들기 실패: {}", e)),
        Ok(win) => {
        log("위젯 창 만듦");
        let h = app.clone();
        win.on_window_event(move |e| {
            if matches!(e, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                remember_widget_bounds(&h);
            }
        });
        }
    }
}

/// 📌 끄는 동안 move/resize 가 연달아 온다. 그때마다 파일에 쓰면 저장이 과해진다.
/// 400ms 조용해진 뒤 마지막 것만 한 번 저장한다.
fn widget_gen() -> &'static AtomicU64 {
    static G: OnceLock<AtomicU64> = OnceLock::new();
    G.get_or_init(|| AtomicU64::new(0))
}

fn remember_widget_bounds(app: &AppHandle) {
    let mine = widget_gen().fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(400).await;
        if widget_gen().load(Ordering::SeqCst) != mine {
            return; // 그새 또 움직였다. 마지막 것만 남긴다.
        }
        let w = match app.get_webview_window("widget") {
            Some(w) => w,
            None => return,
        };
        if let (Ok(pos), Ok(size), Ok(sf)) = (w.outer_position(), w.inner_size(), w.scale_factor()) {
            patch_settings(vec![(
                "memoWidget",
                json!({
                    "x": pos.x as f64 / sf, "y": pos.y as f64 / sf,
                    "width": size.width as f64 / sf, "height": size.height as f64 / sf
                }),
            )]);
        }
    });
}

/// 빠른 등록 — 마우스가 있는 화면 한가운데.
/// 📌 창 만들기는 메인 스레드에서 부르면 안 된다. 명령과 트레이 메뉴 처리는
/// 메인 스레드에서 도는데, build() 는 그 메인 이벤트 루프가 한 바퀴 돌아야
/// 끝난다. 서로 기다려 멈춘다 — 창 껍데기는 뜨는데 안이 하얗게 비는 증상이
/// 그것이다. 다른 스레드로 넘겨서 부른다.
fn open_quick_add(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        build_quick_add(&app);
    });
}

fn build_quick_add(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("quickadd") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("quick-add-reset", ());
        return;
    }
    let (ax, ay, aw, ah) = cursor_work_area(app);
    let (w, h) = (470.0, 280.0);
    log("빠른 등록 창 만드는 중");
    let r = WebviewWindowBuilder::new(app, "quickadd", WebviewUrl::App("quickadd.html".into()))
        .title("빠른 등록")
        .inner_size(w, h)
        .position(ax + (aw - w) / 2.0, ay + (ah - h) / 2.0)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .initialization_script(ERR_CATCHER)
        .on_page_load(|w, p| log(&format!("[{}] 페이지 {:?} {}", w.label(), p.event(), p.url())))
        .build();
    if let Err(e) = r {
        log(&format!("빠른 등록 창 실패: {}", e));
    }
}

// ══════════════════════════════════════════════════════════════════
// 알림 보내기
// ══════════════════════════════════════════════════════════════════

/// 저장을 요청한 창은 이미 최신이므로 뺀다. 자기가 보낸 신호를 자기가 받으면
/// 저장할 때마다 화면이 한 번 더 그려진다.
fn broadcast_except(app: &AppHandle, from: &str, patch: Value) {
    let from = from.to_string();
    let _ = app.emit_filter("sync-sections", patch, move |t| match t {
        EventTarget::WebviewWindow { label } => label != &from,
        _ => false,
    });
}

fn toast(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

// ══════════════════════════════════════════════════════════════════
// 명령 — 채널 이름의 - 를 _ 로 바꾼 것이 그대로 이름이 된다
// ══════════════════════════════════════════════════════════════════

/// 화면 안에서 난 오류를 파일 로그로 끌어온다. 창이 하얗게만 뜨면
/// 콘솔을 볼 방법이 없어 원인을 알 수 없다.
#[tauri::command]
fn js_log(payload: Option<String>, window: tauri::Window) {
    log(&format!("[{}] {}", window.label(), payload.unwrap_or_default()));
}

#[tauri::command]
fn load_data() -> Value {
    Value::Object(read_doc())
}

/// patch 예: { tasks: [...] } — 바뀐 섹션만 담긴 객체.
/// 📌 창이 문서를 통째로 써내면, 그 창이 들고 있던 낡은 값이 남의 자료를 덮어쓴다.
#[tauri::command]
fn save_sections(payload: Option<Value>, window: tauri::Window, app: AppHandle) {
    let patch = match payload {
        Some(Value::Object(m)) => m,
        _ => return,
    };
    let p = patch.clone();
    with_doc(move |doc| {
        for (k, v) in p {
            doc.insert(k, v);
        }
    });
    broadcast_except(&app, window.label(), Value::Object(patch));
}

#[tauri::command]
fn get_data_path() -> Value {
    json!({
        "path": data_file().to_string_lossy(),
        "migratedFrom": migrated_from().clone()
    })
}

fn migrated_from() -> &'static Option<String> {
    static M: OnceLock<Option<String>> = OnceLock::new();
    M.get_or_init(migrate_legacy)
}

#[tauri::command]
fn open_data_folder(app: AppHandle) {
    let _ = app
        .opener()
        .open_path(data_dir().to_string_lossy().to_string(), None::<&str>);
}

// ── 문서 보관함 ───────────────────────────────────────────────────
// 파일을 복사하지 않고 경로만 기억한다. 여는 것도 윈도우에 맡긴다.

#[tauri::command]
async fn pick_files(app: AppHandle) -> Vec<String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title("보관함에 넣을 파일 고르기")
        .pick_files(move |paths| {
            let _ = tx.blocking_send(paths);
        });
    match rx.recv().await {
        Some(Some(paths)) => paths
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        _ => vec![],
    }
}

#[tauri::command]
fn open_file(payload: Option<String>, app: AppHandle) -> Value {
    let p = payload.unwrap_or_default();
    if p.is_empty() || !Path::new(&p).exists() {
        return json!({ "ok": false });
    }
    json!({ "ok": app.opener().open_path(p, None::<&str>).is_ok() })
}

/// 원본이 옮겨졌는지 한 번에 확인한다. 눌렀을 때 알면 늦다. (true = 없어짐)
#[tauri::command]
fn check_files(payload: Option<Vec<String>>) -> Vec<bool> {
    payload
        .unwrap_or_default()
        .iter()
        .map(|p| !Path::new(p).exists())
        .collect()
}

#[tauri::command]
fn show_in_folder(payload: Option<String>, app: AppHandle) {
    if let Some(p) = payload {
        let _ = app.opener().reveal_item_in_dir(p);
    }
}

// ── 창 ────────────────────────────────────────────────────────────

#[tauri::command]
fn open_widget(app: AppHandle) {
    log("open_widget 불림");
    open_widget_window(&app);
}

#[tauri::command]
fn show_main(app: AppHandle) {
    focus_main(&app);
}

#[tauri::command]
fn set_always_on_top(payload: Option<bool>, app: AppHandle) {
    if let Some(w) = app.get_webview_window("widget") {
        let _ = w.set_always_on_top(payload.unwrap_or(true));
    }
}

#[tauri::command]
fn close_quick_add(app: AppHandle) {
    if let Some(w) = app.get_webview_window("quickadd") {
        let _ = w.close();
    }
}

// ── 자동 시작 ─────────────────────────────────────────────────────

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(payload: Option<bool>, app: AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    let _ = if payload.unwrap_or(false) {
        m.enable()
    } else {
        m.disable()
    };
}

// ── 빠른 등록이 자료를 덧붙인다 ───────────────────────────────────
// 📌 빠른 등록 창은 자기 사본을 통째로 저장하지 않는다. 항상 디스크의 최신
// 목록에 덧붙인다. 그래야 이 창이 떠 있는 동안 메인 창에서 넣은 것이 안 사라진다.

fn field(v: &Option<Value>, k: &str) -> String {
    v.as_ref()
        .and_then(|o| o.get(k))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

#[tauri::command]
fn add_contact(payload: Option<Value>, window: tauri::Window, app: AppHandle) -> Value {
    let at = stamp();
    let day = at.split('T').next().unwrap_or("").to_string();
    let (name, memo, customer_no) = (
        field(&payload, "name"),
        field(&payload, "memo"),
        field(&payload, "customerNo"),
    );
    let digits: String = field(&payload, "phone")
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();

    let list = with_doc(|doc| {
        let mut list = match doc.get("contacts") {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![],
        };
        let phones = if digits.is_empty() {
            vec![]
        } else {
            vec![json!({
                "label": if digits.starts_with("01") { "휴대폰" } else { "사무실" },
                "value": digits
            })]
        };
        list.push(json!({
            "id": now_ms(),
            "name": name, "title": "", "org": "", "email": "",
            "customerNo": customer_no, "tag": "",
            "phones": phones,
            "projects": [],
            "notes": if memo.is_empty() { json!([]) } else { json!([{ "at": at, "text": memo }]) },
            "createdAt": day,
            "updatedAt": at,
            "lastNoteAt": if memo.is_empty() { "".to_string() } else { day.clone() }
        }));
        doc.insert("contacts".into(), Value::Array(list.clone()));
        list
    });

    broadcast_except(&app, window.label(), json!({ "contacts": list }));
    json!({ "ok": true, "contacts": list })
}

#[tauri::command]
fn add_note(payload: Option<Value>, window: tauri::Window, app: AppHandle) -> Value {
    let at = stamp();
    let day = at.split('T').next().unwrap_or("").to_string();
    let id = payload.as_ref().and_then(|o| o.get("id")).cloned();
    let text = field(&payload, "text");

    let result = with_doc(|doc| {
        let mut list = match doc.get("contacts") {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![],
        };
        let target = match list.iter_mut().find(|c| c.get("id") == id.as_ref()) {
            Some(c) => c,
            None => return None,
        };
        let mut notes = match target.get("notes") {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![],
        };
        notes.push(json!({ "at": at, "text": text }));
        target["notes"] = Value::Array(notes);
        target["lastNoteAt"] = json!(day);
        target["updatedAt"] = json!(at);
        doc.insert("contacts".into(), Value::Array(list.clone()));
        Some(list)
    });

    match result {
        Some(list) => {
            broadcast_except(&app, window.label(), json!({ "contacts": list }));
            json!({ "ok": true, "contacts": list })
        }
        None => json!({ "ok": false }),
    }
}

#[tauri::command]
fn add_task(payload: Option<Value>, window: tauri::Window, app: AppHandle) -> Value {
    let at = stamp();
    let day = at.split('T').next().unwrap_or("").to_string();
    let (content, due) = (field(&payload, "content"), field(&payload, "dueDate"));

    let tasks = with_doc(|doc| {
        let mut tasks = match doc.get("tasks") {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![],
        };
        let cats: Vec<String> = match doc.get("categories") {
            Some(Value::Array(a)) if !a.is_empty() => {
                a.iter().filter_map(|v| v.as_str().map(String::from)).collect()
            }
            _ => vec!["기타".to_string()],
        };
        // 메인 창의 신규 등록 폼과 같은 기본값
        let cat = if cats.iter().any(|c| c == "기타") {
            "기타".to_string()
        } else {
            cats.first().cloned().unwrap_or_else(|| "기타".into())
        };
        tasks.push(json!({
            "id": now_ms(), "regDate": day, "dueDate": due, "content": content,
            "category": cat, "firstAction": "", "importance": "높음", "urgency": "높음",
            "priority": 1, "timeReq": "", "status": "대기중", "remarks": ""
        }));
        doc.insert("tasks".into(), Value::Array(tasks.clone()));
        tasks
    });

    broadcast_except(&app, window.label(), json!({ "tasks": tasks }));
    json!({ "ok": true, "count": tasks.len() })
}

#[tauri::command]
fn add_event(payload: Option<Value>, window: tauri::Window, app: AppHandle) -> Value {
    let now = stamp_min();
    let day = now.split('T').next().unwrap_or("").to_string();
    let (title, memo) = (field(&payload, "title"), field(&payload, "memo"));
    let mut date = field(&payload, "date");
    if date.is_empty() {
        date = today();
    }
    let time = field(&payload, "time");
    let remind = payload
        .as_ref()
        .and_then(|o| o.get("remind"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let list = with_doc(|doc| {
        let mut events = match doc.get("events") {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![],
        };
        events.push(json!({
            "id": now_ms(), "title": title, "date": date, "time": time,
            "remind": remind, "memo": memo, "createdAt": day, "updatedAt": now
        }));
        doc.insert("events".into(), Value::Array(events.clone()));
        events
    });

    broadcast_except(&app, window.label(), json!({ "events": list }));
    json!({ "ok": true, "count": list.len() })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── 전역 단축키 ───────────────────────────────────────────────────
// 📌 윈도우 전체에서 그 키를 가로챈다. 등록에 실패하면 반드시 알린다.
// 조용히 안 먹는 상태가 제일 나쁘다.

fn parse_accel(accel: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    accel.parse().ok()
}

fn apply_hotkey(app: &AppHandle, accel: &str) -> Value {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if accel.is_empty() {
        return json!({ "ok": true, "accel": "" });
    }
    match parse_accel(accel) {
        Some(sc) => json!({ "ok": gs.register(sc).is_ok(), "accel": accel }),
        None => json!({ "ok": false, "accel": accel, "error": "알 수 없는 키" }),
    }
}

fn apply_hotkey_from_settings(app: &AppHandle) {
    let accel = settings()
        .get("hotkey")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string());
    let res = apply_hotkey(app, &accel);
    if res["ok"] == json!(false) && !accel.is_empty() {
        toast(
            app,
            "단축키를 등록하지 못했습니다",
            &format!("‘{}’ 은(는) 다른 프로그램이 쓰고 있습니다. 설정에서 다른 키로 바꿔주세요.", accel),
        );
    }
}

#[tauri::command]
fn get_hotkey() -> Value {
    let accel = settings()
        .get("hotkey")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string());
    json!({ "accel": accel })
}

#[tauri::command]
fn set_hotkey(payload: Option<String>, app: AppHandle) -> Value {
    let accel = payload.unwrap_or_default();
    let res = apply_hotkey(&app, &accel);
    if res["ok"] == json!(true) {
        patch_settings(vec![("hotkey", json!(accel))]);
    } else {
        apply_hotkey_from_settings(&app); // 실패하면 원래 키로 되돌린다
    }
    res
}

// ══════════════════════════════════════════════════════════════════
// 리마인더 — 일정에 시각이 있고 알림을 걸어 뒀으면 그때 알린다
// ══════════════════════════════════════════════════════════════════

fn snoozed() -> &'static Mutex<HashMap<u64, u64>> {
    static S: OnceLock<Mutex<HashMap<u64, u64>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 알림 창은 화면 한가운데. 포커스를 가져간다 — 놓치면 안 되는 약속이라서.
fn show_reminder(app: &AppHandle, ev: &Value, late: bool) {
    let app = app.clone();
    let ev = ev.clone();
    tauri::async_runtime::spawn(async move {
        build_reminder(&app, &ev, late);
    });
}

fn build_reminder(app: &AppHandle, ev: &Value, late: bool) {
    if let Some(w) = app.get_webview_window("reminder") {
        let _ = w.close();
    }
    let has_memo = ev.get("memo").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
    let (w, h) = (420.0, if has_memo { 260.0 } else { 200.0 });
    let (ax, ay, aw, ah) = cursor_work_area(app);

    let built = WebviewWindowBuilder::new(app, "reminder", WebviewUrl::App("reminder.html".into()))
        .title("알림")
        .inner_size(w, h)
        .position(ax + (aw - w) / 2.0, ay + (ah - h) / 2.0)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .initialization_script(ERR_CATCHER)
        .on_page_load(|w, p| log(&format!("[{}] 페이지 {:?} {}", w.label(), p.event(), p.url())))
        .build();

    if let Ok(win) = built {
        let payload = json!({
            "id": ev.get("id"), "title": ev.get("title"), "memo": ev.get("memo"),
            "date": ev.get("date"), "time": ev.get("time"), "late": late
        });
        // 창이 다 뜬 뒤에 보내야 화면이 값을 받는다.
        let win2 = win.clone();
        tauri::async_runtime::spawn(async move {
            tokio_sleep(400).await;
            let _ = win2.emit("reminder", payload);
        });
    }

    let title = format!("🔔 {} 알림", ev.get("time").and_then(|v| v.as_str()).unwrap_or(""));
    toast(app, &title, ev.get("title").and_then(|v| v.as_str()).unwrap_or(""));
}

async fn tokio_sleep(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms)))
        .await
        .ok();
}

/// 알린 것은 파일에 표시해 둔다. 껐다 켜도 같은 알림이 다시 뜨지 않는다.
fn mark_notified(app: &AppHandle, id: &Value) {
    let id = id.clone();
    with_doc(|doc| {
        if let Some(Value::Array(list)) = doc.get_mut("events") {
            if let Some(ev) = list.iter_mut().find(|e| e.get("id") == Some(&id)) {
                ev["notifiedAt"] = json!(stamp_min());
            }
        }
    });
    let _ = app.emit("reminder-updated", ());
}

#[tauri::command]
fn reminder_done(payload: Option<Value>, app: AppHandle) {
    if let Some(w) = app.get_webview_window("reminder") {
        let _ = w.close();
    }
    if let Some(id) = payload {
        if !id.is_null() {
            mark_notified(&app, &id);
        }
    }
}

#[tauri::command]
fn reminder_snooze(payload: Option<Value>, app: AppHandle) {
    if let Some(w) = app.get_webview_window("reminder") {
        let _ = w.close();
    }
    if let Some(id) = payload.and_then(|v| v.as_u64()) {
        snoozed().lock().unwrap().insert(id, now_ms() + 10 * 60 * 1000);
    }
}

/// 1분마다 확인한다. 초 단위로 볼 이유가 없다.
fn check_reminders(app: &AppHandle) {
    let doc = read_doc();
    let list = match doc.get("events") {
        Some(Value::Array(a)) => a.clone(),
        _ => return,
    };
    let today_s = today();
    let now = Local::now();
    let now_min = now.hour() as i64 * 60 + now.minute() as i64;

    for ev in &list {
        let time = ev.get("time").and_then(|v| v.as_str()).unwrap_or("");
        let remind = ev.get("remind").and_then(|v| v.as_bool()).unwrap_or(false);
        let notified = ev
            .get("notifiedAt")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        if time.is_empty() || !remind || notified {
            continue; // 알림을 걸어 둔 것만
        }

        let id = ev.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
        let until = snoozed().lock().unwrap().get(&id).copied();
        if let Some(until) = until {
            if now_ms() < until {
                continue;
            }
            snoozed().lock().unwrap().remove(&id);
            show_reminder(app, ev, false);
            return; // 한 번에 하나만 띄운다
        }

        if ev.get("date").and_then(|v| v.as_str()).unwrap_or("") != today_s {
            continue;
        }
        let mut parts = time.split(':');
        let h: i64 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(v) => v,
            None => continue,
        };
        let m: i64 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(v) => v,
            None => continue,
        };
        if h * 60 + m > now_min {
            continue; // 아직 시각 전
        }
        // 지난 시각인데 아직 안 알린 것 = 앱이 꺼져 있던 동안 지나간 알림
        show_reminder(app, ev, h * 60 + m < now_min - 1);
        return;
    }
}

/// 📌 D-day 는 할 일 탭을 열어야 보인다. 앱을 켤 때 한 번 알려준다.
/// 기한이 지난 건은 세지 않는다 — 이미 아는 일이라 또 보면 피로해진다.
fn notify_deadlines(app: &AppHandle) {
    let doc = read_doc();
    let tasks = match doc.get("tasks") {
        Some(Value::Array(a)) => a.clone(),
        _ => return,
    };
    let now = Local::now().date_naive();
    let dow = now.weekday().num_days_from_monday() as i64;
    let week_end = now + chrono::Duration::days(6 - dow);

    let (mut today_n, mut week_n) = (0, 0);
    for t in &tasks {
        if t.get("status").and_then(|v| v.as_str()) == Some("완료됨") {
            continue;
        }
        let due = match t.get("dueDate").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        let d = match chrono::NaiveDate::parse_from_str(due.split('T').next().unwrap_or(due), "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => continue,
        };
        if d == now {
            today_n += 1;
        } else if d > now && d <= week_end {
            week_n += 1;
        }
    }
    if today_n == 0 && week_n == 0 {
        return;
    }
    let mut parts = vec![];
    if today_n > 0 {
        parts.push(format!("오늘 마감 {}건", today_n));
    }
    if week_n > 0 {
        parts.push(format!("이번 주 마감 {}건", week_n));
    }
    toast(app, "Task Manager", &parts.join("  ·  "));
}

// ══════════════════════════════════════════════════════════════════

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // 누를 때만. 떼는 순간까지 받으면 두 번 열린다.
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        open_quick_add(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            js_log, load_data, save_sections, get_data_path, open_data_folder,
            pick_files, open_file, check_files, show_in_folder,
            open_widget, show_main, set_always_on_top, close_quick_add,
            get_autostart, set_autostart,
            add_contact, add_note, add_task, add_event,
            get_hotkey, set_hotkey,
            reminder_done, reminder_snooze
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let _ = migrated_from(); // 예전 위치에서 한 번 옮겨 온다
            daily_backup();

            // ── 트레이 ──
            // 📌 창을 닫아도 앱은 여기 남는다. 알림이 계속 떠야 하기 때문이다.
            let open_i = MenuItem::with_id(app, "open", "업무 창 열기", true, None::<&str>)?;
            let quick_i = MenuItem::with_id(app, "quick", "빠른 등록", true, None::<&str>)?;
            let memo_i = MenuItem::with_id(app, "memo", "메모 위젯", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "완전 종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quick_i, &memo_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Task Manager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => focus_main(app),
                    "quick" => open_quick_add(app),
                    "memo" => open_widget_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        focus_main(tray.app_handle());
                    }
                })
                .build(app)?;

            log("── 시작 ──");
            apply_hotkey_from_settings(&handle);

            // ── 메모 위젯의 크기·위치를 기억한다 ──
            if let Some(w) = app.get_webview_window("main") {
                let h2 = handle.clone();
                w.on_window_event(move |e| {
                    // 창을 닫아도 트레이에 남는다 (완전 종료는 트레이 메뉴에서만)
                    if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        if let Some(w) = h2.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            // ── 리마인더 · 마감 알림 ──
            let h3 = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio_sleep(1500).await; // 창이 뜬 뒤에 알린다
                notify_deadlines(&h3);
                loop {
                    check_reminders(&h3);
                    tokio_sleep(60_000).await;
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Task Manager 를 띄우지 못했습니다")
        .run(|_app, event| {
            // 📌 창이 하나도 없어도 끝내지 않는다. 트레이에 상주하는 것이 정상 상태다.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
