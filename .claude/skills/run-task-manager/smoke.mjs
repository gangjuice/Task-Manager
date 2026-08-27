// Task Manager 엔드투엔드 시나리오.
// 앱을 띄워 D-day 표시 / 메모 디바운스 저장 / 위젯↔메인 동기화를 실제 UI에서 검증한다.
//   node .claude/skills/run-task-manager/smoke.mjs
// 통과하면 exit 0, 하나라도 실패하면 exit 1. 스크린샷은 SHOT_DIR에 남는다.
import * as fs from 'node:fs';
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

// ── 4) 섹션 병합 저장 — 남의 섹션을 덮어쓰지 않는가 (1단계의 핵심 보증) ──
// 앱이 모르는 섹션을 디스크에 직접 넣어두고, 창이 자기 섹션을 저장했을 때 살아남는지 본다.
// 예전의 '문서 전체 덮어쓰기' 방식이었다면 이 섹션은 그 순간 사라진다.
const before = readData(dataFile);
before.contacts = [{ id: 1, name: '병합테스트' }];
fs.writeFileSync(dataFile, JSON.stringify(before, null, 2), 'utf8');

await typeInto(main2, '#memoPad', '@');
await sleep(1200);

const merged = readData(dataFile);
check('창이 모르는 섹션이 살아남음', merged?.contacts?.[0]?.name === '병합테스트',
  `contacts=${JSON.stringify(merged?.contacts)}`);
check('내가 소유한 섹션은 정상 저장', typeof merged?.memoPadData === 'string' && merged.memoPadData.endsWith('@'),
  `memoPadData=${JSON.stringify(merged?.memoPadData)}`);
check('기존 업무 섹션도 그대로', Array.isArray(merged?.tasks) && merged.tasks.length === 4,
  `tasks ${merged?.tasks?.length}건`);


// ── 4.5) 연락처 ────────────────────────────────────────────────
await switchTab(main2, 4);            // 0 대시보드 1 메모 2 마스터 3 오늘 4 연락처 5 완료 6 설정
await sleep(400);

// 등록: 번호는 하이픈을 넣어 치고, 저장은 숫자만 되어야 한다
await main2.evaluate(() => openContactForm(null));
await sleep(300);
await main2.evaluate(() => {
  document.getElementById('cf_name').value = '김철수';
  document.getElementById('cf_title').value = '주무관';
  document.getElementById('cf_org').value = '△△시청 도로과';
  document.getElementById('cf_tag').value = '발주처';
  document.getElementById('cf_firstNote').value = '착공계 관련 첫 통화';
});
await typeInto(main2, '#cf_phones input', '010-1234-5678', 15);
await main2.evaluate(() => { document.getElementById('cf_projectInput').value = '신정로 단가공사'; addDraftProject(); });
await main2.evaluate(() => saveContactForm());
await sleep(900);

const saved = readData(dataFile)?.contacts?.[0];
check('연락처가 저장됨', saved?.name === '김철수', `name=${saved?.name}`);
check('번호가 숫자만으로 정규화됨', saved?.phones?.[0]?.value === '01012345678', `value=${saved?.phones?.[0]?.value}`);
check('첫 기록이 로그로 쌓임', saved?.notes?.length === 1, `notes=${saved?.notes?.length}`);
check('소속/프로젝트가 목록에 자동 등록됨',
  readData(dataFile)?.orgs?.includes('△△시청 도로과') && readData(dataFile)?.projects?.includes('신정로 단가공사'));

const shown = await main2.evaluate(() => {
  const tr = document.querySelector('#contactTable tbody tr');
  return tr ? tr.innerText.replace(/\s+/g, ' ') : null;
});
check('목록에 하이픈 붙은 형태로 표시됨', !!shown && shown.includes('010-1234-5678'), `행=${shown}`);
await shot(main2, '06-contacts');

// 중복 감지: 같은 번호를 하이픈 없이 쳐도 잡아야 한다
await main2.evaluate(() => openContactForm(null));
await sleep(300);
await typeInto(main2, '#cf_phones input', '01012345678', 15);
await sleep(400);
check('같은 번호를 다시 넣으면 경고',
  await main2.evaluate(() => document.getElementById('cf_dupWarn').style.display === 'block'));
await main2.evaluate(() => closeContactForm());

// 검색: 하이픈 없이 숫자로 찾기
await typeInto(main2, '#contactSearch', '12345678', 15);
await sleep(400);
check('숫자만으로 검색됨',
  await main2.evaluate(() => document.querySelectorAll('#contactTable tbody tr').length) === 1);
await main2.evaluate(() => { document.getElementById('contactSearch').value = ''; setContactSearch(''); });

// 기록 추가 → lastNoteAt 이 오늘로
const cid = saved.id;
await main2.evaluate(id => openContactDetail(id), cid);
await sleep(300);
await typeInto(main2, '#cd_newNote', '준공서류 8/30까지 요청', 15);
await main2.evaluate(() => addContactNote());
await sleep(900);
let c = readData(dataFile).contacts.find(x => x.id === cid);
check('기록이 누적됨(덮어쓰지 않음)', c.notes.length === 2, `notes=${c.notes.length}`);
check('마지막 기록일이 오늘로 갱신', c.lastNoteAt === mkDate(0), `lastNoteAt=${c.lastNoteAt}`);

// 같은 분 안에 두 번 적어도 최신이 위로 와야 한다 (통화 중엔 흔한 일)
await typeInto(main2, '#cd_newNote', '두 번째 기록', 10);
await main2.evaluate(() => addContactNote());
await sleep(700);
const firstShown = await main2.evaluate(() => document.querySelector('#cd_notes .note-text')?.innerText);
check('같은 분에 적은 기록도 최신이 맨 위', firstShown === '두 번째 기록', `맨 위=${firstShown}`);

await main2.evaluate(() => closeContactDetail());

// 이름을 고쳐도 '마지막 기록일'은 그대로여야 한다 (정리 기준이 흔들리면 안 됨)
await main2.evaluate(id => openContactForm(id), cid);
await sleep(300);
await main2.evaluate(() => { document.getElementById('cf_name').value = '김철수(수정)'; saveContactForm(); });
await sleep(900);
c = readData(dataFile).contacts.find(x => x.id === cid);
check('이름 수정은 마지막 기록일을 건드리지 않음',
  c.name === '김철수(수정)' && c.lastNoteAt === mkDate(0), `name=${c.name} lastNoteAt=${c.lastNoteAt}`);

// 설정에서 구분 이름을 바꾸면 쓰던 연락처도 따라간다
await switchTab(main2, 6);
await sleep(300);
await main2.evaluate(() => startRename('tags', 0));
await main2.evaluate(() => {
  document.getElementById('renameInput').value = '발주처A';
  commitRename('tags', 0);
});
await sleep(900);
c = readData(dataFile).contacts.find(x => x.id === cid);
check('구분 이름을 바꾸면 연락처도 따라감', c.tag === '발주처A', `tag=${c.tag}`);

// 보관하면 기본 목록에서 사라진다
await switchTab(main2, 4);
await sleep(300);
await main2.evaluate(id => { contactContextId = id; contactMenuArchive(); }, cid);
await sleep(900);
check('보관하면 기본 목록에서 빠짐',
  await main2.evaluate(() => document.querySelectorAll('#contactTable tbody tr').length) === 0);
await main2.evaluate(() => { document.getElementById('showArchivedCheckbox').checked = true; toggleArchivedView(); });
await sleep(300);
check('보관함 보기로는 다시 보임',
  await main2.evaluate(() => document.querySelectorAll('#contactTable tbody tr').length) === 1);
check('보관은 삭제가 아님', readData(dataFile).contacts.length === 1);
await main2.evaluate(() => { document.getElementById('showArchivedCheckbox').checked = false; toggleArchivedView(); });

// ── 5) 트레이 상주 — 메인 창을 닫아도 앱이 죽지 않는가 (2단계의 핵심 보증) ──
// 앱이 Tray 생성에 실패했다면 여기까지 오지도 못한다(실행 자체가 죽는다).
await app2.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
await sleep(1500);

let alive = null;
try {
  alive = await app2.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().length,
    visible: BrowserWindow.getAllWindows().map(w => w.isVisible()),
  }));
} catch (e) {
  // evaluate가 실패했다는 건 앱이 종료됐다는 뜻이다 = 예전 동작
}
check('메인 창을 닫아도 앱이 살아있음', alive !== null, alive === null ? '앱이 종료됨' : '');
check('닫은 창은 파괴되지 않고 숨겨짐', alive?.windows === 1 && alive?.visible[0] === false,
  `창 ${alive?.windows}개 visible=${JSON.stringify(alive?.visible)}`);

// 숨어 있는 상태에서 위젯만 띄웠다 닫으면, 메인 창이 갑자기 튀어나오면 안 된다.
// 앱이 이미 죽었다면(= 트레이 상주 실패) 여기서 크래시하지 말고 FAIL로 남긴다.
if (!alive) {
  check('숨은 상태에서도 위젯은 열림', false, '앱이 이미 종료되어 확인 불가');
  check('위젯을 닫아도 숨은 메인 창이 튀어나오지 않음', false, '앱이 이미 종료되어 확인 불가');
} else {
  await main2.evaluate(() => require('electron').ipcRenderer.send('open-widget'));
  await sleep(2500);
  const widget2 = widgetPage(app2);
  check('숨은 상태에서도 위젯은 열림', !!widget2);
  if (widget2) {
    await widget2.evaluate(() => window.close());
    await sleep(1500);
    const still = await app2.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.isVisible()));
    check('위젯을 닫아도 숨은 메인 창이 튀어나오지 않음', still.length === 1 && still[0] === false,
      `visible=${JSON.stringify(still)}`);
  } else {
    check('위젯을 닫아도 숨은 메인 창이 튀어나오지 않음', false, '위젯이 열리지 않아 확인 불가');
  }
}

await app2.close().catch(() => {});
const failed = results.filter(r => !r.pass).length;
console.log(`\n===== ${results.length - failed}/${results.length} 통과 =====`);
console.log('스크린샷:', SHOT_DIR);
process.exit(failed ? 1 : 0);
