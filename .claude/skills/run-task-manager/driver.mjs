// Task Manager 대화형 드라이버.
// stdin으로 명령을 한 줄씩 받아 실행한다. 파이프로 넣어도 순서대로 처리된다.
//   node .claude/skills/run-task-manager/driver.mjs <<'CMDS'
//   launch
//   ss 01
//   quit
//   CMDS
import * as readline from 'node:readline';
import * as path from 'node:path';
import { launchApp, widgetPage, typeInto, switchTab, readData, seedData, makeTask, mkDate, sleep, SHOT_DIR } from './lib.mjs';

let app = null, main = null, page = null, dataFile = null;

const need = () => { if (!page) { console.log('ERROR: 먼저 launch 하세요'); return false; } return true; };

const COMMANDS = {
  async launch(arg) {
    if (app) return console.log('이미 실행 중입니다');
    const real = (arg || '').trim() === '--real';
    if (real) console.log('⚠️  --real: 사용자의 실제 "내 문서" 데이터를 읽고 씁니다');
    ({ app, main, dataFile } = await launchApp({ real }));
    page = main;
    console.log(`실행됨. 창 ${app.windows().length}개. 데이터 파일: ${dataFile ?? '(실제 내 문서)'}`);
  },

  // 앱은 시작할 때 데이터를 한 번만 읽는다. seed 후에는 restart 해야 화면에 반영된다.
  async seed() {
    if (!dataFile) return console.log('ERROR: --real 모드에서는 시드할 수 없습니다');
    seedData(dataFile, { tasks: [
      makeTask({ id: 1, dueDate: mkDate(-1), content: '어제마감', priority: 1, importance: '높음', urgency: '높음' }),
      makeTask({ id: 2, dueDate: mkDate(0),  content: '오늘마감', priority: 3, importance: '높음', urgency: '낮음' }),
      makeTask({ id: 3, dueDate: mkDate(1),  content: '내일마감', priority: 2, importance: '낮음', urgency: '높음' }),
      makeTask({ id: 4, dueDate: mkDate(7),  content: '일주일뒤', priority: 4, importance: '낮음', urgency: '낮음' }),
    ] });
    console.log('시드 완료 — restart 하면 반영됩니다');
  },

  async restart() {
    if (app) await app.close().catch(() => {});
    app = main = page = null;
    await COMMANDS.launch('');
  },

  async use(which) {
    if (!app) return console.log('ERROR: 먼저 launch 하세요');
    if ((which || '').trim() === 'widget') {
      const w = widgetPage(app);
      if (!w) return console.log('위젯 창이 없습니다. click-text 달력 위젯 띄우기');
      page = w; console.log('대상: 위젯');
    } else { page = main; console.log('대상: 메인'); }
  },

  async tab(i)     { if (need()) { await switchTab(page, Number(i)); console.log('탭', i); } },
  async ss(name)   { if (need()) { const f = path.join(SHOT_DIR, ((name || '').trim() || `ss-${Date.now()}`) + '.png'); await page.screenshot({ path: f }); console.log('screenshot:', f); } },
  async click(sel) { if (need()) console.log('click', sel, '->', await page.evaluate(s => { const el = document.querySelector(s); if (!el) return 'NOT_FOUND'; el.click(); return 'OK'; }, sel)); },

  async 'click-text'(text) {
    if (!need()) return;
    console.log('click-text', JSON.stringify(text), '->', await page.evaluate(t => {
      const els = [...document.querySelectorAll('button, a, [role="button"], li')];
      const el = els.find(e => e.textContent?.trim() === t) ?? els.find(e => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK: ' + el.tagName;
    }, text));
  },

  async type(rest) {
    if (!need()) return;
    const i = (rest || '').indexOf(' ');
    if (i < 0) return console.log('사용법: type <css-선택자> <문자열>');
    console.log('type ->', await typeInto(page, rest.slice(0, i), rest.slice(i + 1)));
  },

  // textarea/input은 innerText가 비어 있으므로 value를 읽는다.
  async text(sel)  { if (need()) console.log(await page.evaluate(s => { const el = s ? document.querySelector(s) : document.body; if (!el) return '(null)'; return ('value' in el) ? el.value : el.innerText; }, (sel || '').trim() || null)); },
  async eval(expr) { if (need()) { try { console.log(JSON.stringify(await page.evaluate(expr))); } catch (e) { console.log('ERROR:', e.message); } } },

  async rows() {
    if (!need()) return;
    console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('#masterTable tbody tr')].map(tr => {
      const td = tr.querySelectorAll('td');
      return { dday: td[3]?.innerText.trim(), content: td[4]?.innerText.trim(), 우선순위: td[9]?.innerText.trim() };
    })), null, 2));
  },

  async data()    { console.log(dataFile ? JSON.stringify(readData(dataFile), null, 2) : '(--real 모드: 내 문서 파일)'); },
  async windows() { if (app) for (const w of app.windows()) console.log(' -', w.url()); },
  async sleep(ms) { await sleep(Number(ms) || 500); },
  async quit()    { if (app) await app.close().catch(() => {}); app = main = page = null; },
  help()          { console.log('명령:', Object.keys(COMMANDS).join(', ')); },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' });
let chain = Promise.resolve();
let closed = false;

// 파이프로 명령을 넣으면 마지막 줄을 읽자마자 stdin이 닫힌다.
// 남은 명령은 큐에 그대로 있으므로 프롬프트 출력만 막고 큐는 끝까지 처리한다.
const prompt = () => { if (!closed) rl.prompt(); };

rl.on('line', line => {
  chain = chain.then(async () => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return prompt();
    const sp = t.indexOf(' ');
    const cmd = sp < 0 ? t : t.slice(0, sp);
    const rest = sp < 0 ? '' : t.slice(sp + 1);
    const fn = COMMANDS[cmd];
    if (!fn) { console.log('알 수 없는 명령:', cmd, '- help 를 쳐보세요'); return prompt(); }
    try { await fn.call(null, rest); } catch (e) { console.log('ERROR:', e.message); }
    if (cmd === 'quit') { closed = true; rl.close(); return; }
    prompt();
  });
});

rl.on('close', () => {
  closed = true;
  chain = chain.then(async () => { await COMMANDS.quit(); process.exit(0); });
});

console.log('Task Manager driver - "help" 로 명령 목록, "launch" 로 시작');
prompt();
