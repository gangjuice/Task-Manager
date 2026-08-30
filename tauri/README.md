# Tauri 시험판

Electron 설치 파일이 75MB인 이유를 재보고, 얼마나 줄어드는지 확인하려고 만든 갈래입니다.
**`main` 브랜치는 건드리지 않습니다.** 지금 쓰시는 프로그램은 그대로입니다.

## 왜

| | |
|---|---|
| 직접 쓴 화면 코드 | 293KB |
| Pretendard 글꼴 | 2,009KB |
| **Electron 런타임** | **252MB** (`electron.exe` 하나가 169MB) |

설치 파일의 99.7%가 크롬입니다. Electron은 크롬 전체를 들고 다니는 구조라 어떻게 깎아도
5~10MB는 불가능합니다. Tauri는 대신 **윈도우에 이미 깔려 있는 WebView2(엣지)** 를 씁니다.

## 화면 코드는 한 줄도 안 고칩니다

네 화면 파일은 각각 딱 한 줄로 바깥과 이어져 있습니다.

```js
const { ipcRenderer } = require('electron');
```

`shim/electron-shim.js` 가 그 한 줄을 가로채 Tauri 명령으로 넘깁니다. 그래서
`index.html`(4,782줄) 을 비롯한 화면 5,386줄이 그대로 돕니다. 옮겨야 하는 건
`main.js` 741줄 — 채널 26개뿐입니다.

`sync-ui.mjs` 는 루트의 원본을 `dist/` 로 **복사**하면서 껍데기를 끼웁니다.
원본은 손대지 않으므로 Electron 판과 Tauri 판이 같은 화면 코드를 공유합니다.

## 지금 어디까지 됐나

옮긴 채널 (6):
`load-data` · `save-sections` · `get-data-path` · `get-hotkey` · `get-autostart` · `open-data-folder`

아직 안 옮긴 채널 (20): 트레이 · 전역 단축키(F4) · 여러 창(위젯 · 빠른 등록 · 알림) ·
파일 대화상자 · 자동 시작 · 마감 알림 등. 부르면 껍데기가 콘솔에 경고를 남깁니다
(`window.__shimMissing` 으로 목록을 볼 수 있습니다).

> ⚠️ **저장은 시험용 파일에만 합니다.**
> 읽기는 `%APPDATA%\Task Manager\업무관리_데이터.json` (진짜 자료)에서 하지만,
> 쓰기는 `업무관리_데이터.tauri시험.json` 으로 갑니다.
> 아직 검증 안 된 저장 코드가 진짜 자료를 건드리면 안 되기 때문입니다.

## 빌드

로컬에는 Rust도 MSVC도 필요 없습니다. `tauri-port` 브랜치에 밀어 넣으면
GitHub Actions(`.github/workflows/tauri.yml`)가 빌드하고 용량을 찍습니다.

로컬에서 직접 하시려면 Rust 툴체인과 Visual Studio Build Tools(C++)가 있어야 합니다.

```bash
cd tauri
npm install
npm run build
```

## 알아둘 것 — 사내망 오프라인 환경

Tauri는 WebView2 런타임이 PC에 **이미 있어야** 돕니다.

- 윈도우 11: 기본 탑재. 이 PC에서 확인했습니다 (버전 151.0.4129.107).
- 윈도우 10: 엣지와 함께 들어옵니다. 대부분 있습니다.

인터넷이 막혀 있으면 없을 때 받아올 수 없으므로, 배포 전에 대상 PC에서 확인하세요.

```powershell
(Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv
```

버전이 찍히면 있는 것입니다. 없다면 WebView2를 함께 담아야 하는데, 그러면 130MB가
붙어 Tauri로 옮기는 의미가 사라집니다.
