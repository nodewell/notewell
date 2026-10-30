// Project-relative paths from task files and webview messages (backlog.md 4.4, 5.1). Pure:
// the panel resolves the result against the workspace folder root.

/**
 * The normalized POSIX path of `path` inside the project root, or undefined when it is
 * absolute, has a scheme or drive, or leaves the root through `..`. `\` counts as a separator
 * (Windows-written paths); `.` and empty segments are dropped. The root itself is undefined.
 */
export function resolveProjectPath(path: string): string | undefined {
  if (path === '' || path.includes('\0')) return undefined;
  const posix = path.replaceAll('\\', '/');
  // Absolute (`/x`, `//server`), drive (`C:`), or a scheme (`file:`, `vscode:`).
  if (posix.startsWith('/') || /^[A-Za-z][\w+.-]*:/.test(posix)) return undefined;
  const segments: string[] = [];
  for (const segment of posix.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    // Windows drops trailing dots and spaces (`.. ` is `..`), and `:` names an NTFS stream.
    const windowsName = segment.replace(/[. ]+$/, '');
    if (windowsName === '' || windowsName === '.' || windowsName === '..' || segment.includes(':')) return undefined;
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join('/');
}
