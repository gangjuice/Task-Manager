// 루트의 화면 파일을 dist/ 로 복사하고 Electron 호환 껍데기를 끼워 넣는다.
//
// 📌 화면 파일은 한 글자도 고치지 않는다. Electron 판과 Tauri 판이 같은
// 원본을 쓰게 해야, 한쪽만 고쳐 두 판이 갈라지는 일이 없다. 껍데기를
// 넣는 일도 복사본에만 한다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(HERE, 'dist');

const PAGES = ['index.html', 'widget.html', 'quickadd.html', 'reminder.html'];
const ASSETS = ['assets'];

// 페이지마다 딱 한 줄, require('electron') 로 바깥과 이어져 있다.
// 그 줄이 돌기 전에 껍데기가 먼저 올라와야 한다.
const ANCHOR = "const { ipcRenderer } = require('electron');";
const INJECT = '<script src="./electron-shim.js"></script>';

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

fs.copyFileSync(path.join(HERE, 'shim', 'electron-shim.js'),
                path.join(DIST, 'electron-shim.js'));

let injected = 0;
for (const page of PAGES) {
    const src = path.join(ROOT, page);
    if (!fs.existsSync(src)) {
        console.error('없는 파일: ' + page);
        process.exit(1);
    }
    let html = fs.readFileSync(src, 'utf8');

    if (!html.includes(ANCHOR)) {
        console.error(page + ' 에서 require(\'electron\') 줄을 못 찾았습니다.');
        console.error('화면 파일이 바뀌었다면 sync-ui.mjs 의 ANCHOR 도 맞춰야 합니다.');
        process.exit(1);
    }

    // </head> 가 있으면 그 앞에, 없으면 첫 <script> 앞에 넣는다.
    if (html.includes('</head>')) {
        html = html.replace('</head>', '    ' + INJECT + '\n</head>');
    } else {
        html = html.replace('<script>', INJECT + '\n<script>');
    }

    fs.writeFileSync(path.join(DIST, page), html);
    injected++;
}

// 글꼴·아이콘
for (const dir of ASSETS) {
    const from = path.join(ROOT, dir);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(DIST, dir), { recursive: true });
}

// 크기를 눈으로 보게 남긴다 — 이 시험의 목적이 용량이다.
function sizeOf(p) {
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        total += e.isDirectory() ? sizeOf(f) : fs.statSync(f).size;
    }
    return total;
}
const kb = n => (n / 1024).toFixed(0) + 'KB';

console.log('  화면 ' + injected + '개에 껍데기를 끼웠습니다');
console.log('  dist 전체       ' + kb(sizeOf(DIST)));
console.log('    ├ 글꼴        ' + kb(sizeOf(path.join(DIST, 'assets', 'fonts'))));
console.log('    └ 나머지      ' + kb(sizeOf(DIST) - sizeOf(path.join(DIST, 'assets', 'fonts'))));
