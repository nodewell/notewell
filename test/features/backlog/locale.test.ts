// Dates and bidirectional text in the Backlog webview (backlog.md 4.4, 4.5): stored UTC times
// shown in local time across time zones and DST, impossible dates shown as written, and
// right-to-left titles isolated so they cannot reorder the text around them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDateTime, renderDetail } from '../../../src/features/backlog/browser/render-detail.ts';
import { renderBoard } from '../../../src/features/backlog/browser/render-board.ts';
import { renderList } from '../../../src/features/backlog/browser/render-list.ts';
import { boardColumns } from '../../../src/features/backlog/browser/filters.ts';
import { buildIndex } from '../../../src/features/backlog/task-index.ts';
import { buildBacklogView, buildTaskDetail } from '../../../src/features/backlog/view-build.ts';
import { DEFAULT_CONFIG } from '../../../src/features/backlog/config.ts';
import { DEFAULT_STRINGS } from '../../../src/features/backlog/view.ts';
import { fakeDocument, type FakeElement } from './browser-view.ts';

function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('dates: UTC values in local time across zones and DST changes', () => {
  assert.equal(inZone('UTC', () => localDateTime('2026-10-15 08:30')), '2026-10-15 08:30');
  assert.equal(inZone('Asia/Seoul', () => localDateTime('2026-12-31 20:00')), '2027-01-01 05:00', 'across the year boundary');
  // New York: EDT (UTC-4) until 2026-11-01 06:00 UTC, then EST (UTC-5).
  assert.equal(inZone('America/New_York', () => localDateTime('2026-11-01 05:30')), '2026-11-01 01:30');
  assert.equal(inZone('America/New_York', () => localDateTime('2026-11-01 06:30')), '2026-11-01 01:30', 'the repeated hour');
  // The spring gap: 2026-03-08 02:00-03:00 local does not exist.
  assert.equal(inZone('America/New_York', () => localDateTime('2026-03-08 07:30')), '2026-03-08 03:30');
  assert.equal(inZone('Asia/Kolkata', () => localDateTime('2026-10-15 08:00')), '2026-10-15 13:30', 'half-hour offsets');
});

test('dates: impossible or odd values are shown exactly as written, never rolled over', () => {
  for (const value of ['2026-02-30 10:00', '2026-13-01 10:00', '2026-04-31 00:00', '2026-10-15 24:00', '2026-10-15 23:60', '2026-00-10 10:00', '0000-01-01 00:00', '2026-10-15', '2026-10-15T08:30Z', '', 'soon']) {
    assert.equal(inZone('Asia/Seoul', () => localDateTime(value)), value, value);
  }
});

const RTL = 'משימה חשובה (2)';

test('bidi: titles, labels, statuses and milestones are isolated (dir="auto") on cards, rows and the detail', () => {
  const text = ['---', 'id: TASK-1', `title: "${RTL}"`, 'status: To Do', 'labels:', '  - תווית', 'milestone: אבן-דרך', '---', ''].join('\n');
  const index = buildIndex([{ path: 'backlog/tasks/t.md', text }], [], DEFAULT_CONFIG);
  const view = buildBacklogView(index, DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
  const auto = (root: FakeElement, value: string) => root.find((e) => e.textContent === value && e.attrs.get('dir') === 'auto').length > 0;
  const board = renderBoard(fakeDocument as never, view, boardColumns(view, view.tasks), { selected: null }) as unknown as FakeElement;
  assert.ok(auto(board, RTL), 'card title');
  assert.ok(auto(board, 'תווית'), 'card label');
  assert.ok(auto(board, 'אבן-דרך'), 'card milestone');
  const list = renderList(fakeDocument as never, view, view.tasks, { sort: null, selected: null }) as unknown as FakeElement;
  assert.ok(auto(list, RTL), 'row title');
  const detail = renderDetail(fakeDocument as never, buildTaskDetail(index, 'backlog/tasks/t.md')!, DEFAULT_STRINGS, ['To Do', 'Done']) as unknown as FakeElement;
  assert.ok(auto(detail, RTL), 'detail title');
});
