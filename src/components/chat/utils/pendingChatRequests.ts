import type { ChatAutomation, ChatMessage } from '../types/types';

import { safeLocalStorage, sessionChatDraftKey } from './chatStorage';

/** Legacy aggregate key, read once and migrated to request-scoped records. */
export const PENDING_LOOP_INPUTS_STORAGE_KEY = 'cloudcli_pending_loop_inputs_v1';
export const PENDING_LOOP_INPUT_STORAGE_PREFIX = 'cloudcli_pending_loop_input_v2:';

export type PendingChatRequest = {
  requestId: string;
  sessionId: string;
  content: string;
  markedProcessing: boolean;
  clearInputOnAck: boolean;
  automationId: string | null;
  draftStorageKey: string | null;
  localMessage: ChatMessage | null;
};

export type PendingChatRequestResult = {
  matched: boolean;
  clearProcessing: boolean;
  automationId: string | null;
};

type StoredPendingLoopInput = {
  requestId: string;
  sessionId: string;
  content: string;
  automationId: string;
  createdAt: string;
  draftStorageKey?: string;
};

export type PendingLoopInputStorage = Pick<
  typeof safeLocalStorage,
  'getItem' | 'setItem' | 'removeItem' | 'keys'
>;

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

const getPendingLoopInputStorageKey = (requestId: string): string => (
  `${PENDING_LOOP_INPUT_STORAGE_PREFIX}${encodeURIComponent(requestId)}`
);

export function isPendingLoopInputStorageKey(key: string | null): boolean {
  return key === PENDING_LOOP_INPUTS_STORAGE_KEY
    || Boolean(key?.startsWith(PENDING_LOOP_INPUT_STORAGE_PREFIX));
}

const ACTIVE_AUTOMATION_STATES = new Set<ChatAutomation['state']>([
  'starting',
  'running',
  'stopping',
]);

export function getActiveAutomationGeneration(
  automation: Pick<ChatAutomation, 'automationId' | 'state'> | null,
): string | null {
  return automation && ACTIVE_AUTOMATION_STATES.has(automation.state)
    ? automation.automationId
    : null;
}

function toStoredPendingLoopInput(request: PendingChatRequest): StoredPendingLoopInput | null {
  if (!request.clearInputOnAck || !request.automationId) return null;
  const timestamp = new Date(request.localMessage?.timestamp ?? Date.now());
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    content: request.content,
    automationId: request.automationId,
    createdAt: Number.isNaN(timestamp.getTime())
      ? new Date().toISOString()
      : timestamp.toISOString(),
    draftStorageKey: request.draftStorageKey ?? sessionChatDraftKey(request.sessionId),
  };
}

function parseStoredPendingLoopInput(value: unknown): PendingChatRequest | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StoredPendingLoopInput>;
  if (
    !isNonEmptyString(candidate.requestId)
    || candidate.requestId.length > 128
    || !isNonEmptyString(candidate.sessionId)
    || !isNonEmptyString(candidate.content)
    || !isNonEmptyString(candidate.automationId)
  ) {
    return null;
  }

  const timestamp = typeof candidate.createdAt === 'string'
    ? new Date(candidate.createdAt)
    : new Date();
  const draftStorageKey = isNonEmptyString(candidate.draftStorageKey)
    && candidate.draftStorageKey.startsWith('draft_input_session_')
    ? candidate.draftStorageKey
    : sessionChatDraftKey(candidate.sessionId);
  return {
    requestId: candidate.requestId,
    sessionId: candidate.sessionId,
    content: candidate.content,
    markedProcessing: true,
    clearInputOnAck: true,
    automationId: candidate.automationId,
    draftStorageKey,
    localMessage: {
      type: 'user',
      content: candidate.content,
      timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
    },
  };
}

export function persistPendingLoopInput(
  request: PendingChatRequest,
  storage: PendingLoopInputStorage = safeLocalStorage,
): void {
  const stored = toStoredPendingLoopInput(request);
  if (!stored) return;
  storage.setItem(
    getPendingLoopInputStorageKey(request.requestId),
    JSON.stringify(stored),
  );
}

/** Upserts every request without deleting records owned by another tab. */
export function persistPendingLoopInputs(
  pending: Map<string, PendingChatRequest>,
  storage: PendingLoopInputStorage = safeLocalStorage,
): void {
  for (const request of pending.values()) {
    persistPendingLoopInput(request, storage);
  }
}

export function removePendingLoopInput(
  request: PendingChatRequest,
  storage: PendingLoopInputStorage = safeLocalStorage,
): void {
  const key = getPendingLoopInputStorageKey(request.requestId);
  const raw = storage.getItem(key);
  if (!raw) return;

  let stored: PendingChatRequest | null = null;
  try {
    stored = parseStoredPendingLoopInput(JSON.parse(raw) as unknown);
  } catch {
    // Malformed request-scoped data is safe to discard.
  }
  if (
    !stored
    || (
      stored.sessionId === request.sessionId
      && stored.automationId === request.automationId
    )
  ) {
    storage.removeItem(key);
  }
}

export function readPendingLoopInputs(
  storage: PendingLoopInputStorage = safeLocalStorage,
): Map<string, PendingChatRequest> {
  const pending = new Map<string, PendingChatRequest>();
  for (const key of storage.keys()) {
    if (!key.startsWith(PENDING_LOOP_INPUT_STORAGE_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    let request: PendingChatRequest | null = null;
    try {
      request = parseStoredPendingLoopInput(JSON.parse(raw) as unknown);
    } catch {
      // Removed below.
    }
    if (!request) {
      storage.removeItem(key);
      continue;
    }
    const canonicalKey = getPendingLoopInputStorageKey(request.requestId);
    if (key !== canonicalKey) {
      storage.removeItem(key);
      persistPendingLoopInput(request, storage);
    }
    pending.set(request.requestId, request);
  }

  // Migrate the aggregate v1 snapshot. Request-scoped keys make independent
  // tabs unable to erase each other's recovery records.
  const legacyRaw = storage.getItem(PENDING_LOOP_INPUTS_STORAGE_KEY);
  if (legacyRaw) {
    let legacy: unknown = null;
    try {
      legacy = JSON.parse(legacyRaw) as unknown;
    } catch {
      // Removed below.
    }
    if (Array.isArray(legacy)) {
      for (const value of legacy) {
        const request = parseStoredPendingLoopInput(value);
        if (!request || pending.has(request.requestId)) continue;
        pending.set(request.requestId, request);
        persistPendingLoopInput(request, storage);
      }
    }
    storage.removeItem(PENDING_LOOP_INPUTS_STORAGE_KEY);
  }
  return pending;
}

export function consumeAutomationInputAck(
  pending: Map<string, PendingChatRequest>,
  sessionId: string,
  requestId: string,
  automationId: string,
): PendingChatRequest | null {
  const request = pending.get(requestId);
  if (
    !request
    || request.sessionId !== sessionId
    || !request.clearInputOnAck
    || request.automationId !== automationId
  ) {
    return null;
  }
  pending.delete(requestId);
  return request;
}

export function consumeChatRequestRejection(
  pending: Map<string, PendingChatRequest>,
  sessionId: string,
  requestId: string,
  automationId?: string | null,
): PendingChatRequest | null {
  const request = pending.get(requestId);
  if (
    !request
    || request.sessionId !== sessionId
    || (request.automationId && automationId && request.automationId !== automationId)
  ) {
    return null;
  }
  pending.delete(requestId);
  return request;
}

export function consumeAutomationCommandState(
  pending: Map<string, PendingChatRequest>,
  sessionId: string,
  requestId: string,
): PendingChatRequest | null {
  const request = pending.get(requestId);
  if (
    !request
    || request.sessionId !== sessionId
    || request.markedProcessing
  ) {
    return null;
  }
  pending.delete(requestId);
  return request;
}

export function toPendingChatRequestResult(
  request: PendingChatRequest | null,
): PendingChatRequestResult {
  return request
    ? {
        matched: true,
        clearProcessing: request.markedProcessing,
        automationId: request.automationId,
      }
    : { matched: false, clearProcessing: false, automationId: null };
}

export function guardProcessingForAutomationGeneration(
  result: PendingChatRequestResult,
  currentAutomationId: string | null | undefined,
): PendingChatRequestResult {
  if (
    !result.clearProcessing
    || !result.automationId
    || !currentAutomationId
    || result.automationId === currentAutomationId
  ) {
    return result;
  }
  return { ...result, clearProcessing: false };
}

export function mergeRejectedPendingContent(
  pendingContent: string,
  currentDraft: string,
): string {
  if (
    currentDraft === pendingContent
    || currentDraft.startsWith(`${pendingContent}\n\n`)
  ) {
    return currentDraft;
  }
  return currentDraft.trim()
    ? `${pendingContent}\n\n${currentDraft}`
    : pendingContent;
}

export function hasPendingLoopInput(
  pending: Map<string, PendingChatRequest>,
  sessionId: string,
): boolean {
  return Array.from(pending.values()).some(
    (request) => request.sessionId === sessionId && request.clearInputOnAck,
  );
}

export function retryPendingLoopInputs(
  pending: Map<string, PendingChatRequest>,
  sendMessage: (message: unknown) => boolean,
): string[] {
  const retriedSessionIds = new Set<string>();
  for (const request of pending.values()) {
    if (!request.clearInputOnAck || !request.automationId) continue;
    const sent = sendMessage({
      type: 'chat.send',
      sessionId: request.sessionId,
      requestId: request.requestId,
      automationId: request.automationId,
      content: request.content,
      options: { images: [] },
    });
    if (sent) retriedSessionIds.add(request.sessionId);
  }
  return [...retriedSessionIds];
}
