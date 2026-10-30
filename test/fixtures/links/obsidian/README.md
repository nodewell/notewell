# Obsidian이 만든 링크 결과

Obsidian 1.12.7 시험 볼트(가짜 내용)에서 실제 설정 화면과 조작으로 얻은 파일이다. 바이트 그대로 두고 고치지 않는다. Links 사양(links.md) 0장 "실측"의 근거다. 테스트: `test/features/links/obsidian.test.ts`.

| 폴더·파일 | 내용 |
|---|---|
| `before/` | 처음 볼트 (노트·첨부 하나·Kanban 보드). `회의.md`가 볼트 루트, `Notes/`, `Archive/2025/`에 하나씩 있다 |
| `after-rename/` | Obsidian에서 `Notes/프로젝트 A.md`를 `프로젝트 B`로 이름을 바꾼 뒤 바뀐 노트만 ("Automatically update internal links" 켬). 모든 링크를 최단 형태로 다시 썼고 frontmatter 속성 `"[[…]]"`도 고쳤다 |
| (없음) | 이어서 `프로젝트 B`를 `Archive/`로 옮겼을 때 Obsidian은 노트를 하나도 고치지 않았다 (이름만 쓴 링크라서) |
| `app-json/always-update-*.json` | "Automatically update internal links" 스위치를 켜고 끈 뒤의 `app.json` (값이 없으면 꺼짐) |
| `app-json/attachments-*.json` | 첨부 위치 4가지: 볼트 최상위 `/`, 현재 파일과 같은 폴더 `./`, 현재 폴더 아래 하위 폴더 `./첨부파일`(한국어 앱 기본 이름), 지정 폴더 `assets` |

붙여넣은 이미지 이름(`Pasted image 20261021143440.png`)과 이름 중복 시 ` 1`은 테스트 안에 값으로 적었다.

Obsidian은 이름 변경·이동 때 `.canvas`의 file 카드 경로(`"file":"Notes/프로젝트 A.md"`)도 고쳤다. Notewell의 링크 갱신은 아직 `.canvas`를 다루지 않는다 (links.md에 없음).
