// Task Manager — Tauri 시험판
//
// 📌 지금은 "얼마나 작아지는가"를 재려고 만든 껍데기다. 화면(UI)은 Electron 판과
// 똑같은 파일을 그대로 쓰고, 여기서는 데이터를 읽고 쓰는 것까지만 옮겼다.
// 나머지 채널은 shim 이 경고만 남기고 넘어간다.
//
// ⚠️ 쓰기는 실제 데이터 파일이 아니라 옆에 따로 만든 시험용 파일에 한다.
// 아직 검증 안 된 저장 코드가 진짜 자료를 건드리면 안 된다.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Electron 판이 쓰는 폴더와 같은 곳을 본다: %APPDATA%\Task Manager
fn data_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("Task Manager")
}

fn real_file() -> PathBuf {
    data_dir().join("업무관리_데이터.json")
}

/// 시험판이 쓰는 파일. 진짜 자료와 갈라 놓는다.
fn test_file() -> PathBuf {
    data_dir().join("업무관리_데이터.tauri시험.json")
}

/// 시험용 파일이 있으면 그것을, 없으면 진짜 파일을 읽는다.
/// 그래서 처음 켰을 때 실제 자료가 그대로 보인다.
fn read_doc() -> Value {
    for p in [test_file(), real_file()] {
        if let Ok(raw) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                return v;
            }
        }
    }
    Value::Object(Map::new())
}

/// 📌 임시 파일에 쓰고 이름을 바꾼다. 쓰다가 죽어도 원본이 반쪽으로 남지 않는다.
fn write_atomic(path: &PathBuf, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    // rename 이 막히는 환경(동기화 폴더 등)이 있어 실패하면 직접 쓴다.
    if fs::rename(&tmp, path).is_err() {
        fs::write(path, text).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

/// 파일 하나를 여러 창이 나눠 쓴다. 저장이 겹치면 나중 것이 앞 것을 지운다.
struct DocLock(Mutex<()>);

#[tauri::command]
fn load_data() -> Value {
    read_doc()
}

/// 📌 통째로 덮어쓰지 않고 건드린 칸만 바꾼다. 메모 창이 메모만 저장할 때
/// 다른 창이 방금 넣은 연락처가 날아가면 안 된다.
#[tauri::command]
fn save_sections(payload: Option<Value>, lock: tauri::State<DocLock>) -> Result<(), String> {
    let patch = match payload {
        Some(Value::Object(m)) => m,
        _ => return Ok(()),
    };
    let _guard = lock.0.lock().map_err(|e| e.to_string())?;

    let mut doc = match read_doc() {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    for (k, v) in patch {
        doc.insert(k, v);
    }

    let text = serde_json::to_string_pretty(&Value::Object(doc)).map_err(|e| e.to_string())?;
    write_atomic(&test_file(), &text)
}

#[tauri::command]
fn get_data_path() -> Value {
    serde_json::json!({
        "path": test_file().to_string_lossy(),
        "migratedFrom": Value::Null
    })
}

#[tauri::command]
fn get_hotkey() -> Value {
    let doc = read_doc();
    let accel = doc
        .get("settings")
        .and_then(|s| s.get("hotkey"))
        .and_then(|h| h.as_str())
        .unwrap_or("F4");
    serde_json::json!({ "accel": accel })
}

#[tauri::command]
fn get_autostart() -> bool {
    false // 아직 안 옮겼다
}

#[tauri::command]
fn open_data_folder() {
    let dir = data_dir();
    let _ = std::process::Command::new("explorer").arg(dir).spawn();
}

fn main() {
    tauri::Builder::default()
        .manage(DocLock(Mutex::new(())))
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_sections,
            get_data_path,
            get_hotkey,
            get_autostart,
            open_data_folder
        ])
        .run(tauri::generate_context!())
        .expect("Task Manager 를 띄우지 못했습니다");
}
