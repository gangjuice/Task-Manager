// 번개 아이콘 — 초록 둥근 사각형 + 흰 번개
//
// 획(선) 대신 면으로 채운 번개 실루엣이다. 뾰족한 끝만 둥글리고
// 안쪽 꺾임은 날카롭게 두면 번개다움이 산다. 번개 아래에는 아주 옅은
// 그림자를 깔아 바탕에서 살짝 떠 보이게 했다.
//
// 브라우저를 거치지 않고 픽셀을 직접 계산한다. 크기마다 새로 그리므로
// 16px 에서도 흐려지지 않는다.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = process.argv[2] || '.';
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function num(k, dflt) { return process.env[k] ? parseFloat(process.env[k]) : dflt; }

// ── 모양 (100 x 100 칸 기준) ──────────────────────────────────────
// 📌 잘 그려진 번개는 예외 없이 점대칭이다. 가운데를 기준으로 180° 돌리면
// 자기 자신과 겹친다. 좌표를 여섯 개 다 손으로 적으면 한두 칸씩 어긋나
// 삐뚤어 보이므로, 위쪽 절반만 정하고 아래쪽은 계산해서 만든다.
//
//        (50+AX, 50-AY)  꼭대기
//              ///             /  //   (50-BX, 50+BY)  ──  (50-CX, 50+BY)     ← 허리 (왼쪽)
//
const AX = num('AX', 8);    // 꼭대기가 가운데서 오른쪽으로 치우친 정도
const AY = num('AY', 40);   // 꼭대기 높이
const BX = num('BX', 28);   // 허리 바깥쪽 폭
const BY = num('BY', 9);    // 허리가 가운데서 벌어진 정도
const CX = num('CX', 3);    // 허리 안쪽 폭

function mirror(p) { return [100 - p[0], 100 - p[1]]; }

const HALF = [
    [50 + AX, 50 - AY],   // 꼭대기
    [50 - BX, 50 + BY],   // 왼쪽 허리 바깥
    [50 - CX, 50 + BY]    // 왼쪽 허리 안쪽
];
const BOLT = process.env.BOLT ? JSON.parse(process.env.BOLT)
                              : [HALF[0], HALF[1], HALF[2],
                                 mirror(HALF[0]), mirror(HALF[1]), mirror(HALF[2])];

const CORNER   = num('CORNER', 3.4);    // 번개 끝을 둥글리는 정도
const FILL     = num('FILL', 0.86);     // 타일에서 차지할 비율
const RADIUS   = 22;                    // 타일 모서리
const TOP      = [46, 204, 113];        // #2ECC71
const BOT      = [30, 148, 82];         // #1E9452
const SHADOW   = [12, 74, 42];          // 번개 밑에 깔 어두운 초록
const SH_DY    = num('SH_DY', 1.6);                   // 그림자를 내릴 거리
const SH_BLUR  = num('SH_BLUR', 3.0);                   // 그림자가 흐려지는 폭
const SH_MAX   = num('SH_MAX', 0.22);                  // 그림자 진하기


// 둥글리기까지 넣어 실제 넓이를 재고, 가운데로 옮긴 뒤 한 번 더 줄인다.
const xs = BOLT.map(p => p[0]), ys = BOLT.map(p => p[1]);
const bx = [Math.min(...xs) - CORNER, Math.max(...xs) + CORNER];
const by = [Math.min(...ys) - CORNER, Math.max(...ys) + CORNER];
const dx = (100 - (bx[1] - bx[0])) / 2 - bx[0];
const dy = (100 - (by[1] - by[0])) / 2 - by[0];
const off = 50 - 50 * FILL;

const P = BOLT.map(p => [(p[0] + dx) * FILL + off, (p[1] + dy) * FILL + off]);
const RAD = CORNER * FILL;

// 좌표를 손으로 고칠 수도 있으니, 그릴 때마다 점대칭인지 스스로 확인한다.
[[0, 3], [1, 4], [2, 5]].forEach(([i, j]) => {
    const sx = BOLT[i][0] + BOLT[j][0], sy = BOLT[i][1] + BOLT[j][1];
    if (Math.abs(sx - 100) > 0.01 || Math.abs(sy - 100) > 0.01) {
        console.error('번개가 점대칭이 아닙니다: (' + BOLT[i] + ') + (' + BOLT[j] +
                      ') = (' + sx + ', ' + sy + ') — (100, 100) 이어야 합니다');
        process.exit(1);
    }
});

// ── 거리 계산 ─────────────────────────────────────────────────────

function distToSeg(px, py, ax, ay, bx2, by2) {
    const vx = bx2 - ax, vy = by2 - ay;
    const wx = px - ax, wy = py - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// 다각형까지의 부호 있는 거리 — 안이면 음수. 여기에 반지름을 더해
// 비교하면 볼록한 꼭짓점만 둥글게 부푼다 (안쪽 꺾임은 날카롭게 남는다).
function sdPoly(px, py) {
    let d = Infinity, inside = false;
    const n = P.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        d = Math.min(d, distToSeg(px, py, P[i][0], P[i][1], P[j][0], P[j][1]));
        const yi = P[i][1], yj = P[j][1], xi = P[i][0], xj = P[j][0];
        if ((yi > py) !== (yj > py) &&
            px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside ? -d : d;
}

function insideRounded(x, y) {
    const ox = Math.max(RADIUS - x, 0, x - (100 - RADIUS));
    const oy = Math.max(RADIUS - y, 0, y - (100 - RADIUS));
    return ox * ox + oy * oy <= RADIUS * RADIUS;
}

const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);

// ── 그리기 ────────────────────────────────────────────────────────
const SS = 4;

function render(size) {
    const buf = Buffer.alloc(size * size * 4);
    const step = 100 / size / SS;

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let hits = 0, bolt = 0, grad = 0, shade = 0;

            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const x = (px * SS + sx + 0.5) * step;
                    const y = (py * SS + sy + 0.5) * step;
                    if (!insideRounded(x, y)) continue;
                    hits++;
                    grad += y / 100;
                    if (sdPoly(x, y) <= RAD) bolt++;
                    // 그림자는 가장자리가 부드러워야 하므로 거리로 직접 재서 섞는다.
                    shade += clamp01(1 - (sdPoly(x, y - SH_DY) - RAD) / SH_BLUR);
                }
            }

            const o = (py * size + px) * 4;
            if (!hits) { buf.writeUInt32LE(0, o); continue; }

            const g = grad / hits;
            const w = bolt / hits;
            const s = (shade / hits) * SH_MAX;

            for (let i = 0; i < 3; i++) {
                let c = TOP[i] + (BOT[i] - TOP[i]) * g;   // 바탕 그러데이션
                c = c * (1 - s) + SHADOW[i] * s;          // 그림자
                c = c * (1 - w) + 255 * w;                // 흰 번개
                buf[o + i] = Math.round(c);
            }
            buf[o + 3] = Math.round(255 * hits / (SS * SS));
        }
    }
    return buf;
}

// ── PNG ───────────────────────────────────────────────────────────
const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}
function toPNG(rgba, size) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 6;
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

// ── ICO ───────────────────────────────────────────────────────────
function buildIco(entries) {
    const head = Buffer.alloc(6);
    head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
    const dir = Buffer.alloc(16 * entries.length);
    let offset = head.length + dir.length;
    entries.forEach((e, i) => {
        const o = i * 16;
        dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
        dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
        dir.writeUInt16LE(1, o + 4);
        dir.writeUInt16LE(32, o + 6);
        dir.writeUInt32LE(e.png.length, o + 8);
        dir.writeUInt32LE(offset, o + 12);
        offset += e.png.length;
    });
    return Buffer.concat([head, dir, ...entries.map(e => e.png)]);
}

// ── 실행 ──────────────────────────────────────────────────────────
if (process.env.PREVIEW) {
    // 시안 확인용 — 큰 그림 하나와 작은 크기들을 확대해 붙인 판
    const big = toPNG(render(256), 256);
    fs.writeFileSync(process.env.PREVIEW, big);
    console.log('  → ' + process.env.PREVIEW);
} else {
    const entries = SIZES.map(size => {
        const png = toPNG(render(size), size);
        console.log('  ' + String(size).padStart(3) + 'px   ' + png.length + ' bytes');
        return { size: size, png: png };
    });
    fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(entries));
    console.log('  → build/icon.ico   (설치 파일 · exe 아이콘)');
    fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'),
                     entries.find(e => e.size === 256).png);
    console.log('  → assets/icon.png  (창 · 트레이 · 알림)');

    const prev = process.env.TMP;
    fs.writeFileSync(path.join(prev, 'bolt-256.png'), entries.find(e => e.size === 256).png);
    [16, 32].forEach(s => {
        const src = render(s), z = 8, w = s * z;
        const out = Buffer.alloc(w * w * 4);
        for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
            const so = (Math.floor(y / z) * s + Math.floor(x / z)) * 4;
            src.copy(out, (y * w + x) * 4, so, so + 4);
        }
        fs.writeFileSync(path.join(prev, 'bolt-' + s + '-zoom.png'), toPNG(out, w));
    });
}
