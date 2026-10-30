# Obsidian 테마 예제 (합성)

Notewell의 Obsidian 테마 변수 읽기(core.md 3.6)를 시험하는 **합성** 볼트. 실제 커뮤니티 테마를 복사하지 않았다 (라이선스).

| 파일 | 다루는 경우 |
|---|---|
| `.obsidian/appearance.json` | 테마 `Sample`, 다크(`obsidian`), 강조색, 스니펫 목록(없는 스니펫, 경로 탈출 이름, 빈 이름 포함), 본문 글꼴 |
| `.obsidian/themes/Sample/theme.css` | `body`·`.theme-dark`·`.theme-light` 변수, 구체성(`.theme-dark`가 `body`를 이김), `var()` 참조, `@import`·`@font-face`·다른 `@media` 무시, `prefers-color-scheme` 반영, 다른 선택자 무시 |
| `.obsidian/snippets/soft-cards.css` | 같은 무게에서 뒤가 이김, `!important` |
| `.obsidian/snippets/hostile.css` | 악의적 값: `url()`, `expression()`, `}` 탈출, 백슬래시, HTML 문자열, 순환 `var()`, 없는 참조, 허용 안 된 함수, 500자 초과. 위험한 값은 버려지고, 안전한 선언(예: `}` 앞의 `--text-accent: red`)은 CSS 규칙대로 적용될 수 있다. |
