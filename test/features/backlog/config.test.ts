// Project detection and config reading (backlog.md 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backlogDirectory, CONFIG_FILES, DEFAULT_CONFIG, DEFAULT_TASK_TYPES, detectProject, parseConfig } from '../../../src/features/backlog/config.ts';

const CONFIG = readFileSync(new URL('../../fixtures/backlog/project/config.yml', import.meta.url), 'utf8');

test('reads the CLI-written config', () => {
  assert.deepEqual(parseConfig(CONFIG), {
    config: { statuses: ['To Do', 'In Progress', 'Done'], defaultStatus: 'To Do', taskPrefix: 'task', labels: [], projectName: 'demo', types: DEFAULT_TASK_TYPES, priorities: DEFAULT_CONFIG.priorities },
  });
});

test('block lists, CRLF and missing keys', () => {
  assert.deepEqual(parseConfig('statuses:\r\n  - Backlog\r\n  - Doing\r\n  - Shipped\r\nlabels: [a, "b c"]\r\n'), {
    config: { statuses: ['Backlog', 'Doing', 'Shipped'], defaultStatus: 'Backlog', taskPrefix: 'task', labels: ['a', 'b c'], projectName: null, types: DEFAULT_TASK_TYPES, priorities: DEFAULT_CONFIG.priorities },
  });
  assert.deepEqual(parseConfig(''), { config: DEFAULT_CONFIG });
});

test('unreadable keys keep their defaults and are named in the error', () => {
  const result = parseConfig('statuses: [To Do, [nested]]\ndefault_status: Doing\ntask_prefix:\n  key: value\nlabels: |\n  x\n');
  assert.deepEqual(result.config, { ...DEFAULT_CONFIG, defaultStatus: 'Doing' });
  assert.equal(result.error, 'Unreadable keys: statuses, task_prefix, labels');
  assert.equal(parseConfig('statuses: []').error, 'Unreadable keys: statuses');
});

test('backlog_directory must stay inside the root', () => {
  const dir = (value: string) => backlogDirectory(`backlog_directory: ${value}\n`);
  assert.equal(dir('work/backlog'), 'work/backlog');
  assert.equal(dir('"./work//backlog/"'), 'work/backlog');
  assert.equal(dir("'.'"), '');
  assert.equal(dir('a\\b'), 'a/b');
  for (const bad of ['/abs', "'C:/x'", '../out', 'a/../../out', 'a/../b', "''", "'file:///x'"]) assert.equal(dir(bad), null, bad);
  assert.equal(backlogDirectory('project_name: x\n'), null);
});

test('detection order: backlog.config.yml, backlog/, .backlog/', async () => {
  const detectIn = (files: Record<string, string>) => detectProject(async (path) => files[path]);
  assert.deepEqual(CONFIG_FILES, ['backlog.config.yml', 'backlog/config.yml', '.backlog/config.yml']);

  const all = { 'backlog.config.yml': 'backlog_directory: plan\nstatuses: [A, B]\n', 'backlog/config.yml': CONFIG, '.backlog/config.yml': CONFIG };
  const first = await detectIn(all);
  assert.equal(first?.configFile, 'backlog.config.yml');
  assert.equal(first?.directory, 'plan');
  assert.deepEqual(first?.config.statuses, ['A', 'B']);

  // An escaping or missing backlog_directory skips that candidate.
  const second = await detectIn({ ...all, 'backlog.config.yml': 'backlog_directory: ../elsewhere\n' });
  assert.deepEqual([second?.configFile, second?.directory], ['backlog/config.yml', 'backlog']);
  const third = await detectIn({ '.backlog/config.yml': 'statuses: oops: x\n' });
  assert.deepEqual([third?.configFile, third?.directory, third?.error], ['.backlog/config.yml', '.backlog', 'Unreadable keys: statuses']);
  assert.equal(await detectIn({ 'docs/backlog/config.yml': CONFIG }), null);
});

test('priorities: as the CLI 1.54.0 reads them (trimmed, deduplicated, defaults when empty)', () => {
  assert.deepEqual(DEFAULT_CONFIG.priorities, ['High', 'Medium', 'Low']);
  assert.deepEqual(parseConfig('statuses: [A]\n').config.priorities, DEFAULT_CONFIG.priorities);
  assert.deepEqual(parseConfig('priorities: []\n').config.priorities, DEFAULT_CONFIG.priorities);
  assert.deepEqual(parseConfig('priorities: [" weird ", "LOW", "low", "high"]\n').config.priorities, ['weird', 'LOW', 'high']);
  assert.deepEqual(parseConfig('priorities:\n  - medium\n  - high\n').config.priorities, ['medium', 'high']);
  assert.deepEqual(parseConfig('priorities: ["Very  Wide", "A\\tB", "very wide"]\n').config.priorities, ['Very Wide', 'A B']);
  assert.equal(parseConfig('priorities:\n  nested: x\n').error, 'Unreadable keys: priorities');
});

test('types: as the CLI reads them (trimmed, deduplicated, defaults when empty)', () => {
  assert.deepEqual(parseConfig('types: ["bug", "Research"]\n').config.types, ['bug', 'Research']);
  assert.deepEqual(parseConfig('types:\n  - bug\n  - " Bug "\n  - spike\n').config.types, ['bug', 'spike']);
  assert.deepEqual(parseConfig('types: []\n').config.types, DEFAULT_TASK_TYPES);
  assert.deepEqual(parseConfig('statuses: [A]\n').config.types, DEFAULT_TASK_TYPES);
  assert.deepEqual(parseConfig('task_types: [x]\n').config.types, DEFAULT_TASK_TYPES, 'not the key the CLI reads');
  assert.equal(parseConfig('types:\n  nested: x\n').error, 'Unreadable keys: types');
});

