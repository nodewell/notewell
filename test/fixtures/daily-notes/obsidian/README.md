# Obsidian이 만든 데일리 노트·템플릿 결과

Obsidian 1.12.7 시험 볼트(가짜 내용)에서 실제 설정 화면과 명령으로 얻은 파일이다. 바이트 그대로 두고 고치지 않는다. Daily notes 사양(daily-notes.md) 0장 "실측"의 근거다. `.obsidian/` 폴더 대신 설정 파일을 이 폴더에 바로 둔다 (개발 중 이 폴더가 볼트로 감지되지 않도록).

| 파일 | 내용 |
|---|---|
| `daily-notes.json` | Daily notes 설정: 형식 `YYYY-MM-DD`, 폴더 `Daily`, 템플릿 `Templates/일일` (`.md` 없음) |
| `daily-notes-korean.json` | 같은 설정, 형식 `YYYY년 MM월 DD일 dddd` |
| `templates.json` | Templates 설정: 폴더 `Templates` (날짜·시간 형식은 쓰지 않음 = 기본값) |
| `Templates/일일.md` | 템플릿: frontmatter `날짜: "{{date}}"`, `# {{title}}`, `{{time}}` |
| `results/Daily/2026-10-21.md` | 2026-10-21 14:37에 "오늘의 일일 노트 열기" (`daily-notes.json`) |
| `results/Daily/2026년 10월 21일 수요일.md` | 같은 시각, `daily-notes-korean.json`, **한국어 앱** — `dddd`가 `수요일` (영어 앱이면 `Wednesday`) |
| `루트 노트.md` | 템플릿 넣기 전 노트 |
| `results/루트 노트.md` | 3번째 줄의 `같은 이름 시험 ` (공백 포함 앞 9자)을 선택하고 "템플릿 삽입" → `일일` (같은 시각) |

관찰:

- 데일리 노트: `{{title}}` = 노트 이름(날짜 형식대로), `{{date}}`·`{{time}}` = 지금. 템플릿 글은 그대로 (frontmatter의 따옴표 유지).
- 템플릿 넣기: 선택한 글자를 템플릿 본문(frontmatter 닫는 줄 다음부터, 앞 빈 줄 포함)으로 바꾸고, 템플릿 frontmatter는 노트 맨 위 frontmatter로 합친다 (YAML로 다시 써서 따옴표가 빠짐). `{{title}}` = 넣은 노트 제목.
- `Daily` 폴더가 없을 때 Obsidian은 노트를 만들지 않고 "폴더를 찾지 못했습니다" 오류를 낸다.
