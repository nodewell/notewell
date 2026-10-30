# Backlog 테스트 예제

Backlog 사양(backlog.md) 8장 테스트용. 실제 업무 데이터는 넣지 않는다 (가짜 내용).
이 `README.md`는 예제가 아니다.

## project/ — Backlog.md 1.53.0 CLI가 만든 프로젝트

`ops/`의 모든 쌍은 1.54.0 CLI로 다시 실행해 결과가 같음을 확인했다 (날짜 제외, 2026-10-17). 댓글 쌍(`section-comment-*`)은 1.54.0에서 모양이 바뀌어 1.54.0으로 다시 만들었다.

빈 폴더에서 아래 명령으로 만들고 `backlog/` 안의 파일을 그대로 복사했다 (빈 폴더는 뺌).

```sh
backlog init demo --defaults --agent-instructions none --no-git
backlog milestone add "v1 Launch"
backlog task create "Set up the build" -d '<여러 줄 설명: 굵게, 코드, 목록, 펜스 안 END 표시>' --ac "Build produces dist/" --ac "Typecheck passes" --dod "Docs updated" --priority high --type feature -l build,infra -a @alice -m m-0 --ref https://example.com/build --doc docs/build.md
backlog task edit TASK-1 --check-ac 1 -s "In Progress" --plan "1. Add script
2. Wire CI" --notes "Started with esbuild." --comment "Looks good so far" --comment-author @bob --modified-file scripts/build.mjs
backlog task create "Write the parser" -p TASK-1 -d "Line-based parser." --ac "Parses frontmatter" --priority medium
backlog task create "Render the board" --dep TASK-1 -d '<HTML처럼 보이는 텍스트, 특수 문자, 300자 줄>' --ac 'Shows `code` and **bold**' --priority low -l ui
backlog task create "Ship it" -s Done --final-summary "Shipped v1." -d "Release notes." --ac "Tagged"
backlog task edit TASK-3 --check-ac 1
backlog task create 'Title: with colon & "quotes"' -d "Edge title."
backlog task create "한국어 작업" -d "본문에 한국어와 이모지 🚀 가 있다." --ac "첫 번째 기준" --ac "두 번째 기준" -l 한국어
backlog task create "Minimal"
```

## json/ — CLI 해석 결과 (파서 기준값)

`backlog task view <ID> --json`의 `task`에서 파서가 다루는 필드만 남긴 것.

## ops/ — CLI 조작 전후 파일 (조작 기준값)

`project/`의 사본에서 CLI로 조작하기 전(`*.before.md`)과 후(`*.after.md`).

| 이름 | 명령 |
|---|---|
| status | `backlog task edit TASK-1 -s Done` |
| check | (status 다음) `backlog task edit TASK-1 --check-ac 2` |
| noupdated | `backlog task edit TASK-6 -s "In Progress"` (`updated_date` 줄이 없던 파일) |
| uncheck | `backlog task edit TASK-3 --uncheck-ac 1` |
| dod | (check 다음) `backlog task edit TASK-1 --check-dod 1` |
| uncheck-dod | (dod 다음) `backlog task edit TASK-1 --uncheck-dod 1` |

### ops/field-* — frontmatter 필드 쓰기 (5.4)

각 쌍은 `project/`의 새 사본에서 명령 하나를 실행한 결과다 (`due-change`·`due-clear`는 `field-due-add.after.md`에서 시작).

| 이름 | 명령 |
|---|---|
| field-title | `backlog task edit TASK-6 -t 'New: title'` |
| field-title-plain | `backlog task edit TASK-1.1 -t 'Parser v2'` |
| field-priority-add | `backlog task edit TASK-6 --priority high` |
| field-priority-change | `backlog task edit TASK-1.1 --priority low` |
| field-type-add | `backlog task edit TASK-3 --type bug` |
| field-type-clear | `backlog task edit TASK-1 --type ""` |
| field-milestone-add | `backlog task edit TASK-6 -m m-0` |
| field-milestone-clear | `backlog task edit TASK-1 --clear-milestone` |
| field-due-add | `backlog task edit TASK-6 --due-date 2026-12-01` |
| field-due-change | `backlog task edit TASK-6 --due-date 2027-01-15` |
| field-due-clear | `backlog task edit TASK-6 --clear-due-date` |
| field-assignee-add | `backlog task edit TASK-6 -a @carol` |
| field-assignee-multi | `backlog task edit TASK-1 -a @alice,@bob` |
| field-assignee-clear | `backlog task edit TASK-1 -a ""` |
| field-label-add | `backlog task edit TASK-2 --add-label infra` |
| field-label-remove | `backlog task edit TASK-1 --remove-label build` |
| field-labels-clear | `backlog task edit TASK-2 --clear-labels` |
| field-label-first | `backlog task edit TASK-6 --add-label 'needs: review'` |
| field-dep-add | `backlog task edit TASK-6 --dep TASK-1` |
| field-dep-clear | `backlog task edit TASK-2 --clear-deps` |
| field-ref-add | `backlog task edit TASK-6 --add-ref https://example.com/a` |
| field-ref-remove | `backlog task edit TASK-1 --remove-ref https://example.com/build` |
| field-doc-add | `backlog task edit TASK-6 --doc docs/a.md` |
| field-doc-clear | `backlog task edit TASK-1 --clear-docs` |
| field-modified-add | `backlog task edit TASK-6 --modified-file src/a.ts` |

CLI는 필드를 고칠 때 frontmatter 전체를 다시 쓴다: 고정 키 순서로 다시 정렬하고, 모르는 키·주석을 지우고, 따옴표를 다시 매기고, 흐름 목록을 블록 목록으로 바꾸고, 빠진 `assignee`·`labels`·`dependencies`를 `[]`로 넣고, 본문 끝에 빈 줄을 더한다 (변형 파일로 확인). CLI가 쓴 파일에서는 이 차이가 드러나지 않으며, Notewell은 해당 필드 줄과 `updated_date`만 고친다.

### ops/ordinal-* — 열 안 순서 (5.4, 9장 3번)

각 쌍은 `project/`의 새 사본에서 명령 하나를 실행한 결과다. `ordinal-add.before.md`만 손으로 `ordinal:` 줄을 지운 사본에서 시작한다.

| 이름 | 명령 |
|---|---|
| ordinal-change | `backlog task edit TASK-1.1 --ordinal 1500` |
| ordinal-decimal | `backlog task edit TASK-5 --ordinal 1000.5` |
| ordinal-zero | `backlog task edit TASK-4 --ordinal 0` |
| ordinal-add | (`ordinal:` 줄을 지운 TASK-6) `backlog task edit TASK-6 --ordinal 1000` |

`--ordinal`만 주면 CLI는 `ordinal:` 줄만 고치고 `updated_date`는 바꾸지 않는다 (다른 필드 쓰기와 다름). 음수는 거부하고(`Must be a non-negative number`), 소수는 쓴 그대로 둔다.

### ops/section-* — 본문 구간 쓰기와 댓글 (5.4)

각 쌍은 `project/`의 새 사본에서 명령 하나를 실행한 결과다. `section-desc-before`만 AC 구간 하나뿐인 손으로 만든 작업(TASK-31)에서 시작한다.

| 이름 | 명령 |
|---|---|
| section-desc-change | `backlog task edit TASK-1.1 -d 'New description.'` |
| section-desc-multi | `backlog task edit TASK-2 -d $'Line one\n\n- item\n\nLine two'` |
| section-desc-add | `backlog task edit TASK-6 -d 'Fresh.'` |
| section-desc-before | (TASK-31) `backlog task edit TASK-31 -d 'Inserted before AC.'` |
| section-plan-add | `backlog task edit TASK-1.1 --plan '1. Step'` |
| section-plan-change | `backlog task edit TASK-1 --plan 'New plan'` |
| section-plan-empty | `backlog task edit TASK-1 --plan ''` |
| section-notes-add | `backlog task edit TASK-3 --notes 'Note.'` |
| section-notes-add-min | `backlog task edit TASK-6 --notes 'N.'` |
| section-notes-change | `backlog task edit TASK-1 --notes 'Changed'` |
| section-notes-empty | `backlog task edit TASK-1 --notes ''` |
| section-notes-padded | `backlog task edit TASK-1.1 --notes $'\n\n  padded line  \n\nsecond\n\n'` |
| section-final-add | `backlog task edit TASK-1 --final-summary 'Done.'` |
| section-final-change | `backlog task edit TASK-3 --final-summary 'Shipped v2.'` |
| section-final-clear | `backlog task edit TASK-3 --clear-final-summary` |
| section-comment-add | `backlog task edit TASK-1 --comment 'Second'` |
| section-comment-first | `backlog task edit TASK-6 --comment 'First'` |
| section-comment-author | `backlog task edit TASK-3 --comment 'Hi' --comment-author @dana` |
| section-comment-multi | `backlog task edit TASK-1.1 --comment $'a\n\nb'` |
| section-comment-padded | `backlog task edit TASK-1.1 --comment $'\n  padded  \n\n'` |
| section-comment-add-new | (`section-comment-first.after.md`에서) `backlog task edit TASK-6 --comment 'Second'` |

확인한 CLI 동작: 텍스트는 앞뒤 공백을 지운다(`trim`). 새 구간은 표시 순서상 앞 구간 뒤(없으면 frontmatter 뒤)에 빈 줄·`## 제목`·빈 줄·표시 주석으로 들어가고, 뒤에 빈 줄만 있으면 그 빈 줄을 지운다. 계획·메모·최종 요약을 빈 값으로 주면 구간을 빈 줄 하나와 함께 지운다 (`--final-summary ''`도 `--clear-final-summary`와 같다). 설명을 빈 값(`-d ''`, 공백만)으로 주면 본문은 그대로 두고 `updated_date`만 바꾼다 (Notewell은 빈 설명을 거부한다: CLI는 설명 구간을 지우지 않는다). `--comment-author`가 없으면 `author:` 줄 없이 `created:`(UTC, 따옴표 없음)만 쓰고, 기존 댓글 뒤에는 빈 줄 하나를 두고 붙인다. 단독 `---` 줄이 있는 댓글은 거부한다. 1.54.0부터 메타 줄과 `---`, `---`와 내용 사이에 빈 줄을 넣고, 댓글을 넣을 때 기존 댓글도 이 모양으로 다시 쓴다 (`section-comment-add`의 `@bob` 댓글). Notewell은 기존 댓글을 그대로 두므로 이 쌍은 그 부분만 다르다.

## cli-checks/ — CLI로 확인한 값 (테스트와 재검증 스크립트가 함께 읽음)

| 파일 | 내용 |
|---|---|
| scalars.json | 작성기가 쓰는 스칼라 모양 (`value` → `written`). CLI가 제목·상태·라벨로 읽어 같은 값이 나온다 |
| order.json | `task list --plain` 기본 순서 (`[ordinal, priority]` 작업 묶음 × `priorities` 설정) |

새 CLI 버전에서는 위 `ops/` 표의 명령을 그대로 다시 실행해 결과를 비교한다.

## variants/ — 손으로 만든 변형

| 파일 | 다루는 경우 | SPEC |
|---|---|---|
| crlf | CRLF 줄바꿈 | 8 |
| bom | BOM | 8 |
| no-trailing-newline | 마지막 줄바꿈 없음 | 8 |
| unknown-keys | 주석, 흐름 목록, 중첩 맵, 여러 줄 스칼라, 모르는 이스케이프, 모양이 다른 목록 | 3.2 |
| no-markers | 구간 표시 주석 없는 본문 | 3.3 |
| unbalanced | 짝이 안 맞는 표시 주석 | 3.3 |
| odd-check | `[~]` 표시가 있는 AC 구간 (읽기 전용), 대문자 `[X]` | 3.4 |
| no-frontmatter | frontmatter 없음 (읽을 수 없는 작업) | 3.1 |
| other-status | 설정에 없는 상태 | 4.2 |
| updated-unknown | 모르는 모양의 `updated_date` (조작 거부) | 5.2 |
| quoted-status | 큰따옴표로 쓴 상태 (따옴표 모양 유지) | 5.3 |
