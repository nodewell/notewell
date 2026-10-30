---
kanban-plugin: basic
---

## Lane A

- [ ] card one
	- nested bullet
		1. numbered in body
	* star bullet in body
* [ ] star line (another list: the first list ends)
+ [ ] plus line (not a card)
1. [ ] numbered line (not a card)
- [ ] card two
  two-space body
- [x] checked card
	> quote in body
	- [ ] nested task

## Lane B

- [ ] b1

***

## Archive

- [x] archived one

## Old section inside the archive

- [x] archived two

%% kanban:settings
```
{"kanban-plugin":"basic","list-collapse":{"0":true},"lane-width":"272","tag-colors":[{"tagKey":"#x","color":"red"}],"date-colors":null,"archive-with-date":true}
```
%%
