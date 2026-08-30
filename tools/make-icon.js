// 육각 통제 패널 아이콘 — 초록 둥근 사각형 + 육각 패널
//
// 브라우저를 거치지 않고 픽셀을 직접 계산한다. 크기마다 새로 그리므로
// 16px 에서도 흐려지지 않는다.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = process.argv[2] || '.';
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function num(k, d) { return process.env[k] ? parseFloat(process.env[k]) : d; }
function str(k, d) { return process.env[k] || d; }
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

// ── 색 ────────────────────────────────────────────────────────────
const TOP  = hex(str('TOP',  '#12A85A'));   // 바탕 위
const BOT  = hex(str('BOT',  '#0A5F35'));   // 바탕 아래
const P1   = hex(str('P1',   '#FFFFFF'));   // 바깥 육각 · 살
const P2   = hex(str('P2',   '#FFD400'));   // 안쪽 육각 · 중심점

const RADIUS = 22;
const FILL   = num('FILL', 1.0);

// ── 모양 (100 x 100 칸 기준) ──────────────────────────────────────
// 정육각형은 꼭짓점 여섯 개를 60도 간격으로 찍어 만든다. 손으로 적으면
// 반드시 어긋나므로 계산해서 만든다 (번개에서 같은 실수를 했다).
function hexPts(r) {
    const out = [];
    for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (90 + i * 60);      // 위 꼭짓점부터 시작
        out.push([50 + r * Math.cos(a), 50 - r * Math.sin(a)]);
    }
    return out;
}

// 📌 세 겹(바깥 육각 · 안쪽 육각 · 중심점)을 16px 안에 다 넣으면 서로 뭉쳐
// 그냥 동그란 얼룩이 된다. 크기마다 따로 그리므로, 작을수록 겹을 덜어내고
// 남는 것을 굵게 키운다. 상용 아이콘 세트가 쓰는 방법이다.
function geomFor(size) {
    if (size >= 64) return { inner: true,  rOut: 33, wOut: 4.6, wIn: 3.2, wSpk: 3.0, dot: 4.6 };
    if (size >= 48) return { inner: true,  rOut: 33, wOut: 5.4, wIn: 3.6, wSpk: 3.4, dot: 4.8 };
    if (size >= 32) return { inner: true,  rOut: 33, wOut: 6.6, wIn: 4.2, wSpk: 4.0, dot: 4.8 };
    if (size >= 24) return { inner: false, rOut: 32, wOut: 8.5, dot: 8.0 };
    return                 { inner: false, rOut: 31, wOut: 10,  dot: 8.5 };
}

const OUT_PTS = {};   // 반지름별 육각형은 한 번만 만들어 둔다
function outer(r) { return OUT_PTS[r] || (OUT_PTS[r] = hexPts(r)); }
const IN_PTS = hexPts(num('R_IN', 17));
// 살 — 위 꼭짓점과 아래 양옆 꼭짓점에서 안쪽 육각으로 잇는다.
const SPOKE_IDX = [0, 2, 4];

// ── 거리 ──────────────────────────────────────────────────────────
function distToSeg(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// 다각형 테두리까지의 거리. 이 값이 굵기의 절반 이하면 선 위다
// (모서리가 저절로 둥글게 이어진다).
function distToRing(pts, px, py) {
    let d = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
        d = Math.min(d, distToSeg(px, py, pts[i][0], pts[i][1], pts[j][0], pts[j][1]));
    return d;
}

function insideRounded(x, y) {
    const ox = Math.max(RADIUS - x, 0, x - (100 - RADIUS));
    const oy = Math.max(RADIUS - y, 0, y - (100 - RADIUS));
    return ox * ox + oy * oy <= RADIUS * RADIUS;
}

// 이 점이 어느 색인지 — 0 바탕, 1 바깥(P1), 2 안쪽(P2)
function inkAt(g, x, y) {
    if (distToRing(outer(g.rOut), x, y) <= g.wOut / 2) return 1;
    if (g.inner) {
        for (const i of SPOKE_IDX) {
            const a = outer(g.rOut)[i], b = IN_PTS[i];
            if (distToSeg(x, y, a[0], a[1], b[0], b[1]) <= g.wSpk / 2) return 1;
        }
    }
    if (Math.hypot(x - 50, y - 50) <= g.dot) return 2;
    if (g.inner && distToRing(IN_PTS, x, y) <= g.wIn / 2) return 2;
    return 0;
}

// ── 그리기 ────────────────────────────────────────────────────────
const SS = num('SS', 12);

function render(size) {
    const buf = Buffer.alloc(size * size * 4);
    const step = 100 / size / SS;
    const g = geomFor(size);

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let hits = 0, grad = 0, a1 = 0, a2 = 0;

            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const x = (px * SS + sx + 0.5) * step;
                    const y = (py * SS + sy + 0.5) * step;
                    if (!insideRounded(x, y)) continue;
                    hits++;
                    grad += y / 100;
                    const k = inkAt(g, x, y);
                    if (k === 1) a1++; else if (k === 2) a2++;
                }
            }

            const o = (py * size + px) * 4;
            if (!hits) { buf.writeUInt32LE(0, o); continue; }

            const gv = grad / hits, f1 = a1 / hits, f2 = a2 / hits;
            for (let i = 0; i < 3; i++) {
                let c = TOP[i] + (BOT[i] - TOP[i]) * gv;
                c = c * (1 - f1) + P1[i] * f1;
                c = c * (1 - f2) + P2[i] * f2;
                buf[o + i] = Math.round(c);
            }
            buf[o + 3] = Math.round(255 * hits / (SS * SS));
        }
    }
    return buf;
}

// ── PNG / ICO ─────────────────────────────────────────────────────
const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
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
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}
function buildIco(entries) {
    const head = Buffer.alloc(6);
    head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
    const dir = Buffer.alloc(16 * entries.length);
    let offset = head.length + dir.length;
    entries.forEach((e, i) => {
        const o = i * 16;
        dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
        dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
        dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
        dir.writeUInt32LE(e.png.length, o + 8);
        dir.writeUInt32LE(offset, o + 12);
        offset += e.png.length;
    });
    return Buffer.concat([head, dir, ...entries.map(e => e.png)]);
}

function zoom(size, z) {
    const src = render(size), w = size * z;
    const out = Buffer.alloc(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
        const so = (Math.floor(y / z) * size + Math.floor(x / z)) * 4;
        src.copy(out, (y * w + x) * 4, so, so + 4);
    }
    return toPNG(out, w);
}

// ── 실행 ──────────────────────────────────────────────────────────
if (process.env.PREVIEW) {
    const p = process.env.PREVIEW;
    fs.writeFileSync(p + '-256.png', toPNG(render(256), 256));
    fs.writeFileSync(p + '-32z.png', zoom(32, 8));
    fs.writeFileSync(p + '-16z.png', zoom(16, 14));
    console.log('  → ' + p + '-{256,32z,16z}.png');
} else {
    const entries = SIZES.map(size => {
        const png = toPNG(render(size), size);
        console.log('  ' + String(size).padStart(3) + 'px   ' + png.length + ' bytes');
        return { size: size, png: png };
    });
    fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(entries));
    console.log('  → build/icon.ico   (설치 파일 · exe 아이콘)');
    // 📌 build/ 는 electron-builder 의 재료 폴더라 앱 안으로 안 들어간다.
    fs.writeFileSync(path.join(ROOT, 'assets', 'icon.ico'), buildIco(entries));
    console.log('  → assets/icon.ico  (창 · 트레이 — 크기별로 다 들어 있다)');
    fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), entries.find(e => e.size === 256).png);
    console.log('  → assets/icon.png  (알림 · 윈도우 밖 환경)');
}
