// Electron 호환 껍데기
//
// 📌 이 파일의 목적은 index.html · widget.html · quickadd.html · reminder.html
// 을 한 줄도 안 고치고 그대로 쓰는 것이다. 네 파일은 각각 딱 한 줄,
//
//     const { ipcRenderer } = require('electron');
//
// 으로 바깥과 이어져 있다. 그 한 줄만 가로채면 UI 5,000여 줄이 그대로 돈다.
// 채널 이름(load-data)을 Rust 명령 이름(load_data)으로 바꿔 넘긴다.
//
// 아직 안 만든 채널은 조용히 실패하지 않고 콘솔에 남긴다. 무엇이 빠졌는지
// 눈에 보여야 옮기다 만 것을 놓치지 않는다.

(function () {
    'use strict';

    const T = window.__TAURI__;
    if (!T) {
        console.error('[shim] Tauri 를 찾을 수 없습니다. withGlobalTauri 설정을 확인하세요.');
        return;
    }

    const toCommand = ch => String(ch).replace(/-/g, '_');

    // 아직 Rust 쪽에 안 옮긴 것들. 부르면 경고만 남기고 넘어간다.
    const NOT_YET = new Set([
        'add-contact', 'add-event', 'add-note', 'add-task',
        'check-files', 'open-file', 'pick-files', 'set-hotkey',
        'close-quick-add', 'open-widget', 'reminder-done', 'reminder-snooze',
        'set-always-on-top', 'set-autostart', 'show-in-folder'
    ]);

    const missing = new Set();
    function warnMissing(ch) {
        if (missing.has(ch)) return;
        missing.add(ch);
        console.warn('[shim] 아직 안 옮긴 채널:', ch);
    }

    const listeners = new Map();   // 채널 → Tauri unlisten 함수

    const ipcRenderer = {
        invoke(channel, ...args) {
            if (NOT_YET.has(channel)) {
                warnMissing(channel);
                return Promise.resolve(null);
            }
            // Tauri 명령은 인자를 이름 붙은 객체로 받는다. 전부 payload 하나로 넘긴다.
            return T.core.invoke(toCommand(channel), { payload: args[0] ?? null })
                .catch(err => {
                    console.error('[shim] invoke 실패:', channel, err);
                    return null;
                });
        },

        send(channel, ...args) {
            if (NOT_YET.has(channel)) { warnMissing(channel); return; }
            T.core.invoke(toCommand(channel), { payload: args[0] ?? null })
                .catch(err => console.error('[shim] send 실패:', channel, err));
        },

        on(channel, handler) {
            // Electron 은 (event, ...args) 로 부른다. 형태를 맞춰 준다.
            T.event.listen(channel, e => handler({}, e.payload))
                .then(un => listeners.set(channel, un))
                .catch(err => console.error('[shim] listen 실패:', channel, err));
        },

        removeAllListeners(channel) {
            const un = listeners.get(channel);
            if (un) { un(); listeners.delete(channel); }
        }
    };

    // 페이지의 인라인 스크립트가 부르는 그 한 줄.
    window.require = function (mod) {
        if (mod === 'electron') return { ipcRenderer: ipcRenderer };
        console.warn('[shim] 모르는 모듈:', mod);
        return {};
    };

    window.__shimMissing = missing;   // 콘솔에서 무엇이 빠졌는지 볼 수 있게
})();
