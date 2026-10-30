// Edits through the canvas editor adapter (canvas.md 3.3, 5, 5.1) against the fake `vscode`:
// host validation, optimistic concurrency, one WorkspaceEdit per edit, refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { parseLines, BOM } from '../../../src/core/lines.ts';
import { applyEdits } from '../../../src/core/patch.ts';

const FAKE_VSCODE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) => (specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context)),
});

const fake = await import('./fake-vscode.ts');
const { CanvasEditorProvider } = await import('../../../src/features/canvas/editor.ts');
const { readCanvas } = await import('../../../src/features/canvas/model.ts');
const { computeCanvasPatch } = await import('../../../src/features/canvas/operations.ts');
const { variants } = await import('./support.ts');

type VsUri = import('vscode').Uri;
const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const EXT = fake.Uri.file('/ext') as unknown as VsUri;

const CANVAS = `{
\t"nodes":[
\t\t{"id":"g","type":"group","x":0,"y":0,"width":500,"height":300,"label":"G"},
\t\t{"id":"a","type":"text","text":"one","x":10,"y":10,"width":100,"height":50},
\t\t{"id":"b","type":"text","text":"two","x":600,"y":10,"width":100,"height":50,"color":"2"},
\t\t{"id":"u","type":"embed","x":600,"y":200,"width":100,"height":50},
\t\t{"id":"d","type":"text","text":"x","x":900,"y":0,"width":50,"height":50},
\t\t{"id":"d","type":"text","text":"y","x":900,"y":100,"width":50,"height":50}
\t],
\t"edges":[]
}
`;

async function open(text = CANVAS, settings: Record<string, unknown> = {}) {
  fake.reset();
  for (const [name, value] of Object.entries(settings)) fake.state.settings.set(name, value);
  fake.state.existing.add('/ws/c.canvas');
  const doc = fake.makeDocument('/ws/c.canvas', text);
  const panel = fake.makePanel();
  const provider = new CanvasEditorProvider(EXT, { vaults: () => undefined });
  await provider.resolveCustomTextEditor(doc as never, panel as never);
  panel.send({ type: 'ready' });
  await settle();
  panel.posted.length = 0;
  return { doc, panel };
}

const types = (panel: ReturnType<typeof fake.makePanel>) => panel.posted.map((m) => (m as { type: string }).type);
const refusals = (panel: ReturnType<typeof fake.makePanel>) =>
  panel.posted.filter((m) => (m as { type: string }).type === 'refused').map((m) => (m as { message: string }).message);

const move = (version: number, extra: Record<string, unknown> = {}) => ({ type: 'move', version, index: 1, id: 'a', x: 20, y: 30, fromX: 10, fromY: 10, ...extra });

test('a move is one WorkspaceEdit changing only x and y; the view redraws; nothing is saved', async () => {
  const { doc, panel } = await open();
  panel.send(move(1));
  await settle(80);
  assert.equal(fake.state.applied.length, 1);
  assert.equal(doc.text, CANVAS.replace('"text":"one","x":10,"y":10', '"text":"one","x":20,"y":30'));
  assert.equal(doc.version, 2);
  assert.deepEqual(types(panel), ['render']);
  assert.equal((panel.posted[0] as { version: number }).version, 2);
  assert.ok(!fake.state.executed.some((c) => String(c[0]).includes('save')));
});

test('a group move carries the cards inside it in the same WorkspaceEdit (one undo step)', async () => {
  const { doc, panel } = await open();
  panel.send({ type: 'move', version: 1, index: 0, id: 'g', x: 100, y: 0, fromX: 0, fromY: 0 });
  await settle(80);
  assert.equal(fake.state.applied.length, 1);
  assert.equal(fake.state.applied[0]!.entries.length, 2, 'x of the group and of card a');
  assert.match(doc.text, /"id":"g","type":"group","x":100,"y":0/);
  assert.match(doc.text, /"text":"one","x":110,"y":10/);
  assert.match(doc.text, /"text":"two","x":600/);
});

test('resize, text and color', async () => {
  const { doc, panel } = await open();
  panel.send({ type: 'resize', version: 1, index: 1, id: 'a', width: 200, height: 80, fromWidth: 100, fromHeight: 50 });
  await settle();
  panel.send({ type: 'editText', version: 2, index: 1, id: 'a', text: 'new\n"quoted"' });
  await settle();
  panel.send({ type: 'setColor', version: 3, index: 1, id: 'a', color: '4', from: '' });
  await settle();
  panel.send({ type: 'setColor', version: 4, index: 2, id: 'b', color: 'none', from: '2' });
  await settle(80);
  assert.equal(fake.state.applied.length, 4);
  assert.match(doc.text, /\{"id":"a","type":"text","text":"new\\n\\"quoted\\"","x":10,"y":10,"width":200,"height":80, "color": "4"\}|\{"id":"a","type":"text","text":"new\\n\\"quoted\\"","x":10,"y":10,"width":200,"height":80,"color":"4"\}/);
  assert.match(doc.text, /"id":"b","type":"text","text":"two","x":600,"y":10,"width":100,"height":50\}/);
  assert.deepEqual(refusals(panel), []);
});

test('an edit with nothing to change writes nothing and redraws', async () => {
  const { panel } = await open();
  panel.send({ type: 'setColor', version: 1, index: 1, id: 'a', color: 'none', from: '' });
  await settle(80);
  assert.equal(fake.state.applied.length, 0);
  assert.deepEqual(types(panel), ['render']);
});

test('outdated views are refused and redrawn: version, node identity, shown values', async () => {
  for (const message of [
    move(7),
    move(1, { id: 'b' }),
    move(1, { index: 9 }),
    move(1, { fromX: 11 }),
    { type: 'resize', version: 1, index: 1, id: 'a', width: 200, height: 80, fromWidth: 99, fromHeight: 50 },
    { type: 'setColor', version: 1, index: 2, id: 'b', color: '1', from: '3' },
  ]) {
    const { doc, panel } = await open();
    panel.send(message);
    await settle(80);
    assert.equal(fake.state.applied.length, 0, JSON.stringify(message));
    assert.equal(doc.text, CANVAS);
    assert.deepEqual(refusals(panel), ['The canvas changed before this edit was applied. It now shows the latest content.'], JSON.stringify(message));
    assert.ok(types(panel).includes('render'));
  }
});

test('edits run one after another: a second edit on the same version is refused', async () => {
  const { doc, panel } = await open();
  panel.send(move(1));
  panel.send(move(1, { x: 50, y: 50 }));
  await settle(80);
  assert.equal(fake.state.applied.length, 1);
  assert.match(doc.text, /"x":20,"y":30/);
  assert.equal(refusals(panel).length, 1);
});

test('refusals: duplicated id, unsupported type, values, read-only canvas, settings', async () => {
  const cases: [Record<string, unknown>, string, string?, Record<string, unknown>?][] = [
    [{ type: 'move', version: 1, index: 4, id: 'd', x: 0, y: 0, fromX: 900, fromY: 0 }, 'Several cards use this id, so it is not changed here. Edit the file as text.'],
    [{ type: 'setColor', version: 1, index: 3, id: 'u', color: '1', from: '' }, 'Cards of this type can only be moved or resized here.'],
    [{ type: 'editText', version: 1, index: 3, id: 'u', text: 'x' }, 'Cards of this type can only be moved or resized here.'],
    [{ type: 'resize', version: 1, index: 1, id: 'a', width: 19, height: 50, fromWidth: 100, fromHeight: 50 }, 'The edit was not applied: the value is not allowed.'],
    [move(1), 'Editing canvases is turned off (notewell.canvas.editable).', undefined, { 'notewell.canvas.editable': false }],
  ];
  for (const [message, text, source, settings] of cases) {
    const { panel } = await open(source, settings);
    panel.send(message);
    await settle(80);
    assert.equal(fake.state.applied.length, 0, text);
    assert.deepEqual(refusals(panel), [text]);
  }
  // Unknown types still move (canvas.md 9.5).
  const { doc, panel } = await open();
  panel.send({ type: 'move', version: 1, index: 3, id: 'u', x: 610, y: 200, fromX: 600, fromY: 200 });
  await settle(80);
  assert.deepEqual(refusals(panel), []);
  assert.match(doc.text, /"id":"u","type":"embed","x":610/);

  const nodes = Array.from({ length: 5001 }, (_, i) => ({ id: `n${i}`, type: 'text', text: '', x: 0, y: 0, width: 50, height: 50 }));
  const big = await open(JSON.stringify({ nodes }));
  big.panel.send({ type: 'move', version: 1, index: 0, id: 'n0', x: 10, y: 0, fromX: 0, fromY: 0 });
  await settle(80);
  assert.deepEqual(refusals(big.panel), ['This canvas is shown read-only (over 5 MB or 5,000 cards), so it is not changed here.']);
});

test('documents that must not be written: closed, not UTF-8, deleted; a failed applyEdit', async () => {
  const setups: [(doc: ReturnType<typeof fake.makeDocument>) => void, string][] = [
    [(doc) => void (doc.isClosed = true), 'This file was moved, renamed or deleted, so the canvas no longer changes it. Open the file again.'],
    [(doc) => void (doc.encoding = 'windows1252'), 'VS Code opened this file with an encoding other than UTF-8, so the canvas does not change it. Reopen it with UTF-8 encoding.'],
    [() => fake.state.existing.clear(), 'This file was moved, renamed or deleted, so the canvas no longer changes it. Open the file again.'],
    [() => void (fake.state.acceptEdits = false), 'The editor did not apply this edit.'],
  ];
  for (const [setup, text] of setups) {
    const { doc, panel } = await open();
    setup(doc);
    panel.send(move(1));
    await settle(80);
    assert.deepEqual(refusals(panel), [text]);
    assert.equal(doc.text, CANVAS);
  }
});

test('invalid edit messages are ignored before anything is read', async () => {
  const { panel } = await open();
  for (const message of [
    { ...move(1), x: 1.5 },
    { ...move(1), x: 2e7 },
    { ...move(1), extra: 1 },
    { type: 'resize', version: 1, index: 1, id: 'a', width: 0, height: 50, fromWidth: 100, fromHeight: 50 },
    { type: 'editText', version: 1, index: 1, id: 'a', text: 'a\r\nb' },
    { type: 'setColor', version: 1, index: 1, id: 'a', color: '#ff0000', from: '' },
    { type: 'setColor', version: 1, index: 1, id: 'a', color: '7', from: '' },
    { type: 'move', version: -1, index: 1, id: 'a', x: 1, y: 1, fromX: 10, fromY: 10 },
  ]) panel.send(message);
  await settle(80);
  assert.equal(fake.state.applied.length, 0);
  assert.deepEqual(panel.posted, []);
});

test('the view carries editable and snapToGrid from the settings', async () => {
  for (const [settings, editable, snap] of [
    [{}, true, false],
    [{ 'notewell.canvas.editable': false, 'notewell.canvas.snapToGrid': true }, false, true],
  ] as const) {
    fake.reset();
    for (const [name, value] of Object.entries(settings)) fake.state.settings.set(name, value);
    const panel = fake.makePanel();
    await new CanvasEditorProvider(EXT, { vaults: () => undefined }).resolveCustomTextEditor(fake.makeDocument('/ws/c.canvas', CANVAS) as never, panel as never);
    panel.send({ type: 'ready' });
    await settle();
    const view = (panel.posted[0] as { view: { editable: boolean; snapToGrid: boolean; nodes: { id: string; locked?: boolean }[] } }).view;
    assert.deepEqual([view.editable, view.snapToGrid], [editable, snap]);
    assert.deepEqual(view.nodes.filter((n) => n.locked).map((n) => n.id), ['d', 'd']);
  }
});

test('preservation through the host: every fixture, a move of each first node equals the value patch', async () => {
  for (const { name, source } of variants()) {
    if (source.startsWith(BOM)) continue; // VS Code documents never contain the BOM
    const read = readCanvas(source);
    assert.ok(read.ok, name);
    const node = read.canvas.nodes.find((n) => !read.canvas.duplicateNodeIds.includes(n.id));
    if (node === undefined) continue;
    const expected = computeCanvasPatch(read.doc, read.canvas, [{ kind: 'move', id: node.id, x: node.x + 10, y: node.y - 10 }]);
    assert.ok(expected.ok, name);
    const { doc, panel } = await open(source);
    panel.send({ type: 'move', version: 1, index: node.index, id: node.id, x: node.x + 10, y: node.y - 10, fromX: node.x, fromY: node.y });
    await settle(20);
    assert.equal(doc.text, applyEdits(parseLines(source), expected.edits), name);
    assert.deepEqual(refusals(panel), [], name);
  }
});
