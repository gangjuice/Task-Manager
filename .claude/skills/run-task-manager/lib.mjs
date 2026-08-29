// Task Manager를 자동으로 띄우고 조작하기 위한 공용 헬퍼.
// driver.mjs(대화형 REPL)와 smoke.mjs(엔드투엔드 시나리오)가 함께 쓴다.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
export const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'task-manager-shots');

export const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');

/** 오늘 기준 offset일의 날짜를 'YYYY-MM-DD'로. */
export const mkDate = off => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function electronBinary() {
  const rel = process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe'
            : process.platform === 'darwin' ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
            : 'node_modules/electron/dist/electron';
  const bin = path.join(PROJECT_ROOT, rel);
  if (!fs.existsSync(bin)) {
    throw new Error(`Electron 바이너리가 없습니다: ${bin}\n` +
      `npm install 이 postinstall 압축 해제를 끝내지 못한 경우입니다. SKILL.md의 "Electron 바이너리 수동 압축 해제" 참고.`);
  }
  return bin;
}

const APP_FILES = ['main.js', 'index.html', 'widget.html', 'quickadd.html', 'package.json'];
const DATA_LINE_OLD = "const dataFilePath = path.join(app.getPath('documents'), '업무관리_데이터.json');";
const DATA_LINE_NEW = "const dataFilePath = process.env.TM_DATA_FILE || path.join(app.getPath('documents'), '업무관리_데이터.json');";

/**
 * 앱 파일을 임시 폴더로 복사하고 저장 경로 한 줄만 env로 우회하도록 고친다.
 * 이렇게 하지 않으면 자동화가 사용자의 진짜 "내 문서\업무관리_데이터.json"을 건드린다.
 */
export function prepareSandbox() {
  const dir = path.join(os.tmpdir(), 'task-manager-sandbox');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of APP_FILES) fs.copyFileSync(path.join(PROJECT_ROOT, f), path.join(dir, f));

  // 트레이 아이콘 등 자산도 함께 옮긴다. 없으면 Tray 생성이 실패한다.
  const assetsSrc = path.join(PROJECT_ROOT, 'assets');
  if (fs.existsSync(assetsSrc)) {
    fs.cpSync(assetsSrc, path.join(dir, 'assets'), { recursive: true });
  }

  // main.js 가 TM_DATA_FILE 환경변수를 직접 지원하므로 더 손댈 것이 없다.
  return dir;
}

export function makeTask(o) {
  return {
    id: o.id, regDate: o.regDate ?? mkDate(0), dueDate: o.dueDate ?? '', content: o.content ?? '',
    category: o.category ?? '기타', firstAction: o.firstAction ?? '', importance: o.importance ?? '높음',
    urgency: o.urgency ?? '높음', priority: o.priority ?? 1, timeReq: o.timeReq ?? '',
    status: o.status ?? '대기중', remarks: o.remarks ?? '', isTodayTask: o.isTodayTask ?? false,
  };
}

export function seedData(dataFile, { tasks = [], categories = ['단가공사', '기타'], memoPadData = '' } = {}) {
  fs.writeFileSync(dataFile, JSON.stringify({ tasks, categories, memoPadData }, null, 2), 'utf8');
  return dataFile;
}

export const readData = dataFile => { try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { return null; } };

/**
 * 앱을 띄운다.
 *   real=false (기본): 임시 폴더 복사본 + 임시 데이터 파일 (사용자 데이터 안전)
 *   real=true        : 프로젝트 폴더 그대로 = 진짜 "내 문서" 데이터를 읽고 쓴다
 */
export async function launchApp({ real = false } = {}) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const appDir = real ? PROJECT_ROOT : prepareSandbox();
  const dataFile = real ? null : path.join(os.tmpdir(), 'task-manager-sandbox-data.json');
  if (dataFile && !fs.existsSync(dataFile)) seedData(dataFile);

  // VSCode/Claude Code 안에서는 ELECTRON_RUN_AS_NODE=1 이 상속된다.
  // 이걸 지우지 않으면 electron.exe가 GUI가 아니라 순수 Node로 떠서
  // "bad option: --remote-debugging-port" / "Cannot find module 'electron'" 로 죽는다.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (dataFile) env.TM_DATA_FILE = dataFile;

  const app = await electron.launch({ executablePath: electronBinary(), args: [appDir], env, timeout: 60_000 });

  // 📌 firstWindow() 를 쓰면 안 된다. 전화 아이콘 창이 먼저 뜨면 그게 잡힌다.
  // 항상 URL 로 메인 창을 특정한다.
  const main = await waitForWindow(app, 'index.html');
  // #masterTableContainer는 비활성 탭 안이라 'visible'이 되지 않는다. 기본 활성 탭의 달력을 기다린다.
  await main.waitForSelector('#calendarGrid', { timeout: 20_000 });
  await sleep(1200);
  return { app, main, appDir, dataFile };
}

/** 특정 창이 뜰 때까지 기다린다. 창이 여러 개라 순서를 믿을 수 없다. */
export async function waitForWindow(app, urlPart, timeout = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const w = app.windows().find(x => x.url().includes(urlPart));
    if (w) return w;
    await sleep(200);
  }
  throw new Error(urlPart + ' 창을 찾지 못했습니다 (' + app.windows().map(w => w.url()).join(', ') + ')');
}

export const widgetPage = app => app.windows().find(w => w.url().includes('widget.html'));
export const quickAddPage = app => app.windows().find(w => w.url().includes('quickadd.html'));

/** 빠른 등록 창을 뺀 '문서 창'만. 창 개수를 셀 때 쓴다. */
export const docWindows = app => app.windows().filter(w => !w.url().includes('quickadd.html'));

/**
 * CDP 키보드(page.keyboard.type)는 Electron 창의 OS 포커스에 의존해서 입력이 통째로 유실된다.
 * 실제 사용자 입력과 동일하게 글자마다 input 이벤트를 발생시켜 앱 리스너를 그대로 태운다.
 */
export const typeInto = (page, sel, text, delay = 40) => page.evaluate(async ({ sel, text, delay }) => {
  const el = document.querySelector(sel);
  if (!el) return 'NOT_FOUND';
  el.focus();
  for (const ch of text) {
    el.value += ch;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, delay));
  }
  return el.value;
}, { sel, text, delay });

/** 탭 이동: 0=대시보드 1=생각나는대로 적기 2=마스터 3=오늘 할 일 4=연락처 5=접수 관리 6=완료 7=설정 */
export const switchTab = (page, i) => page.evaluate(i => document.querySelectorAll('.tab-btn')[i].click(), i);
