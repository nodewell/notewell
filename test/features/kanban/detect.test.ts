import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasKanbanFrontmatter } from '../../../src/features/kanban/detect.ts';

// Link resolution moved to src/vault/links.ts (test/vault/links.test.ts).

test('board detection uses the frontmatter key only', () => {
  assert.equal(hasKanbanFrontmatter('---\nkanban-plugin: basic\n---\n## A\n'), true);
  assert.equal(hasKanbanFrontmatter('\uFEFF---\r\nkanban-plugin: board\r\n---\r\n'), true);
  assert.equal(hasKanbanFrontmatter('---\nkanban-plugin: basic\n## A\n'), false);
  assert.equal(hasKanbanFrontmatter('## A\nkanban-plugin: basic\n'), false);
  assert.equal(hasKanbanFrontmatter('---\ntitle: x\n---\n'), false);
});
