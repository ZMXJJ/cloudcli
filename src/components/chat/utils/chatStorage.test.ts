import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearChatDraftIfUnchanged,
  getChatDraftStorageKey,
  handoffChatDraft,
  isSubmittedChatDraftCurrent,
  newChatDraftKey,
  projectChatDraftKey,
  readChatDraft,
  sessionChatDraftKey,
  writeChatDraft,
  type ChatDraftStorage,
} from './chatStorage';

class MemoryStorage implements ChatDraftStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test('chat drafts isolate New Chat from sessions and migrate legacy text into New Chat once', () => {
  const storage = new MemoryStorage();
  storage.setItem(projectChatDraftKey('project-1'), 'legacy draft');

  assert.equal(readChatDraft('project-1', 'session-1', storage), '');
  assert.equal(storage.getItem(projectChatDraftKey('project-1')), 'legacy draft');

  assert.equal(readChatDraft('project-1', null, storage), 'legacy draft');
  assert.equal(storage.getItem(projectChatDraftKey('project-1')), null);
  assert.equal(storage.getItem(newChatDraftKey('project-1')), 'legacy draft');

  writeChatDraft(getChatDraftStorageKey('project-1', 'session-1'), 'first draft', storage);
  writeChatDraft(getChatDraftStorageKey('project-1', 'session-2'), 'other draft', storage);
  assert.equal(readChatDraft('project-1', 'session-1', storage), 'first draft');
  assert.equal(readChatDraft('project-1', 'session-2', storage), 'other draft');
  assert.equal(readChatDraft('project-1', null, storage), 'legacy draft');
});

test('draft clearing affects only the unchanged storage key', () => {
  const storage = new MemoryStorage();
  const firstKey = sessionChatDraftKey('session-1');
  const secondKey = sessionChatDraftKey('session-2');
  storage.setItem(firstKey, 'sent text');
  storage.setItem(secondKey, 'new text');

  assert.equal(clearChatDraftIfUnchanged(firstKey, 'sent text', storage), true);
  assert.equal(clearChatDraftIfUnchanged(secondKey, 'sent text', storage), false);
  assert.equal(storage.getItem(firstKey), null);
  assert.equal(storage.getItem(secondKey), 'new text');
});

test('a newly allocated session receives the New Chat draft without deleting concurrent edits', () => {
  const storage = new MemoryStorage();
  const sourceKey = newChatDraftKey('project-1');
  const firstTarget = sessionChatDraftKey('session-1');
  storage.setItem(sourceKey, 'send this');

  handoffChatDraft(sourceKey, firstTarget, 'send this', storage);
  assert.equal(storage.getItem(sourceKey), null);
  assert.equal(storage.getItem(firstTarget), 'send this');

  const secondTarget = sessionChatDraftKey('session-2');
  storage.setItem(sourceKey, 'newer text from another tab');
  handoffChatDraft(sourceKey, secondTarget, 'local submitted text', storage);
  assert.equal(storage.getItem(sourceKey), 'newer text from another tab');
  assert.equal(storage.getItem(secondTarget), 'local submitted text');
});

test('async submit cleanup stays bound to its original or newly allocated owner', () => {
  const sourceKey = newChatDraftKey('project-1');
  const targetKey = sessionChatDraftKey('session-1');
  const otherKey = sessionChatDraftKey('session-2');
  const ownership = (currentKey: string, currentContent = 'submitted') => (
    isSubmittedChatDraftCurrent({
      currentKey,
      sourceKey,
      targetKey,
      currentContent,
      submittedContent: 'submitted',
    })
  );

  assert.equal(ownership(sourceKey), true);
  assert.equal(ownership(targetKey), true);
  assert.equal(ownership(otherKey), false);
  assert.equal(ownership(sourceKey, 'new draft'), false);
});
