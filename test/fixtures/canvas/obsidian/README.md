# Obsidian이 저장한 캔버스

Obsidian 1.12.7의 캔버스 보기가 직접 저장한 파일이다 (시험 볼트, 가짜 내용). 바이트 그대로 두고 고치지 않는다. Canvas 사양(canvas.md) 0장 "실측"과 9장 1번의 근거다. 테스트: `test/features/canvas/obsidian.test.ts`.

| 파일 | 만든 방법 |
|---|---|
| 1-created | Obsidian에서 그룹·file(노트·이미지)·link·text 카드 두 개·라벨 있는 선을 만들고 저장 |
| 2-obsidian-moved-colored | 1을 Obsidian에서: text 카드 하나 이동(0,0 → 40,20), 다른 text 카드 색 `4`. 선택한 file 카드가 배열 끝으로 옮겨졌다 |
| 3-notewell-edited | 2를 Notewell에서: 글 고치기, 이동(→ 60,20), 크기(높이 130), 색 `4` → `2` |
| 4-obsidian-resaved | 3을 Obsidian에서 열고 고쳐 다시 저장 (바뀐 것은 그룹 `x` -40 → -60뿐, Notewell이 쓴 값은 그대로) |

`../09-obsidian-shapes.canvas`도 Obsidian이 저장한 파일이다: 색 프리셋 6개, 16진수 색, 그룹 둘, 선 끝 모양(`fromEnd`·`toEnd`)·색·라벨.
