import os from 'node:os';
import path from 'node:path';

const CODEX_DESKTOP_DATE_DIRECTORY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Codex Desktop stores ordinary recent chats in a generated daily workspace:
 * ~/Documents/Codex/YYYY-MM-DD/<chat-name>. These are conversations, not
 * user-selected projects, so indexing each directory as a project floods the
 * sidebar with disposable one-session entries.
 */
export function isCodexDesktopRecentChatPath(
  projectPath: string,
  homeDirectory = os.homedir(),
): boolean {
  const recentChatsRoot = path.resolve(homeDirectory, 'Documents', 'Codex');
  const relativePath = path.relative(recentChatsRoot, path.resolve(projectPath));

  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return false;
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  return segments.length >= 2 && CODEX_DESKTOP_DATE_DIRECTORY.test(segments[0] ?? '');
}
