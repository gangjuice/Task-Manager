// Task Manager 엔드투엔드 시나리오.
// 앱을 띄워 D-day 표시 / 메모 디바운스 저장 / 위젯↔메인 동기화를 실제 UI에서 검증한다.
//   node .claude/skills/run-task-manager/smoke.mjs
// 통과하면 exit 0, 하나라도 실패하면 exit 1. 스크린샷은 SHOT_DIR에 남는다.
import * as path from 'node:path';
import { launchApp, widgetPage, typeInto, switchTab, seedData, readData, makeTask, mkDate, sleep, SHOT_DIR } from './lib.mjs';

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`); };
const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });

const { app, main, dataFile } = await launchApp();
const memo = () => readData(dataFile)?.memoPadData;

// 앱은 시작할 때 데이터를 한 번만 읽으므로, 시드 후 재시작해서 반영시킨다.
seedData(dataFile, { tasks: [
  makeTask({ id: 1, dueDate: mkDate(-1), content: '어제마감', priority: 1, importance: '높음', urgency: '높음' }),
  makeTask({ id: 2, dueDate: mkDate(0),  content: '오늘마감', priority: 3, importance: '높음', urgency: '낮음' }),
  makeTask({ id: 3, dueDate: mkDate(1),  content: '내일마감', priority: 2, importance: '낮음', urgency: '높음' }),
  makeTask({ id: 4, dueDate: mkDate(7),  content: '일주일뒤', priority: 4, importance: '낮음', urgency: '낮음' }),
] });
await app.close().catch(() => {});
const { app: app2, main: main2 } = await launchApp();
console.log('앱 실행됨. 창', app2.windows().length + '개');
await shot(main2, '01-dashboard');

// ── 1) D-day 표시 (로컬 자정 기준으로 정확한가) ──
await switchTab(main2, 2);
await sleep(500);
await shot(main2, '02-master');
const rows = await main2.evaluate(() => [...document.querySelectorAll('#masterTable tbody tr')].map(tr => {
  const td = tr.querySelectorAll('td');
  return { content: td[4].innerText.trim(), dday: td[3].innerText.trim() };
}));
for (const [content, want] of Object.entries({ '어제마감': 'D+1', '오늘마감': 'D-day', '내일마감': 'D-1', '일주일뒤': 'D-7' })) {
  const row = rows.find(r => r.content === content);
  check(`D-day: ${content}`, row?.dday === want, `기대 ${want} / 실제 ${row?.dday}`);
}

// ── 2) 메모 디바운스 저장 (글자마다 저장하지 않는가) ──
await switchTab(main2, 1);
await sleep(300);
let writes = 0, last = memo();
const poll = setInterval(() => { const cur = memo(); if (cur !== last) { writes++; last = cur; } }, 25);

const TYPED = '디바운스 저장 테스트입니다';
check('메모 입력됨', (await typeInto(main2, '#memoPad', TYPED)) === TYPED);
check('타이핑 직후엔 아직 디스크에 안 씀', memo() !== TYPED, `디스크=${JSON.stringify(memo())}`);
await sleep(1000);
clearInterval(poll);
check('0.5초 후 디스크에 저장됨', memo() === TYPED, `디스크=${JSON.stringify(memo())}`);
check(`파일 쓰기 ≤ 3회 (글자 수 ${TYPED.length}회가 아님)`, writes <= 3, `관측된 쓰기 ${writes}회`);
await shot(main2, '03-memo');

// ── 3) 위젯 ↔ 메인 동기화 ──
await main2.evaluate(() => document.querySelectorAll('.header-container button')[1].click());
await sleep(3000);
const widget = widgetPage(app2);
check('위젯 창이 열림', !!widget, `창 ${app2.windows().length}개`);

if (widget) {
  await widget.waitForSelector('#widgetMemo', { timeout: 10_000 });
  await sleep(1000);
  await shot(widget, '04-widget');
  check('위젯이 메인의 메모를 이어받음', (await widget.evaluate(() => document.getElementById('widgetMemo').value)) === TYPED);
  check('위젯 달력에 업무 점이 찍힘', (await widget.evaluate(() => document.querySelectorAll('#grid .dot').length)) >= 2);

  // 메인 창은 숨겨져 있어도 activeElement가 memoPad로 남는다.
  // 예전 가드(activeElement 비교)에서는 여기서 위젯 내용이 메인에 반영되지 않고 다음 입력 때 덮여 사라졌다.
  const ADDED = ' +위젯에서추가';
  await typeInto(widget, '#widgetMemo', ADDED);
  await sleep(1200);
  check('위젯 → 메인 메모 동기화', (await main2.evaluate(() => document.getElementById('memoPad').value)) === TYPED + ADDED);
  check('위젯 입력도 디스크에 반영', memo() === TYPED + ADDED, `디스크=${JSON.stringify(memo())}`);

  // 메인에서 한 글자 더 쳤을 때 위젯이 적은 내용이 살아남는가 (데이터 손실 회귀 방지)
  await typeInto(main2, '#memoPad', '!');
  await sleep(1200);
  check('메인 재입력 후에도 위젯 내용 보존', memo() === TYPED + ADDED + '!', `디스크=${JSON.stringify(memo())}`);

  await widget.evaluate(() => returnToMain());
  await sleep(2000);
  check('위젯 닫으면 메인 창만 남음', app2.windows().length === 1, `창 ${app2.windows().length}개`);
  await shot(main2, '05-back-to-main');
}

await app2.close().catch(() => {});
const failed = results.filter(r => !r.pass).length;
console.log(`\n===== ${results.length - failed}/${results.length} 통과 =====`);
console.log('스크린샷:', SHOT_DIR);
process.exit(failed ? 1 : 0);
