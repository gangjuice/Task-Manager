---
name: run-task-manager
description: Build, launch, and drive the Task Manager Electron desktop app on Windows. Use when asked to run/start/launch the app, take a screenshot of it, click through its UI, verify a change in the real app, or run its end-to-end smoke test. 앱 실행, 띄우기, 스크린샷, UI 조작, 변경사항 실제 확인에 사용.
---

Task Manager는 빌드 단계가 없는 순수 바닐라 Electron 앱입니다(`main.js` + `index.html` + `widget.html`).
자동화는 `playwright-core`의 `_electron`으로 붙습니다. **Windows에서 실제 디스플레이로 실행**하므로 xvfb는 필요 없습니다.

에이전트용 진입점은 두 개입니다:

| 파일 | 용도 |
|---|---|
| `.claude/skills/run-task-manager/smoke.mjs` | D-day / 메모 저장 / 위젯 동기화 / 섹션 병합 / 트레이 상주 / 연락처 / 빠른 입력을 한 번에 검증 (49개 체크) |
| `.claude/skills/run-task-manager/driver.mjs` | 명령을 한 줄씩 받아 앱을 조작하는 드라이버 (클릭·입력·스크린샷) |

두 파일 모두 `lib.mjs`를 씁니다. **아래 경로는 전부 프로젝트 루트 기준입니다.**

> ⚠️ 이 앱은 데이터를 `내 문서\업무관리_데이터.json`에 저장합니다. 드라이버는 기본적으로
> 앱 파일을 `%TEMP%\task-manager-sandbox`로 복사하고 저장 경로만 `TM_DATA_FILE`로 우회해서 띄웁니다.
> **사용자의 실제 데이터는 건드리지 않습니다.** 진짜 데이터로 띄우려면 `launch --real`을 쓰세요.

## Prerequisites

```bash
npm install
npm install --no-save playwright-core
```

`playwright-core`는 `package.json`에 없습니다(자동화 전용이라 `--no-save`).

### Electron 바이너리 수동 압축 해제

`npm install`이 exit 0으로 끝나도 `node_modules/electron/dist/`에 `locales`만 남고
`electron.exe`가 없는 경우가 있습니다(postinstall 압축 해제 실패). zip은 캐시에 이미 받아져 있으니 직접 풉니다 — PowerShell:

```powershell
$root = "c:\Users\JHY\OneDrive\바탕 화면\Code\TASK MANAGER\task-manager"
$dest = Join-Path $root "node_modules\electron\dist"
if (-not (Test-Path (Join-Path $dest "electron.exe"))) {
  $ver = (Get-Content (Join-Path $root "node_modules\electron\package.json") | ConvertFrom-Json).version
  $zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter "electron-v$ver-win32-x64.zip" | Select-Object -First 1
  Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip.FullName, $dest)
  Set-Content -Path (Join-Path $root "node_modules\electron\path.txt") -Value "electron.exe" -NoNewline -Encoding ascii
}
```

`-Encoding ascii`가 중요합니다. `utf8`을 쓰면 BOM이 붙어 `npx electron .`이 깨집니다(Gotchas 참고).

## Run (agent path)

### 전체 시나리오 검증

```bash
node .claude/skills/run-task-manager/smoke.mjs
```

통과하면 exit 0, 하나라도 실패하면 exit 1. 스크린샷은 `%TEMP%\task-manager-shots\`에 남습니다
(`SCREENSHOT_DIR` 환경변수로 변경 가능). 약 40초 걸립니다.

### 직접 조작

명령을 파이프로 넣습니다. 순서대로 처리됩니다:

```bash
node .claude/skills/run-task-manager/driver.mjs <<'CMDS'
launch
seed
restart
tab 2
rows
ss 10-master
click-text 달력 위젯 띄우기
sleep 3000
use widget
text #widgetMemo
ss 11-widget
quit
CMDS
```

| 명령 | 하는 일 |
|---|---|
| `launch [--real]` | 앱 실행. `--real`은 사용자의 실제 내 문서 데이터를 씁니다 |
| `seed` | 어제/오늘/내일/일주일뒤 마감 업무 4건을 데이터 파일에 넣음 |
| `restart` | 앱 재시작 (앱은 시작할 때 데이터를 한 번만 읽음 — `seed` 후 필수) |
| `tab <n>` | 0=대시보드 1=생각나는대로 적기 2=마스터 3=오늘 할 일 4=연락처 5=완료 6=설정 |
| `use main\|widget` | 이후 명령을 어느 창에 보낼지 지정 |
| `ss [이름]` | 스크린샷 → `%TEMP%\task-manager-shots\<이름>.png` |
| `click <css>` / `click-text <문자열>` | 클릭 (DOM `.click()`) |
| `type <css> <문자열>` | 글자마다 `input` 이벤트를 발생시키며 입력 |
| `text [css]` / `eval <js>` | innerText(또는 input value) 출력 / 페이지에서 JS 평가 |
| `rows` | 마스터 리스트를 `{dday, content, 우선순위}` 배열로 출력 |
| `data` | 현재 데이터 파일 JSON 출력 |
| `windows` | 열린 창 URL 목록 |
| `sleep <ms>` / `quit` | 대기 / 종료 |

## Run (human path)

```bash
npx electron .
```

창이 뜨고 **사용자의 실제 데이터**를 읽습니다. Ctrl-C 또는 창을 닫으면 종료됩니다.
Claude Code 안에서 실행한다면 `env -u ELECTRON_RUN_AS_NODE npx electron .` 로 실행하세요(아래 참고).

설치 파일(NSIS) 빌드는 main 푸시 때 `.github/workflows/build.yml`이 수행합니다.
로컬 `npm run build`는 이 스킬에서 검증하지 않았습니다.

## Gotchas

- **`ELECTRON_RUN_AS_NODE=1`이 상속됩니다.** VSCode/Claude Code 안에서는 이 환경변수가 살아 있어서
  `electron.exe`가 GUI 대신 순수 Node로 뜹니다. 증상은 `Cannot find module 'electron'`,
  `bad option: --remote-debugging-port`, playwright의 `Process failed to launch!`. `lib.mjs`가 지우고 실행하지만,
  직접 electron을 띄운다면 반드시 `delete env.ELECTRON_RUN_AS_NODE` 하세요.
- **`path.txt`에 BOM이 들어가면 안 됩니다.** PowerShell 5.1의 `Set-Content -Encoding utf8`은 BOM을 붙입니다.
  그러면 `spawn ...\node_modules\electron\dist\﻿electron.exe ENOENT`처럼 경로에 보이지 않는 문자가 낀 에러가 납니다.
  playwright는 경로를 직접 주므로 영향이 없고, `npx electron .`만 깨져서 원인 찾기가 어렵습니다.
- **`page.keyboard.type()`은 입력이 통째로 유실됩니다.** Electron 창의 OS 포커스에 의존하기 때문입니다.
  `lib.mjs`의 `typeInto()`는 글자마다 `input` 이벤트를 직접 발생시켜 앱 리스너를 그대로 태웁니다. 이걸 쓰세요.
- **`waitForSelector('#masterTableContainer')`는 절대 visible이 안 됩니다.** 비활성 탭(`display:none`) 안에 있습니다.
  기본 활성 탭의 `#calendarGrid`를 기다리거나 `{ state: 'attached' }`를 쓰세요.
- **앱은 데이터 파일을 시작할 때 한 번만 읽습니다.** 파일을 고쳐도 실행 중인 앱에는 반영되지 않습니다. `restart` 하세요.
- **위젯을 띄우면 메인 창이 `hide()` 됩니다.** 창 수는 2개지만 메인은 화면에 없습니다. 숨겨진 창도
  `page.evaluate()`로 DOM은 읽히지만 스크린샷은 의미가 없습니다.
- **숨겨진 창에서도 `document.activeElement`와 `document.hasFocus()`가 그대로 유지됩니다.**
  "사용자가 지금 여기 타이핑 중인가"를 포커스로 판단하면 안 됩니다(이것 때문에 위젯 메모가 사라지는 버그가 있었습니다).
- **`textarea`의 `innerText`는 비어 있습니다.** 값은 `.value`로 읽어야 합니다. 드라이버의 `text` 명령이 처리합니다.
- 드라이버는 `%TEMP%\task-manager-sandbox`에 앱을 복사하면서 `main.js`의 `dataFilePath` 한 줄을
  `process.env.TM_DATA_FILE || ...`로 바꿉니다. **그 줄을 수정하면 `lib.mjs`의 `DATA_LINE_OLD`도 같이 고쳐야 합니다**
  (못 찾으면 조용히 진행하지 않고 에러로 멈춥니다).

## Troubleshooting

| 증상 | 원인 / 해결 |
|---|---|
| `Process failed to launch!` (playwright) | `ELECTRON_RUN_AS_NODE=1`. env에서 지우고 실행 |
| `Electron 바이너리가 없습니다: ...electron.exe` | postinstall 압축 해제 실패 → 위 PowerShell 블록 실행 |
| `spawn ...electron.exe ENOENT` (경로에 이상한 문자) | `path.txt` BOM → `-Encoding ascii`로 다시 쓰기 |
| `Timeout ... #masterTableContainer to be visible` | 비활성 탭. `#calendarGrid`를 기다릴 것 |
| 입력했는데 화면/디스크에 아무 반영이 없음 | `keyboard.type` 대신 `typeInto`(드라이버 `type` 명령) 사용 |
| 테스트가 이상하게 실패하고 창이 계속 남아 있음 | 이전 실행 잔여 프로세스: `taskkill //F //IM electron.exe //T` |
| `page.screenshot: Timeout 30000ms exceeded` (fonts loaded 직후 멈춤) | 같은 원인 — 이전 실행의 electron이 살아 있으면 새 창이 그려지지 않는다. 위 `taskkill` 후 재실행 |
