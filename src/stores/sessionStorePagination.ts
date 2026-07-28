export interface StableMessage {
  id: string;
}

export interface ReconciledMessagePage<T> {
  messages: T[];
  offset: number;
  hasMore: boolean;
}

function dedupeByStableId<T extends StableMessage>(messages: T[]): T[] {
  const result: T[] = [];
  const indices = new Map<string, number>();

  for (const message of messages) {
    const existingIndex = indices.get(message.id);
    if (existingIndex === undefined) {
      indices.set(message.id, result.length);
      result.push(message);
    } else {
      result[existingIndex] = message;
    }
  }

  return result;
}

function clampCount(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.floor(value)), Math.max(0, maximum));
}

function trimToTotal<T>(messages: T[], total: number): T[] {
  if (messages.length <= total) return messages;
  return messages.slice(messages.length - total);
}

/**
 * Replaces the overlapping tail by stable message id while retaining every
 * older page already held by the client. When more than one tail page arrived
 * between refreshes there may be no overlap; in that case the old and new
 * segments remain visible and `offset` deliberately tracks only the contiguous
 * newest segment so fetchMore can fill the gap.
 */
export function reconcileTailPage<T extends StableMessage>(
  existingMessages: T[],
  tailMessages: T[],
  previousOffset: number,
  total: number,
  previousTotal?: number,
): ReconciledMessagePage<T> {
  const normalizedTotal = clampCount(total, Number.MAX_SAFE_INTEGER);
  const tail = dedupeByStableId(tailMessages);
  const normalizedPreviousTotal = previousTotal === undefined
    ? null
    : clampCount(previousTotal, Number.MAX_SAFE_INTEGER);
  const tailIds = new Set(tail.map(({ id }) => id));
  const overlapIndex = existingMessages.findIndex(({ id }) => tailIds.has(id));

  // A smaller transcript is a new pagination generation. Drop the old suffix
  // unconditionally. A stable-id overlap can still anchor the prefix preceding
  // that overlap; without one, only the authoritative tail is safe to retain.
  if (
    existingMessages.length > normalizedTotal
    || (normalizedPreviousTotal !== null && normalizedTotal < normalizedPreviousTotal)
  ) {
    const anchoredMessages = overlapIndex >= 0
      ? dedupeByStableId([
        ...existingMessages.slice(0, overlapIndex),
        ...tail,
      ])
      : tail;
    const canRetainAnchoredPrefix = overlapIndex >= 0
      && anchoredMessages.length <= normalizedTotal;
    const messages = trimToTotal(
      canRetainAnchoredPrefix ? anchoredMessages : tail,
      normalizedTotal,
    );
    const offset = canRetainAnchoredPrefix && messages.length === normalizedTotal
      ? normalizedTotal
      : Math.min(tail.length, messages.length);
    return {
      messages,
      offset,
      hasMore: offset < normalizedTotal,
    };
  }

  const contiguousStart = Math.max(
    0,
    existingMessages.length - clampCount(previousOffset, existingMessages.length),
  );

  let messages: T[];
  let offset: number;
  if (overlapIndex >= 0) {
    messages = dedupeByStableId([
      ...existingMessages.slice(0, overlapIndex),
      ...tail,
    ]);
    offset = overlapIndex >= contiguousStart
      ? overlapIndex - contiguousStart + tail.length
      : tail.length;
  } else {
    messages = dedupeByStableId([...existingMessages, ...tail]);
    offset = tail.length;
  }

  messages = trimToTotal(messages, normalizedTotal);
  offset = clampCount(offset, normalizedTotal);
  return {
    messages,
    offset,
    hasMore: offset < normalizedTotal,
  };
}

/**
 * Inserts the next older REST page immediately before the contiguous tail.
 * This also closes a gap retained by reconcileTailPage after a no-overlap
 * refresh without discarding older rows that were already loaded.
 */
export function reconcileOlderPage<T extends StableMessage>(
  existingMessages: T[],
  olderMessages: T[],
  previousOffset: number,
  total: number,
): ReconciledMessagePage<T> {
  const normalizedTotal = clampCount(total, Number.MAX_SAFE_INTEGER);
  const normalizedOffset = clampCount(previousOffset, existingMessages.length);
  const contiguousStart = existingMessages.length - normalizedOffset;
  const preservedOlder = existingMessages.slice(0, contiguousStart);
  const currentTail = existingMessages.slice(contiguousStart);
  const older = dedupeByStableId(olderMessages);
  const currentTailIds = new Set(currentTail.map(({ id }) => id));
  const olderById = new Map(older.map((message) => [message.id, message]));
  const refreshedCurrentTail = currentTail.map((message) => (
    olderById.get(message.id) ?? message
  ));
  const newlyContiguousOlder = older.filter(({ id }) => !currentTailIds.has(id));

  const combinedOlder = reconcileTailPage(
    preservedOlder,
    older,
    preservedOlder.length,
    normalizedTotal,
  ).messages.filter(({ id }) => !currentTailIds.has(id));
  const messages = trimToTotal(
    dedupeByStableId([...combinedOlder, ...refreshedCurrentTail]),
    normalizedTotal,
  );
  const offset = clampCount(
    normalizedOffset + newlyContiguousOlder.length,
    Math.min(normalizedTotal, messages.length),
  );

  return {
    messages,
    offset,
    hasMore: offset < normalizedTotal,
  };
}
