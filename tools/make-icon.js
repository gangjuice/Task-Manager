// 아이콘 만들기 — 초록 둥근 사각형 + 흰 획 하나(번개 → 체크)
//
// 브라우저를 거치지 않고 픽셀을 직접 계산한다. 모양이 둥근 사각형과
// 굵은 꺾은선 하나뿐이라 수식으로 그리는 편이 더 정확하고, 화면 밖 창을
// 찍을 때처럼 빈 그림이 나올 일도 없다.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = process.argv[2];
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// ── 모양 (100 x 100 칸 기준) ──────────────────────────────────────
// 한 획으로 그린다. 앞의 세 마디가 번개의 지그재그,
// 마지막 마디가 위로 꺾이면서 그대로 체크(✓)의 긴 팔이 된다.
const RAW = [
    [56, 10],   // 꼭대기 (오른쪽 위)
    [24, 46],   // 왼쪽 아래로
    [50, 46],   // 오른쪽으로 — 번개의 허리
    [32, 70],   // 다시 왼쪽 아래로 — 번개의 끝
    [54, 88],   // 오른쪽 아래로 — 여기서 체크의 짧은 팔이 된다
    [92, 30]    // 오른쪽 위로 — 체크의 긴 팔
];
const RAW_STROKE = 12;
const FILL = 0.84;          // 글리프가 타일에서 차지할 비율
const RADIUS = 22;          // 둥근 모서리
const TOP = [46, 204, 113];    // #2ECC71
const BOT = [34, 154, 85];     // #229A55

// 획 굵기까지 넣어 실제 넓이를 재고, 가운데로 옮긴 뒤 한 번 더 줄인다.
const pad = RAW_STROKE / 2;
const xs = RAW.map(p => p[0]), ys = RAW.map(p => p[1]);
const bx = [Math.min(...xs) - pad, Math.max(...xs) + pad];
const by = [Math.min(...ys) - pad, Math.max(...ys) + pad];
const dx = (100 - (bx[1] - bx[0])) / 2 - bx[0];
const dy = (100 - (by[1] - by[0])) / 2 - by[0];
const off = 50 - 50 * FILL;

const PTS = RAW.map(p => [(p[0] + dx) * FILL + off, (p[1] + dy) * FILL + off]);
const STROKE = RAW_STROKE * FILL;

// ── 거리 계산 ─────────────────────────────────────────────────────

// 점과 선분 사이 거리. 꺾은선 전체와의 최소 거리가 곧 획의 안팎을 가른다
// (둥근 캡·둥근 조인이 저절로 따라온다).
function distToSeg(px, py, ax, ay, bx2, by2) {
    const vx = bx2 - ax, vy = by2 - ay;
    const wx = px - ax, wy = py - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const cx = ax + t * vx, cy = ay + t * vy;
    return Math.hypot(px - cx, py - cy);
}

function distToStroke(x, y) {
    let d = Infinity;
    for (let i = 0; i < PTS.length - 1; i++) {
        const t = distToSeg(x, y, PTS[i][0], PTS[i][1], PTS[i + 1][0], PTS[i + 1][1]);
        if (t < d) d = t;
    }
    return d;
}

// 둥근 사각형 안인지 — 모서리 쪽에서만 원으로 잘린다.
function insideRounded(x, y) {
    const ox = Math.max(RADIUS - x, 0, x - (100 - RADIUS));
    const oy = Math.max(RADIUS - y, 0, y - (100 - RADIUS));
    return ox * ox + oy * oy <= RADIUS * RADIUS;
}

// ── 그리기 ────────────────────────────────────────────────────────
// 한 픽셀을 SS x SS 로 잘게 나눠 세어 가장자리를 부드럽게 한다.
const SS = 4;

function render(size) {
    const buf = Buffer.alloc(size * size * 4);
    const step = 100 / size / SS;
    const half = STROKE / 2;

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let bgHits = 0, fgHits = 0, gradSum = 0;

            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const x = (px * SS + sx + 0.5) * step;
                    const y = (py * SS + sy + 0.5) * step;
                    if (!insideRounded(x, y)) continue;
                    bgHits++;
                    gradSum += y / 100;
                    if (distToStroke(x, y) <= half) fgHits++;
                }
            }

            const total = SS * SS;
            const o = (py * size + px) * 4;
            if (!bgHits) { buf.writeUInt32LE(0, o); continue; }

            const g = gradSum / bgHits;
            const bg = [0, 1, 2].map(i => TOP[i] + (BOT[i] - TOP[i]) * g);

            // 흰 획이 덮은 비율만큼 바탕색과 섞는다.
            const w = fgHits / bgHits;
            buf[o]     = Math.round(bg[0] * (1 - w) + 255 * w);
            buf[o + 1] = Math.round(bg[1] * (1 - w) + 255 * w);
            buf[o + 2] = Math.round(bg[2] * (1 - w) + 255 * w);
            buf[o + 3] = Math.round(255 * bgHits / total);
        }
    }
    return buf;
}

// ── PNG 로 묶기 ───────────────────────────────────────────────────

const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function toPNG(rgba, size) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;    // 8비트
    ihdr[9] = 6;    // RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    // 줄마다 필터 바이트(0)를 앞에 붙인다.
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// ── ICO 로 묶기 ───────────────────────────────────────────────────
// ICO 는 PNG 를 그대로 담을 수 있다 (Vista 이상). 헤더만 직접 쓴다.
function buildIco(entries) {
    const head = Buffer.alloc(6);
    head.writeUInt16LE(0, 0);
    head.writeUInt16LE(1, 2);                  // 1 = 아이콘
    head.writeUInt16LE(entries.length, 4);

    const dir = Buffer.alloc(16 * entries.length);
    let offset = head.length + dir.length;

    entries.forEach((e, i) => {
        const o = i * 16;
        dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 0);   // 256 은 0 으로 적는다
        dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
        dir.writeUInt8(0, o + 2);
        dir.writeUInt8(0, o + 3);
        dir.writeUInt16LE(1, o + 4);           // 색 평면
        dir.writeUInt16LE(32, o + 6);          // 비트 수
        dir.writeUInt32LE(e.png.length, o + 8);
        dir.writeUInt32LE(offset, o + 12);
        offset += e.png.length;
    });

    return Buffer.concat([head, dir, ...entries.map(e => e.png)]);
}

// ── 실행 ──────────────────────────────────────────────────────────
const entries = SIZES.map(size => {
    const png = toPNG(render(size), size);
    console.log('  ' + String(size).padStart(3) + 'px   ' + png.length + ' bytes');
    return { size: size, png: png };
});

fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(entries));
console.log('  → build/icon.ico   (설치 파일 · exe 아이콘)');

const big = entries.find(e => e.size === 256).png;
fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), big);
console.log('  → assets/icon.png  (창 · 트레이 · 알림)');

// 눈으로 확인할 미리보기 — 작은 크기는 크게 늘려 붙여 놓는다.
const prev = process.env.TMP;
fs.writeFileSync(path.join(prev, 'icon-256.png'), big);
[16, 32, 48].forEach(s => {
    const src = render(s);
    const z = 8, w = s * z;
    const out = Buffer.alloc(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
        const so = (Math.floor(y / z) * s + Math.floor(x / z)) * 4;
        src.copy(out, (y * w + x) * 4, so, so + 4);
    }
    fs.writeFileSync(path.join(prev, 'icon-' + s + '-zoom.png'), toPNG(out, w));
});
console.log('  → 미리보기: ' + prev + '\\icon-*.png');
