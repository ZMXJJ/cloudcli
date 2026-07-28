import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PENDING_LOOP_INPUTS_STORAGE_KEY,
  PENDING_LOOP_INPUT_STORAGE_PREFIX,
  consumeAutomationCommandState,
  consumeAutomationInputAck,
  consumeChatRequestRejection,
  getActiveAutomationGeneration,
  guardProcessingForAutomationGeneration,
  isPendingLoopInputStorageKey,
  mergeRejectedPendingContent,
  persistPendingLoopInput,
  readPendingLoopInputs,
  removePendingLoopInput,
  retryPendingLoopInputs,
  toPendingChatRequestResult,
  type PendingLoopInputStorage,
} from './pendingChatRequests';

class MemoryStorage implements PendingLoopInputStorage {
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

  keys(): string[] {
    return [...this.values.keys()];
  }
}

const storedInput = {
  requestId: 'request-1',
  sessionId: 'session-1',
  content: 'continue the loop',
  automationId: 'automation-1',
  createdAt: '2026-07-28T10:00:00.000Z',
  draftStorageKey: 'draft_input_session_session-1',
};

test('restores valid pending Loop input and cleans malformed localStorage entries', () => {
  const storage = new MemoryStorage();
  storage.setItem(PENDING_LOOP_INPUTS_STORAGE_KEY, JSON.stringify([
    storedInput,
    { ...storedInput, requestId: '', automationId: '' },
  ]));

  const pending = readPendingLoopInputs(storage);

  assert.equal(pending.size, 1);
  assert.equal(pending.get('request-1')?.automationId, 'automation-1');
  assert.equal(
    new Date(pending.get('request-1')?.localMessage?.timestamp ?? 0).toISOString(),
    storedInput.createdAt,
  );
  assert.equal(storage.getItem(PENDING_LOOP_INPUTS_STORAGE_KEY), null);
  const requestKeys = storage.keys().filter((key) => key.startsWith(PENDING_LOOP_INPUT_STORAGE_PREFIX));
  assert.equal(requestKeys.length, 1);
  assert.deepEqual(JSON.parse(storage.getItem(requestKeys[0]) ?? '{}'), storedInput);

  const malformedStorage = new MemoryStorage();
  malformedStorage.setItem(PENDING_LOOP_INPUTS_STORAGE_KEY, '{invalid json');
  assert.equal(readPendingLoopInputs(malformedStorage).size, 0);
  assert.equal(malformedStorage.getItem(PENDING_LOOP_INPUTS_STORAGE_KEY), null);
});

test('retry preserves request and automation generation and keeps failed sends pending', () => {
  const storage = new MemoryStorage();
  storage.setItem(PENDING_LOOP_INPUTS_STORAGE_KEY, JSON.stringify([storedInput]));
  const pending = readPendingLoopInputs(storage);
  const attempted: unknown[] = [];

  assert.deepEqual(retryPendingLoopInputs(pending, (message) => {
    attempted.push(message);
    return false;
  }), []);
  assert.equal(pending.size, 1);

  assert.deepEqual(retryPendingLoopInputs(pending, (message) => {
    attempted.push(message);
    return true;
  }), ['session-1']);
  assert.deepEqual(attempted[1], {
    type: 'chat.send',
    sessionId: 'session-1',
    requestId: 'request-1',
    automationId: 'automation-1',
    content: 'continue the loop',
    options: { images: [] },
  });
  assert.equal(pending.size, 1);
});

test('request-scoped persistence preserves other tabs and removes only the matching receipt', () => {
  const storage = new MemoryStorage();
  const request = (requestId: string, content: string) => ({
    requestId,
    sessionId: 'session-1',
    content,
    markedProcessing: true,
    clearInputOnAck: true,
    automationId: 'automation-1',
    draftStorageKey: 'draft_input_session_session-1',
    localMessage: null,
  });
  const first = request('request-a', 'from tab A');
  const second = request('request-b', 'from tab B');

  persistPendingLoopInput(first, storage);
  persistPendingLoopInput(second, storage);
  assert.deepEqual([...readPendingLoopInputs(storage).keys()].sort(), ['request-a', 'request-b']);

  removePendingLoopInput(second, storage);
  assert.deepEqual([...readPendingLoopInputs(storage).keys()], ['request-a']);
  assert.equal(isPendingLoopInputStorageKey(PENDING_LOOP_INPUTS_STORAGE_KEY), true);
  assert.equal(isPendingLoopInputStorageKey(`${PENDING_LOOP_INPUT_STORAGE_PREFIX}request-a`), true);
  assert.equal(isPendingLoopInputStorageKey('unrelated'), false);
});

test('ACK and protocol errors consume only the matching session and automation generation', () => {
  const storage = new MemoryStorage();
  storage.setItem(PENDING_LOOP_INPUTS_STORAGE_KEY, JSON.stringify([storedInput]));
  const pending = readPendingLoopInputs(storage);

  assert.equal(
    consumeAutomationInputAck(pending, 'session-1', 'request-1', 'automation-new'),
    null,
  );
  assert.equal(
    consumeChatRequestRejection(pending, 'session-1', 'request-1', 'automation-new'),
    null,
  );
  assert.equal(pending.size, 1);

  const acknowledged = consumeAutomationInputAck(
    pending,
    'session-1',
    'request-1',
    'automation-1',
  );
  assert.equal(acknowledged?.content, 'continue the loop');
  if (acknowledged) removePendingLoopInput(acknowledged, storage);
  assert.equal(readPendingLoopInputs(storage).size, 0);
});

test('old-generation responses cannot clear processing owned by a replacement automation', () => {
  const storage = new MemoryStorage();
  storage.setItem(PENDING_LOOP_INPUTS_STORAGE_KEY, JSON.stringify([storedInput]));
  const pending = readPendingLoopInputs(storage);
  const rejected = consumeChatRequestRejection(
    pending,
    'session-1',
    'request-1',
    'automation-1',
  );
  const result = toPendingChatRequestResult(rejected);

  assert.equal(result.clearProcessing, true);
  assert.equal(
    guardProcessingForAutomationGeneration(result, 'automation-new').clearProcessing,
    false,
  );
  assert.equal(
    guardProcessingForAutomationGeneration(result, 'automation-1').clearProcessing,
    true,
  );
});

test('out-of-order automation states settle only their correlated detached command', () => {
  const detachedRequest = (requestId: string) => ({
    requestId,
    sessionId: 'session-1',
    content: '/goal',
    markedProcessing: false,
    clearInputOnAck: false,
    automationId: 'automation-1',
    draftStorageKey: null,
    localMessage: null,
  });
  const pending = new Map([
    ['request-1', detachedRequest('request-1')],
    ['request-2', detachedRequest('request-2')],
  ]);

  assert.equal(
    consumeAutomationCommandState(pending, 'session-1', 'uncorrelated-broadcast'),
    null,
  );
  assert.equal(pending.size, 2);

  assert.equal(
    consumeAutomationCommandState(pending, 'session-other', 'request-2'),
    null,
  );
  assert.equal(pending.size, 2);

  assert.equal(
    consumeAutomationCommandState(pending, 'session-1', 'request-2')?.requestId,
    'request-2',
  );
  assert.deepEqual([...pending.keys()], ['request-1']);
  assert.equal(
    consumeAutomationCommandState(pending, 'session-1', 'request-1')?.requestId,
    'request-1',
  );
  assert.equal(pending.size, 0);
});

test('automation state confirmation does not consume a regular ChatRun request', () => {
  const pending = new Map([
    ['request-1', {
      requestId: 'request-1',
      sessionId: 'session-1',
      content: '/goal tests pass',
      markedProcessing: true,
      clearInputOnAck: false,
      automationId: null,
      draftStorageKey: null,
      localMessage: null,
    }],
  ]);

  assert.equal(
    consumeAutomationCommandState(pending, 'session-1', 'request-1'),
    null,
  );
  assert.equal(pending.size, 1);
});

test('only active automation states claim a generation on chat.send', () => {
  for (const state of ['starting', 'running', 'stopping'] as const) {
    assert.equal(
      getActiveAutomationGeneration({ automationId: 'automation-1', state }),
      'automation-1',
    );
  }

  // A terminal status bar may remain visible until Dismiss, but ordinary
  // chat must no longer be routed as input for that finished automation.
  for (const state of ['completed', 'stopped', 'failed'] as const) {
    assert.equal(
      getActiveAutomationGeneration({ automationId: 'automation-1', state }),
      null,
    );
  }
  assert.equal(getActiveAutomationGeneration(null), null);
});

test('a rejected restored Loop input is merged back idempotently across tabs', () => {
  assert.equal(
    mergeRejectedPendingContent('continue the loop', ''),
    'continue the loop',
  );
  assert.equal(
    mergeRejectedPendingContent('continue the loop', 'new notes'),
    'continue the loop\n\nnew notes',
  );
  assert.equal(
    mergeRejectedPendingContent('continue the loop', 'continue the loop'),
    'continue the loop',
  );
  assert.equal(
    mergeRejectedPendingContent(
      'continue the loop',
      'continue the loop\n\nnew notes',
    ),
    'continue the loop\n\nnew notes',
  );
});
