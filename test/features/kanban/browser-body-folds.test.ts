// Card body folding (kanban.md 3.2): fold state rules and how a folded card is drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bodyFoldShortcut,
  foldAll,
  foldedLabel,
  isFolded,
  laneFoldAction,
  laneHasBodies,
  NO_FOLDS,
  pruneFolds,
  restoreFolds,
  setFolded,
  setLaneFolded,
  storeFolds,
} from '../../../src/features/kanban/browser/body-folds.ts';
import { renderBoard } from '../../../src/features/kanban/browser/render.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView, type BoardView, type CardBodies } from '../../../src/features/kanban/view.ts';
import { fakeDocument as doc, type FakeElement } from '../../support/markdown.ts';

const LINES = [
  '---', 'kanban-plugin: basic', '---', '',
  '## Todo', '',
  '- [ ] Long card',
  '\t- first',
  '\t- second',
  '',
  '\t  more',
  '- [ ] Title only',
  '- [ ] One line body',
  '\tonly line',
  '',
  '## Done', '',
  '**Complete**',
  '- [x] Finished',
  '\tnotes',
  '',
];

const board = (cardBodies?: CardBodies, lines = LINES): BoardView =>
  buildBoardView(lines, parseBoard(lines), { today: '2026-10-20', ...(cardBodies ? { cardBodies } : {}) });

const cardsOf = (root: FakeElement) => root.find((e) => e.tagName === 'li' && e.classes.has('card'));

test('the board default follows the setting; cards without a body are never folded', () => {
  const expanded = board();
  assert.equal(expanded.cardBodies, 'expanded');
  const [long, titleOnly] = expanded.lanes[0]!.cards;
  assert.equal(isFolded(NO_FOLDS, expanded, long!), false);
  const collapsed = board('collapsed');
  assert.equal(isFolded(NO_FOLDS, collapsed, collapsed.lanes[0]!.cards[0]!), true);
  assert.equal(isFolded(NO_FOLDS, collapsed, titleOnly!), false);
  assert.equal(isFolded(setFolded(NO_FOLDS, expanded, titleOnly!, true), expanded, titleOnly!), false);
});

test('a card fold is remembered by its first line, follows a moved card and resets when the line changes', () => {
  const view = board();
  const long = view.lanes[0]!.cards[0]!;
  const folds = setFolded(NO_FOLDS, view, long, true);
  assert.deepEqual([...folds.cards], [['Long card', true]]);
  assert.equal(isFolded(folds, view, long), true);

  // The card moved to another lane (and was checked there): same first line after the check mark.
  const moved = ['---', 'kanban-plugin: basic', '---', '', '## Todo', '', '- [ ] Title only', '', '## Done', '', '**Complete**', '- [x] Long card', '\t- first', ''];
  const movedView = board(undefined, moved);
  assert.equal(isFolded(pruneFolds(folds, movedView), movedView, movedView.lanes[1]!.cards[0]!), true);

  // The first line was edited: the override is dropped and the default applies again.
  const edited = moved.map((line) => (line === '- [x] Long card' ? '- [x] Long card (edited)' : line));
  const editedView = board(undefined, edited);
  const pruned = pruneFolds(folds, editedView);
  assert.equal(pruned.cards.size, 0);
  assert.equal(isFolded(pruned, editedView, editedView.lanes[1]!.cards[0]!), false);
  // Nothing to drop: the same object comes back (no state write).
  assert.equal(pruneFolds(folds, view), folds);
});

test('an override equal to the default is not kept', () => {
  const view = board();
  const long = view.lanes[0]!.cards[0]!;
  const folded = setFolded(NO_FOLDS, view, long, true);
  assert.equal(setFolded(folded, view, long, false).cards.size, 0);
});

test('collapse/expand all forget per-card states and set the board default, not the setting', () => {
  const view = board();
  const [long, , oneLine] = view.lanes[0]!.cards;
  let folds = setFolded(NO_FOLDS, view, long!, true);
  folds = foldAll(true);
  assert.equal(folds.cards.size, 0);
  assert.equal(isFolded(folds, view, oneLine!), true);
  assert.equal(view.cardBodies, 'expanded');
  // The default then wins over the setting, and single cards can still be unfolded.
  folds = setFolded(folds, view, oneLine!, false);
  assert.equal(isFolded(folds, view, oneLine!), false);
  assert.equal(isFolded(folds, view, long!), true);
  assert.equal(isFolded(foldAll(false), board('collapsed'), long!), false);
});

test('the stored form round-trips and malformed state is ignored', () => {
  const view = board();
  const folds = setFolded(foldAll(false), view, view.lanes[0]!.cards[0]!, true);
  const stored = JSON.parse(JSON.stringify(storeFolds(folds))) as unknown;
  const back = restoreFolds(stored);
  assert.equal(back.defaultFolded, false);
  assert.deepEqual([...back.cards], [['Long card', true]]);
  for (const bad of [undefined, null, 3, 'x', { cards: 'x' }, { cards: [[1, true], ['a', 'yes'], 'z'] }, { defaultFolded: 'yes', cards: [] }]) {
    const restored = restoreFolds(bad);
    assert.equal(restored.cards.size, 0);
    assert.equal(restored.defaultFolded, undefined);
  }
  // A __proto__ title is an ordinary key.
  assert.deepEqual([...restoreFolds({ cards: [['__proto__', true]] }).cards], [['__proto__', true]]);
});

test('Ctrl+Shift+[ folds and Ctrl+Shift+] unfolds, by physical key', () => {
  const key = (code: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>>) =>
    bodyFoldShortcut({ code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  assert.equal(key('BracketLeft', { ctrlKey: true, shiftKey: true }), 'fold');
  assert.equal(key('BracketRight', { ctrlKey: true, shiftKey: true }), 'unfold');
  assert.equal(key('BracketLeft', { metaKey: true, shiftKey: true }), 'fold');
  assert.equal(key('BracketLeft', { ctrlKey: true }), undefined);
  assert.equal(key('BracketLeft', { shiftKey: true }), undefined);
  assert.equal(key('BracketLeft', { ctrlKey: true, shiftKey: true, altKey: true }), undefined);
  assert.equal(key('KeyK', { ctrlKey: true, shiftKey: true }), undefined);
});

test('folded label counts lines with the plural and singular strings', () => {
  assert.equal(foldedLabel(3, '{0} lines', '1 line'), '3 lines');
  assert.equal(foldedLabel(1, '{0} lines', '1 line'), '1 line');
  assert.equal(foldedLabel(3, '{0}줄', '1줄'), '3줄');
});

test('render: only cards with a body get the toggle; expanded shows the lines with aria-expanded=true', () => {
  const view = board();
  const root = renderBoard(doc, view, { collapsed: new Map() });
  const [long, titleOnly, oneLine] = cardsOf(root);
  const toggle = long!.find((e) => e.classes.has('body-toggle'))[0]!;
  assert.equal(toggle.tagName, 'button');
  assert.equal(toggle.attrs.get('aria-expanded'), 'true');
  assert.equal(toggle.attrs.get('aria-label'), view.strings.collapseBody);
  assert.equal(toggle.attrs.get('data-action'), 'toggle-body');
  assert.equal(toggle.attrs.get('tabindex'), '-1');
  assert.equal(toggle.find((e) => e.classes.has('body-toggle-icon'))[0]!.textContent, '›');
  // The body is drawn as Markdown (kanban.md 3): the list and its continuation paragraph.
  const longBody = long!.find((e) => e.classes.has('card-body'))[0]!;
  assert.ok(longBody.classes.has('card-body-md'));
  assert.deepEqual(longBody.find((e) => e.tagName === 'li').map((e) => e.textContent), ['first', 'secondmore']);
  assert.ok(long!.classes.has('has-body') && !long!.classes.has('body-folded'));
  assert.equal(titleOnly!.find((e) => e.classes.has('body-toggle') || e.classes.has('card-body')).length, 0);
  assert.ok(!titleOnly!.classes.has('has-body'));
  assert.equal(oneLine!.find((e) => e.classes.has('card-body'))[0]!.textContent, 'only line');
});

test('render: a folded card shows one marker line with the count instead of the body', () => {
  const view = board();
  const folds = setFolded(setFolded(NO_FOLDS, view, view.lanes[0]!.cards[0]!, true), view, view.lanes[0]!.cards[2]!, true);
  const root = renderBoard(doc, view, { collapsed: new Map(), folded: (card) => isFolded(folds, view, card) });
  const [long, , oneLine, finished] = cardsOf(root);
  assert.ok(long!.classes.has('body-folded'));
  const toggle = long!.find((e) => e.classes.has('body-toggle'))[0]!;
  assert.equal(toggle.attrs.get('aria-expanded'), 'false');
  assert.equal(toggle.attrs.get('aria-label'), view.strings.expandBody);
  assert.equal(long!.find((e) => e.classes.has('card-body-md')).length, 0);
  const body = long!.find((e) => e.classes.has('card-body'))[0]!;
  assert.ok(body.classes.has('folded'));
  assert.equal(body.attrs.get('data-action'), 'toggle-body');
  assert.equal(body.textContent, '⋯ 3 lines');
  assert.equal(oneLine!.find((e) => e.classes.has('card-body'))[0]!.textContent, '⋯ 1 line');
  // The title stays as it is.
  assert.equal(long!.find((e) => e.classes.has('card-title'))[0]!.textContent, 'Long card');
  assert.equal(finished!.find((e) => e.classes.has('card-body-md')).length, 1);
});

test('render: without a fold function the board default applies', () => {
  const root = renderBoard(doc, board('collapsed'), { collapsed: new Map() });
  const folded = cardsOf(root).filter((card) => card.classes.has('body-folded'));
  assert.equal(folded.length, 3);
});

test('lane fold: folds all bodies when any is expanded, else unfolds all; kept per card', () => {
  const view = board();
  const todo = view.lanes[0]!;
  const [long, titleOnly, oneLine] = todo.cards;
  assert.equal(laneHasBodies(todo), true);
  assert.equal(laneHasBodies(board(undefined, ['---', 'kanban-plugin: basic', '---', '', '## A', '', '- [ ] x', '']).lanes[0]!), false);
  // One body expanded is enough for "fold".
  let folds = setFolded(NO_FOLDS, view, long!, true);
  assert.equal(laneFoldAction(folds, view, todo), 'fold');
  folds = setLaneFolded(folds, view, todo, true);
  assert.equal(isFolded(folds, view, long!), true);
  assert.equal(isFolded(folds, view, oneLine!), true);
  assert.equal(isFolded(folds, view, titleOnly!), false);
  assert.deepEqual([...folds.cards].sort(), [['Long card', true], ['One line body', true]]);
  // Other lanes keep their state.
  assert.equal(isFolded(folds, view, view.lanes[1]!.cards[0]!), false);
  // All folded: the next action unfolds them all; the result survives the stored form.
  assert.equal(laneFoldAction(folds, view, todo), 'unfold');
  folds = setLaneFolded(folds, view, todo, false);
  assert.equal(laneFoldAction(folds, view, todo), 'fold');
  assert.equal(folds.cards.size, 0);
  // Against a collapsed board default the result is kept as per-card overrides.
  const collapsed = board('collapsed');
  const unfolded = restoreFolds(JSON.parse(JSON.stringify(storeFolds(setLaneFolded(NO_FOLDS, collapsed, collapsed.lanes[0]!, false)))));
  assert.equal(isFolded(unfolded, collapsed, collapsed.lanes[0]!.cards[0]!), false);
  assert.equal(isFolded(unfolded, collapsed, collapsed.lanes[1]!.cards[0]!), true);
});

test('render: the lane fold toggle names the next action, only in lanes with bodies, not when collapsed', () => {
  const view = board();
  const togglesOf = (root: FakeElement) => root.find((e) => e.tagName === 'button' && e.classes.has('lane-bodies'));
  const expanded = renderBoard(doc, view, { collapsed: new Map() });
  const [todoToggle, doneToggle] = togglesOf(expanded);
  assert.equal(togglesOf(expanded).length, 2);
  assert.equal(todoToggle!.attrs.get('data-action'), 'toggle-lane-bodies');
  assert.equal(todoToggle!.attrs.get('type'), 'button');
  assert.equal(todoToggle!.attrs.get('tabindex'), undefined);
  assert.equal(todoToggle!.attrs.get('data-next'), 'fold');
  assert.equal(todoToggle!.attrs.get('aria-label'), view.strings.collapseLaneBodies);
  assert.equal(todoToggle!.attrs.get('title'), view.strings.collapseLaneBodies);
  assert.equal(doneToggle!.attrs.get('data-next'), 'fold');
  // In the header, after the count.
  const header = expanded.find((e) => e.classes.has('lane-header'))[0]!;
  assert.ok(header.find((e) => e.classes.has('lane-bodies')).length === 1);

  const folds = setLaneFolded(NO_FOLDS, view, view.lanes[0]!, true);
  const folded = renderBoard(doc, view, { collapsed: new Map(), folded: (card) => isFolded(folds, view, card) });
  const [todoFolded] = togglesOf(folded);
  assert.equal(todoFolded!.attrs.get('data-next'), 'unfold');
  assert.equal(todoFolded!.attrs.get('aria-label'), view.strings.expandLaneBodies);

  assert.equal(togglesOf(renderBoard(doc, view, { collapsed: new Map([[0, true]]) })).length, 1);
  const noBodies = board(undefined, ['---', 'kanban-plugin: basic', '---', '', '## A', '', '- [ ] x', '']);
  assert.equal(togglesOf(renderBoard(doc, noBodies, { collapsed: new Map() })).length, 0);
});

test('the webview keeps folds in setState, prunes them on render and handles the commands', () => {
  const main = readFileSync(new URL('../../../src/features/kanban/browser/main.ts', import.meta.url), 'utf8');
  assert.match(main, /restoreFolds\(\(vscode\.getState\(\)/);
  assert.match(main, /vscode\.setState\(\{ bodies: storeFolds\(folds\) \}\)/);
  assert.match(main, /message\?\.type === 'cardBodies'[\s\S]*?folds = foldAll\(message\.collapsed\);\s*saveState\(\);/);
  assert.match(main, /const pruned = pruneFolds\(folds, message\.view\);/);
  // The lane fold toggle stores its result per card in the same state.
  assert.match(main, /case 'toggle-lane-bodies':/);
  assert.match(main, /folds = setLaneFolded\(folds, view, laneView, laneFoldAction\(folds, view, laneView\) === 'fold'\);\s*saveState\(\);/);
  // Nothing about folds is ever sent to the extension.
  assert.doesNotMatch(main, /post\(\{ type: '[^']*[Ff]old/);
});

test('package.json: setting, both commands in the palette and the editor title overflow of a board only', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    contributes: {
      commands: { command: string }[];
      menus: Record<string, { command: string; when?: string; group?: string }[]>;
      configuration: { properties: Record<string, { enum?: string[]; default?: unknown }> };
    };
  };
  const setting = manifest.contributes.configuration.properties['notewell.kanban.cardBodies'];
  assert.deepEqual(setting?.enum, ['expanded', 'collapsed']);
  assert.equal(setting?.default, 'expanded');
  for (const id of ['notewell.kanban.collapseAllCardBodies', 'notewell.kanban.expandAllCardBodies']) {
    assert.ok(manifest.contributes.commands.some((c) => c.command === id), id);
    for (const menu of ['commandPalette', 'editor/title']) {
      const entry = manifest.contributes.menus[menu]!.find((m) => m.command === id);
      assert.equal(entry?.when, 'activeCustomEditorId == notewell.kanban', `${menu} ${id}`);
      // Not 'navigation': the editor title overflow (⋯) menu.
      if (menu === 'editor/title') assert.ok(entry?.group && !entry.group.startsWith('navigation'));
    }
  }
});
