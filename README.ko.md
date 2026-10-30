# Notewell

VS Code 안의 작업 보드 — Obsidian Kanban 보드와 Backlog.md 작업을 코드 바로 옆에서 다룹니다. 원래 도구는 같은 파일로 그대로 계속 쓸 수 있습니다.

[English](README.md) · **한국어**

> **미리보기.** 0.8.0은 처음 공개하는 버전이라 다듬어지지 않은 곳이 있을 수 있습니다. 문제나 의견은 [GitHub 이슈](https://github.com/nodewell/notewell/issues)에 남겨 주세요.

![VS Code에서 보드로 연 Obsidian Kanban 보드](images/screenshots/kanban.png)

## 왜 필요한가

일정은 [Obsidian](https://obsidian.md)에서, 프로젝트 작업은 [Backlog.md](https://github.com/MrLesk/Backlog.md)로 관리하지만 코드는 대부분 VS Code에서 작성합니다. 일정과 작업을 보려고 편집기, Obsidian, Backlog.md 브라우저 화면을 오가는 게 번거로워서 편집기 안에서 해결하려고 Notewell을 만들었습니다.

- **Obsidian**: 노트를 로컬 폴더(볼트)에 일반 Markdown 파일로 저장하는 노트 앱입니다. [Kanban 플러그인](https://github.com/mgmeyers/obsidian-kanban)을 쓰면 노트 하나가 일정 관리용 보드가 됩니다.
- **Backlog.md**: 같은 Git 저장소에서 사람과 AI 코딩 에이전트가 함께 쓰는 작업 관리 도구이자 칸반 보드입니다. 작업마다 설명, 완료 조건, 구현 계획을 Markdown 파일로 남기기 때문에 AI가 만든 코드 수천 줄을 한 번에 읽는 대신 작업 단위로 명세, 계획, 코드 순서로 검토할 수 있습니다. 끝난 작업은 무엇을 왜 했는지 보여주는 기록으로 Git에 남습니다.

Obsidian Kanban 플러그인과 Backlog.md는 보드와 작업을 마크다운 파일로 저장하지만, 보드 화면은 그 앱이나 브라우저 탭에만 있습니다. 같은 파일을 VS Code에서 열면 원문만 보입니다. 열은 제목 줄로, 작업은 frontmatter로 보입니다.

Notewell은 이 파일들을 VS Code 안에서 보드로 열어, 편집기를 떠나지 않고 카드를 옮기고 작업 상태를 바꾸고 완료 기준을 체크하게 합니다. 각 도구의 형식과 설정을 따르고 바뀐 줄만 다시 쓰므로 원래 도구도 같은 파일을 문제없이 계속 씁니다. 원래 도구를 대체하려는 것이 아니라, 코드 옆에서 자주 하는 보드 작업을 맡습니다.

![같은 파일을 두 가지로 연 화면: 왼쪽은 Kanban 보드, 오른쪽은 그 보드의 Markdown 원문](images/screenshots/kanban-text.png)

기능마다 따르는 원래 도구가 하나씩 있고, 그 도구를 쓰는 워크스페이스에서만 나타납니다.

## 기능

| 기능 | 원래 도구 |
|---|---|
| [Kanban](#kanban) — Kanban 커뮤니티 플러그인으로 만든 보드 보기·편집 | Obsidian |
| [Backlog](#backlog) — 작업 보드·목록·상세 보기, 상태 바꾸기, 필드 편집, 완료 기준 체크 | Backlog.md |
| [볼트 링크와 첨부](#볼트-링크와-첨부) — 이름 바꿀 때 링크 자동 갱신, 첨부 붙여넣기, 백링크, 링크 미리보기 | Obsidian |
| [데일리 노트와 템플릿](#데일리-노트와-템플릿) | Obsidian |
| [Canvas](#canvas) — `.canvas` 파일(JSON Canvas) 보기·편집 | Obsidian |

## 설치

VS Code 1.100 이상이 필요합니다. Obsidian 1.14, Kanban 플러그인 2.0.51, Backlog.md 1.54를 기준으로 만들고 확인했습니다.

- **Marketplace**: 확장 보기에서 **Notewell**을 검색하거나 [Marketplace 페이지](https://marketplace.visualstudio.com/items?itemName=nodewell.notewell)를 엽니다.
- **.vsix 파일로**: [GitHub Releases](https://github.com/nodewell/notewell/releases)에서 `notewell-<버전>.vsix`를 내려받고, 명령 팔레트에서 **Extensions: Install from VSIX...**를 실행해 그 파일을 고릅니다.
- **소스로**: `npm run package`([개발](#개발) 참고)가 `notewell-<버전>.vsix`를 만듭니다.

버전별 변경 내용: [CHANGELOG.md](CHANGELOG.md).

## 시작하기

- **Kanban**: 보드 `.md` 파일을 열거나, 탐색기에서 폴더를 오른쪽 클릭해 **새 칸반 보드**를 고릅니다.
- **Backlog**: Backlog.md 프로젝트가 있는 폴더에서 상태 표시줄의 **Backlog**를 누릅니다.
- **Canvas**: `.canvas` 파일을 엽니다.
- **데일리 노트와 템플릿**: 볼트에서 명령 팔레트로 **Notewell: 오늘의 데일리 노트 열기**나 **Notewell: 템플릿 넣기**를 실행합니다.
- **링크와 첨부**: 볼트 안에서는 따로 켜지 않아도 동작합니다. 노트 이름을 바꾸거나 노트에 이미지를 붙여넣어 보세요.

## 사용법

### Kanban

frontmatter에 `kanban-plugin:` 키가 있는 Markdown 파일은 보드로 열립니다. 다른 `.md` 파일도 **Notewell: 보드로 열기** / **텍스트로 열기**로 바꿀 수 있습니다.

- **Notewell: 새 칸반 보드**(명령 팔레트, 또는 탐색기에서 폴더 오른쪽 클릭)로 Obsidian Kanban 형식의 새 보드 파일을 만듭니다. Obsidian 없이도 보드를 시작할 수 있습니다.
- 카드 체크·해제, 카드 추가, 열 사이 카드 끌어 옮기기, 열 순서 바꾸기, 열 이름 바꾸기.
- 카드를 여러 줄로 편집합니다. Obsidian과 같은 형식(들여쓴 이어지는 줄)으로 저장합니다. **Enter** 저장, **Shift+Enter** 줄바꿈, **Esc** 취소.
- 키보드: 화살표로 포커스 이동, **Alt+화살표**로 카드·열 이동, **Space** 체크, **F2**나 **Enter** 편집, **Ctrl+Enter** 보드 옆 텍스트 편집기에서 카드 줄 열기, **N** 카드 추가(Enter로 추가하면 입력 칸이 열린 채 다음 카드를 받고, Esc로 닫음), **Shift+F10** 카드 메뉴, **Delete** 확인 후 카드 삭제.
- 카드 메뉴(오른쪽 클릭, **⋯** 버튼, Shift+F10): 편집, 텍스트에서 열기, 날짜 넣기·바꾸기·지우기, 복제, 앞·뒤에 카드 넣기, 맨 위·맨 아래·다른 열로 이동, 삭제.
- 날짜 선택기: 카드 메뉴에서, 또는 카드의 첫 날짜를 누르거나(그 날짜에서 **Enter**) 작은 팝업으로 날짜를 고릅니다(**Enter** 확인, **Esc** 취소). Obsidian Kanban과 같이 보드의 날짜 형식으로 `@{…}`에 씁니다. 날짜를 데일리 노트 링크로 쓰거나 다른 날짜 트리거를 쓰는 보드는 날짜를 그대로 둡니다.
- 카드에는 `[[위키링크]]`(누르면 노트 열기), `#태그`, 날짜 `@{2026-10-20}` / `@[[2026-10-20]]`(지난 날짜·오늘 강조), 시간 `@@{09:30}`, 맨 앞 `[분류]`, `==강조==`, 굵게·기울임·코드가 표시됩니다. 그 밖의 형식은 글자 그대로 보입니다.
- 카드 본문: 카드 아래 들여쓴 줄은 카드 안에 Markdown(표, 목록, 체크 목록, 코드)으로 보입니다. 카드의 화살표나 **Ctrl+Shift+[** / **Ctrl+Shift+]**로 카드 하나를, 열 머리글에서 열 전체를, **Notewell: 카드 본문 모두 접기** / **카드 본문 모두 펼치기**로 모든 카드를 접고 펼칩니다. 보드를 열 때의 상태는 `notewell.kanban.cardBodies`로 정합니다. 접기는 화면만 바꾸고 파일은 고치지 않습니다.
- 카드 미리보기: 접힌 카드 위에 마우스를 잠시 올리면 카드 전체가 팝업으로 보입니다. 본문이 있는 카드를 선택하고 **Ctrl+K Ctrl+I**를 눌러도 됩니다 (`notewell.kanban.cardPreview`).
- 모양: `notewell.kanban.style`로 VS Code 테마(기본), 볼트의 Obsidian 테마 색, Notewell 고유 팔레트 중에서 고릅니다.
- 완료 열: 열 안의 `**Complete**` 줄, 또는 `notewell.kanban.doneLanes`에 적은 이름. 완료 열로 옮기면 체크되고, 완료 열에서 빼면 체크가 풀립니다.
- 모든 변경은 해당 줄만 고치고 일반 편집으로 들어가므로 **Ctrl+Z**가 동작합니다. `notewell.kanban.saveOnEdit`를 끄지 않으면 바로 저장합니다. 그사이 파일이 바뀌었으면 변경을 거부하고 보드를 다시 그립니다.
- 카드 체크박스는 Obsidian과 같이 보드 설정 "Display card checkbox"가 켜져 있을 때(보드에 값이 없으면 Kanban 플러그인 기본값을 따름)만 보입니다. 보드 오른쪽 위의 체크박스 버튼으로 그 보드의 표시를 켜고 끕니다. 보드 설정 블록의 `show-checkboxes` 값 하나만 바꾸므로 Obsidian에도 똑같이 적용됩니다. 체크박스가 숨어 있어도 Space로 체크할 수 있습니다.
- 열 너비는 보드 설정 "List width"를 따릅니다(없으면 Kanban 플러그인 기본값, 그것도 없으면 Obsidian과 같은 272px). 체크박스 버튼 옆 슬라이더로 그 보드의 너비를 바꿉니다. 끄는 동안 열이 따라 움직이고, 손을 떼면 보드 설정 블록의 `lane-width`를 한 번 써서 Obsidian에서도 같은 너비로 보입니다. 슬라이더를 두 번 클릭하면 기본 너비로 돌아갑니다.
- 설정에서 날짜·시간 트리거를 바꾼 보드는 Obsidian과 같이 그 트리거로 쓴 날짜·시간만 날짜·시간으로 보입니다.
- 아직 없는 것: 열 삭제, 아카이브 편집, 체크박스 스위치·열 너비 외의 보드 설정 편집.
- VS Code가 보드를 바로 열도록(탐색기에서 열 때 텍스트 탭이 따로 생기지 않게), 보드로 연 파일을 VS Code 사용자 `settings.json`의 `workbench.editorAssociations`에 추가합니다. **텍스트로 열기**를 하면 그 항목을 지우고, `notewell.kanban.rememberBoards`를 끄면 모두 지웁니다.

설정: `notewell.kanban.enabled`, `notewell.kanban.openBoardsByDefault`, `notewell.kanban.rememberBoards`, `notewell.kanban.saveOnEdit`, `notewell.kanban.doneLanes`, `notewell.kanban.style`, `notewell.kanban.cardBodies`, `notewell.kanban.cardPreview`.

### Backlog

[Backlog.md](https://github.com/MrLesk/Backlog.md) 프로젝트(워크스페이스 폴더 루트의 `backlog/`, `.backlog/` 또는 `backlog.config.yml`)가 있는 워크스페이스용입니다. 상태 표시줄의 **Backlog** 버튼, 탐색기에서 작업 폴더 오른쪽 클릭 메뉴의 **Backlog 열기**, 작업 파일을 텍스트로 열었을 때 제목줄의 보드 버튼(그 작업을 선택), 또는 명령 팔레트의 **Notewell: Backlog 열기**로 프로젝트의 작업을 편집기 탭에 엽니다. 브라우저도, `backlog` 프로세스도 필요 없습니다.

![VS Code에서 보드로 본 Backlog.md 작업](images/screenshots/backlog.png)

목록과 작업 상세를 함께 볼 수 있습니다. 내용을 한곳에서 읽고 필드, 본문, 체크 항목을 그 자리에서 고칩니다.

![Backlog 목록과 그 아래의 작업 상세: 편집할 수 있는 필드, 설명, 완료 기준](images/screenshots/backlog-list.png)

- **보드**: 설정된 상태마다 열 하나. 카드를 다른 열로 끌거나 **Alt+왼쪽/오른쪽**으로 상태를 바꿉니다.
- **목록**: ID·제목·상태·우선순위·담당자·마일스톤으로 정렬, 상태·마일스톤·라벨·담당자 필터, ID·제목·본문 전체·라벨·담당자 검색 (낱말이 모두 들어 있으면 일치, 순서 무관, 작업 쪽 띄어쓰기 무시).
- **상세 보기**: 모든 필드와 설명·계획·메모·댓글·최종 요약을 Markdown으로 보여 주며 내용이 잘리지 않습니다. 완료 기준(AC)·완료 정의(DoD) 체크, 상태 바꾸기, 상위·하위·선행 작업으로 이동, 작업 파일을 텍스트로 열기.
- **상세 보기에서 편집**: 제목, 우선순위, 유형, 마일스톤, 마감일, 담당자, 라벨, 선행 작업(없는 ID와 순환은 거부), 참고, 문서, 바뀐 파일. 설명·계획·메모·최종 요약 편집(**Ctrl+Enter** 저장, **Esc** 취소)과 댓글 추가.
- **열 안 순서**: 카드를 위아래로 끌거나 **Alt+위/아래**.
- 변경은 해당 줄만 고치고 Backlog.md CLI처럼 `updated_date`도 고치므로 CLI와 공식 브라우저가 같은 파일을 그대로 읽습니다. 패널에서 **Ctrl+Z**를 누르면 그 패널에서 한 마지막 변경을 되돌립니다. 그사이 작업 파일이 바뀌었으면 변경을 거부하고 다시 그립니다.
- **레이아웃**: 상세 보기는 보드·목록 아래(기본) 또는 오른쪽에 열립니다. 툴바 버튼으로 바꿉니다 (`notewell.backlog.detailPosition`). 사이의 스플리터를 끌거나, 포커스한 뒤 화살표 키로 크기를 조절하고, 더블클릭하면 기본 크기로 돌아갑니다.
- **다른 위치의 프로젝트**: 워크스페이스 폴더 루트에 있지 않은 Backlog.md 폴더는 **Notewell: Backlog 폴더 추가…** 또는 탐색기 폴더 메뉴의 **Backlog 폴더로 등록**으로 추가합니다 (`notewell.backlog.projects`에 저장).
- 작업 만들기·보관·완료 처리, 초안, 문서, 결정, 통계는 Backlog.md CLI에 맡깁니다.

설정: `notewell.backlog.enabled`, `notewell.backlog.saveOnEdit`, `notewell.backlog.detailPosition`, `notewell.backlog.projects`.

### 볼트 링크와 첨부

Obsidian 볼트(`.obsidian/`이 있는 폴더) 안의 Markdown 노트용입니다.

- **이름 변경 시 링크 갱신**: VS Code에서 노트 이름을 바꾸거나 옮기면 그 노트를 가리키는 위키링크·Markdown 링크를 원래 쓴 모양대로 고칩니다. **Ctrl+Z** 한 번으로 둘 다 되돌아갑니다. 바꾸기 전에 VS Code가 링크 변경을 확인 창으로 보여 줍니다 (`notewell.links.updateOnRename`). 고친 파일은 `notewell.links.saveUpdatedFiles`를 켜지 않으면 대신 저장하지 않습니다.
- **첨부**: 이미지나 파일을 붙여넣거나 끌어다 놓으면 Obsidian 첨부 폴더 설정대로 저장하고(`notewell.attachments.folder`로 바꿀 수 있음) 볼트의 링크 형식으로 임베드를 넣습니다. 기존 파일은 덮어쓰지 않습니다.
- **백링크**: 탐색기의 Backlinks 보기에 지금 노트를 가리키는 노트를 보여 줍니다 (링크 없는 언급은 `notewell.backlinks.unlinked`).
- **링크 미리보기**: 링크 위에 마우스를 올리면 대상 노트 앞부분(또는 제목·블록)이 보이고, **Ctrl+클릭**으로 엽니다.
- **없는 노트**: 없는 노트를 가리키는 위키링크를 **Ctrl+클릭**하면 물어본 뒤 Obsidian이 새 노트를 두는 위치(또는 링크에 쓴 폴더. Obsidian처럼 없으면 만듦)에 빈 노트를 만듭니다. `notewell.links.createMissingNotes`: `ask`(기본) 또는 `never`.

설정: `notewell.links.enabled`, `notewell.links.updateOnRename`, `notewell.links.saveUpdatedFiles`, `notewell.links.createMissingNotes`, `notewell.attachments.enabled`, `notewell.attachments.folder`, `notewell.backlinks.unlinked`, `notewell.linkPreview.enabled`.

### 데일리 노트와 템플릿

Obsidian의 Daily notes나 Templates 설정이 있는 볼트용입니다. Obsidian이 만드는 것과 같은 폴더·파일 이름·템플릿·변수로 만듭니다.

- **Notewell: 오늘의 데일리 노트 열기**는 오늘 노트를 열고, 없으면 Daily notes 폴더·날짜 형식·템플릿대로 만듭니다. **날짜를 골라 데일리 노트 열기…**는 입력한 날짜(`YYYY-MM-DD`, 오늘, 어제, 내일)로 같은 일을 합니다. Obsidian처럼 Daily notes 폴더는 있어야 하고, 날짜 형식에 든 폴더(`YYYY/MM/…`)는 만듭니다. 폴더 설정이 없으면 Obsidian이 새 노트를 두는 위치에 만들고, 템플릿이 설정돼 있는데 없으면 노트를 만들지 않습니다. 이미 있는 노트는 열기만 하고 고치지 않습니다.
- **Notewell: 템플릿 넣기**는 Templates 폴더의 노트를 커서 위치에(선택 영역은 바꿔서) 넣습니다. `{{title}}`, `{{date}}`, `{{time}}`, `{{date:형식}}` / `{{time:형식}}`을 채우고, 다른 `{{…}}`는 그대로 둡니다. **Ctrl+Z** 한 번으로 되돌립니다. 템플릿의 frontmatter는 frontmatter가 없는 노트의 맨 앞에 넣을 때만 들어갑니다. **현재 날짜 넣기** / **현재 시각 넣기**는 Templates 형식을 씁니다.
- 월·요일 이름은 Obsidian 앱이 영어일 때처럼 영어로, 한국어일 때처럼 한국어로 씁니다: `notewell.dailyNotes.dateLanguage` (`auto`는 VS Code 언어를 따름). Notewell이 모르는 토큰(`LL` 등)이 든 날짜 형식은 짐작하지 않고 거부합니다.

설정: `notewell.dailyNotes.enabled`, `notewell.dailyNotes.dateLanguage`, `notewell.templates.enabled`.

### Canvas

`.canvas` 파일([JSON Canvas](https://jsoncanvas.org), Obsidian Canvas의 형식)은 기본으로 캔버스 보기로 열립니다. JSON 원문은 **편집기 다시 열기 형식… → 텍스트 편집기**로 봅니다.

![VS Code에서 연 Obsidian 캔버스: 그룹, 색 카드, 노트 카드, 라벨 있는 선](images/screenshots/canvas.png)

- 텍스트·파일·링크·그룹 카드를 색과 함께, 선을 화살표·라벨과 함께 Obsidian과 같은 모양으로 그립니다. 텍스트 카드는 `==강조==`, `[[위키링크]]`(누르면 노트 열기), `#태그`가 든 Markdown, 노트 카드는 노트 내용, 이미지 카드는 이미지(볼트 안 이미지), 링크 카드는 URL을 보여 줍니다(확인 후 브라우저로 엶). 파일·링크 카드의 이름은 카드 위에 보입니다.
- 빈 곳 끌기(또는 **Space**+끌기)나 스크롤로 이동, **Ctrl+휠**이나 **+**/**−**로 확대·축소, **Shift+1**로 전체 보기. **목록으로**는 모든 카드를 텍스트로 보여 줍니다(화면 읽기용).
- 편집: 카드를 끌어 옮기고(그룹은 안의 카드와 함께) 모서리를 끌어 크기를 바꿉니다. **화살표**로 선택한 카드 이동(**Shift**: 50 px), **Alt+화살표**로 크기 바꾸기, **C**로 색 6가지 중 고르기, **Enter**로 텍스트 카드 편집(**Ctrl+Enter** 저장, **Esc** 취소).
- 편집은 바뀐 값만 고치고 일반 편집으로 들어가므로 **Ctrl+Z**가 동작합니다. 자동으로 저장하지 않습니다. 카드를 선택만 해서는 파일이 바뀌지 않습니다. 그사이 파일이 바뀌었으면 편집을 거부하고 다시 그립니다. 5 MB 또는 카드 5,000개를 넘는 파일은 보기 전용으로 엽니다.
- 아직 없는 것: 카드·선 만들기·지우기, 연결·그룹 라벨 바꾸기, 웹 페이지 미리보기, PNG 내보내기.

설정: `notewell.canvas.enabled`, `notewell.canvas.editable`, `notewell.canvas.snapToGrid`.

## 원칙

- **원문 보존.** 조작으로 바뀌는 줄만 다시 씁니다. 열고 그대로 저장하면 파일이 바이트 단위로 같습니다.
- **원래 도구를 따릅니다.** 원래 도구의 설정(`.obsidian/`, Backlog.md `config.yml`)을 읽기만 하고 쓰지 않습니다 (Notewell이 쓰는 설정은 위의 편집기 연결 같은 VS Code 설정뿐입니다). 파일을 고칠 때는 원래 도구가 함께 고치는 메타데이터도 똑같이 고칩니다.
- **런타임 의존성·네트워크·외부 프로세스 없음.** 원래 도구의 CLI를 실행하지 않고 파일 형식을 직접 따릅니다. 웹뷰는 엄격한 CSP 아래에서 동작합니다.

## 개발

요구 사항: Node.js 24 이상 (테스트가 Node 내장 타입 제거로 TypeScript를 바로 실행합니다).

```sh
npm ci              # 개발 도구 설치 (런타임 의존성은 없습니다)
npm run build       # dist/로 번들 (extension.cjs와 웹뷰 파일)
npm run typecheck   # 확장 코드와 웹뷰 스크립트 타입 검사
npm test            # test/**/*.test.ts를 node:test로 실행
npm run package     # 프로덕션 빌드 + .vsix
```

테스트 예제는 [test/fixtures](test/fixtures)에 있습니다.

## 라이선스

[MIT](LICENSE) © nodewell

Notewell은 독립 프로젝트이며 Obsidian(Dynalist Inc.), Kanban 플러그인 제작자, Backlog.md와 관련이 없습니다.
