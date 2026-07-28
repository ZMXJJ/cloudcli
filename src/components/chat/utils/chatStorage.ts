import type { ClaudeSettings } from '../types/types';

export const CLAUDE_SETTINGS_KEY = 'claude-settings';

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        const draftKeys = keys.filter((k) => k.startsWith('draft_input_') || k.startsWith('queued_message_'));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
  keys: (): string[] => {
    try {
      return Object.keys(localStorage);
    } catch (error) {
      console.error('localStorage keys error:', error);
      return [];
    }
  },
};

export type ChatDraftStorage = Pick<
  typeof safeLocalStorage,
  'getItem' | 'setItem' | 'removeItem'
>;

/** Pre-session project draft key used by older releases. */
export const projectChatDraftKey = (projectId: string) => `draft_input_${projectId}`;
export const newChatDraftKey = (projectId: string) => `draft_input_new_${projectId}`;
export const sessionChatDraftKey = (sessionId: string) => `draft_input_session_${sessionId}`;

export function getChatDraftStorageKey(projectId: string, sessionId?: string | null): string {
  return sessionId ? sessionChatDraftKey(sessionId) : newChatDraftKey(projectId);
}

/**
 * Restores a session-owned or New Chat draft. Legacy project-wide drafts are
 * migrated only into New Chat; assigning one to an arbitrary existing session
 * would steal a currently composed New Chat draft from older releases.
 */
export function readChatDraft(
  projectId: string,
  sessionId?: string | null,
  storage: ChatDraftStorage = safeLocalStorage,
): string {
  const key = getChatDraftStorageKey(projectId, sessionId);
  const current = storage.getItem(key);
  if (current !== null) return current;
  if (sessionId) return '';

  const legacyKey = projectChatDraftKey(projectId);
  const legacy = storage.getItem(legacyKey);
  if (legacy === null) return '';
  storage.setItem(key, legacy);
  storage.removeItem(legacyKey);
  return legacy;
}

/**
 * Gives a newly allocated session its New Chat draft before navigation. The
 * target is written from the in-memory value even if React has not flushed its
 * persistence effect yet; a concurrently changed source draft is preserved.
 */
export function handoffChatDraft(
  sourceKey: string | null | undefined,
  targetKey: string,
  content: string,
  storage: ChatDraftStorage = safeLocalStorage,
): void {
  if (!sourceKey || sourceKey === targetKey) return;
  writeChatDraft(targetKey, content, storage);
  clearChatDraftIfUnchanged(sourceKey, content, storage);
}

export function isSubmittedChatDraftCurrent({
  currentKey,
  sourceKey,
  targetKey,
  currentContent,
  submittedContent,
}: {
  currentKey: string | null | undefined;
  sourceKey: string | null | undefined;
  targetKey: string;
  currentContent: string;
  submittedContent: string;
}): boolean {
  return (
    currentContent === submittedContent
    && (currentKey === sourceKey || currentKey === targetKey)
  );
}

export function writeChatDraft(
  key: string,
  content: string,
  storage: ChatDraftStorage = safeLocalStorage,
): void {
  if (content) {
    storage.setItem(key, content);
  } else {
    storage.removeItem(key);
  }
}

export function clearChatDraftIfUnchanged(
  key: string | null | undefined,
  expectedContent: string,
  storage: ChatDraftStorage = safeLocalStorage,
): boolean {
  if (!key || storage.getItem(key) !== expectedContent) return false;
  storage.removeItem(key);
  return true;
}

/**
 * Composer options captured when a message is queued, so the message can be
 * sent later with the exact settings (model, permission mode, tools) the
 * session's composer had at queue time — even from outside the composer,
 * e.g. the app-level auto-send that fires while another session is viewed.
 */
export type QueuedSendOptions = Record<string, unknown>;

export type StoredQueuedMessage = {
  content: string;
  options?: QueuedSendOptions;
};

export const queuedMessageKey = (sessionId: string) => `queued_message_${sessionId}`;

/**
 * Reads a session's queued message. Understands both the JSON
 * `{ content, options }` format and the legacy raw-text format.
 */
export function readQueuedMessage(sessionId: string): StoredQueuedMessage | null {
  const raw = safeLocalStorage.getItem(queuedMessageKey(sessionId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as StoredQueuedMessage).content === 'string') {
      const { content, options } = parsed as StoredQueuedMessage;
      return content.trim() ? { content, options } : null;
    }
  } catch {
    // Legacy format: the raw draft text itself.
  }

  return raw.trim() ? { content: raw } : null;
}

export function writeQueuedMessage(sessionId: string, message: StoredQueuedMessage): void {
  safeLocalStorage.setItem(queuedMessageKey(sessionId), JSON.stringify(message));
}

export function clearQueuedMessage(sessionId: string): void {
  safeLocalStorage.removeItem(queuedMessageKey(sessionId));
}

export function getClaudeSettings(): ClaudeSettings {
  const raw = safeLocalStorage.getItem(CLAUDE_SETTINGS_KEY);
  if (!raw) {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      skipPermissions: Boolean(parsed.skipPermissions),
      projectSortOrder: parsed.projectSortOrder || 'name',
    };
  } catch {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }
}
