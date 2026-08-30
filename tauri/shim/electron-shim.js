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

    // 채널 이름을 명령 이름으로 바꿔 부른다. 없는 명령은 Tauri 가 에러를 주므로
    // 조용히 실패하지 않는다 — 옮기다 만 것이 있으면 콘솔에 그대로 드러난다.
    const failed = new Set();
    function noteFailure(ch, err) {
        if (failed.has(ch)) return;
        failed.add(ch);
        console.error('[shim] 채널 실패:', ch, err);
    }

    const listeners = new Map();   // 채널 → Tauri unlisten 함수

    const ipcRenderer = {
        invoke(channel, ...args) {
            // Tauri 명령은 인자를 이름 붙은 객체로 받는다. 전부 payload 하나로 넘긴다.
            return T.core.invoke(toCommand(channel), { payload: args[0] ?? null })
                .catch(err => { noteFailure(channel, err); return null; });
        },

        send(channel, ...args) {
            T.core.invoke(toCommand(channel), { payload: args[0] ?? null })
                .catch(err => noteFailure(channel, err));
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

    // ── Electron 에만 있는 것 두 가지를 메워 준다 ──────────────────

    // 📌 Electron 에서는 window.close() 가 그 창을 닫는다. WebView2 는
    // 문서만 비우고 창 껍데기를 남긴다 — 메모 위젯의 ✖ 를 눌렀을 때
    // 하얀 창이 그대로 남던 것이 이것이다.
    window.close = function () {
        try {
            T.window.getCurrentWindow().close();
        } catch (e) {
            console.error('[shim] 창 닫기 실패', e);
        }
    };

    // 📌 -webkit-app-region: drag 도 Electron(크로미움 앱 창) 전용이다.
    // 그대로 두면 테두리 없는 창(메모 위젯 · 빠른 등록 · 알림)을 못 끈다.
    // 화면 파일은 고치지 않고, 거기 적힌 CSS 를 읽어 같은 규칙을 흉내 낸다.
    function setupDragRegions() {
        // 언젠가 WebView2 가 지원하게 되면 이 흉내는 필요 없다.
        if (window.CSS && CSS.supports && CSS.supports('-webkit-app-region', 'drag')) return;

        const drag = [], nodrag = [];
        document.querySelectorAll('style').forEach(function (st) {
            const css = st.textContent || '';
            const re = /([^{}]+)\{([^{}]*)\}/g;
            let m;
            while ((m = re.exec(css))) {
                const sel = m[1].trim(), body = m[2];
                if (!sel || sel.charAt(0) === '@') continue;   // @media 등은 건너뛴다
                if (/-webkit-app-region\s*:\s*no-drag/.test(body)) nodrag.push(sel);
                else if (/-webkit-app-region\s*:\s*drag/.test(body)) drag.push(sel);
            }
        });
        if (!drag.length) return;

        const dragSel = drag.join(','), noSel = nodrag.join(',');
        const KEEP = ['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'A', 'LABEL', 'OPTION'];

        document.addEventListener('mousedown', function (e) {
            if (e.button !== 0 || !e.target || !e.target.closest) return;
            if (KEEP.indexOf(e.target.tagName) >= 0) return;      // 눌려야 하는 것
            if (noSel && e.target.closest(noSel)) return;
            if (!e.target.closest(dragSel)) return;
            e.preventDefault();
            try { T.window.getCurrentWindow().startDragging(); } catch (x) {}
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupDragRegions);
    } else {
        setupDragRegions();
    }

    // 페이지의 인라인 스크립트가 부르는 그 한 줄.
    window.require = function (mod) {
        if (mod === 'electron') return { ipcRenderer: ipcRenderer };
        console.warn('[shim] 모르는 모듈:', mod);
        return {};
    };

    window.__shimFailed = failed;   // 콘솔에서 무엇이 안 되는지 볼 수 있게
})();
