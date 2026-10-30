// Text of a new board file (kanban.md 4.5), in Obsidian Kanban's own format so Obsidian
// opens it as a board too. Pure.

/** Lane names for a VS Code display language (`vscode.env.language`, e.g. `ko`, `en-us`). */
export function defaultLaneNames(locale: string): readonly [string, string, string] {
  return locale.toLowerCase().startsWith('ko') ? ['할 일', '진행 중', '완료'] : ['To Do', 'Doing', 'Done'];
}

/** Line ending for new files: `files.eol` (`\n`, `\r\n`, or `auto` = the OS default). */
export function eolFor(setting: unknown, platform: string): '\n' | '\r\n' {
  if (setting === '\n' || setting === '\r\n') return setting;
  return platform === 'win32' ? '\r\n' : '\n';
}

/**
 * A new board: `kanban-plugin: board` frontmatter, three empty lanes (the last one marked
 * `**Complete**`, i.e. a done lane), and Obsidian Kanban's default settings block.
 */
export function newBoardText(locale: string, eol: '\n' | '\r\n'): string {
  const [todo, doing, done] = defaultLaneNames(locale);
  const lines = [
    '---',
    '',
    'kanban-plugin: board',
    '',
    '---',
    '',
    `## ${todo}`,
    '',
    '',
    '',
    `## ${doing}`,
    '',
    '',
    '',
    `## ${done}`,
    '',
    '**Complete**',
    '',
    '',
    '',
    '%% kanban:settings',
    '```',
    '{"kanban-plugin":"board"}',
    '```',
    '%%',
  ];
  return lines.map((line) => line + eol).join('');
}
