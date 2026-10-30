---
kanban-plugin: basic
date-format: YYYY-MM-DD
---

Board notes before the first lane.

## 할 일

- [ ] 첫 카드
	본문 한 줄
		- 하위 항목

	빈 줄 뒤 본문
- [ ] 둘째 카드 [[링크]]

카드 사이 문단 (interstitial)

%% 주석 - [ ] 카드 아님 %%
- [x] 셋째 카드

## 진행

- [ ] 진행 중
	펜스 앞 줄
	```
	## 코드 안 제목
	```
	펜스 뒤 줄

## 끝

**Complete**
- [x] 끝난 일
	- [ ] 본문 체크

***

## Archive

- [x] 보관된 일

%% kanban:settings
```
{"kanban-plugin":"basic","list-collapse":[false,true,false]}
```
%%
