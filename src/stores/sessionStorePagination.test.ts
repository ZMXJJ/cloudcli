import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileOlderPage, reconcileTailPage } from './sessionStorePagination';

interface TestMessage {
  id: string;
  content: string;
}

function messages(from: number, to: number, suffix = ''): TestMessage[] {
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const id = String(from + index);
    return { id, content: `${id}${suffix}` };
  });
}

test('tail refresh retains loaded pages and replaces overlap by stable id', () => {
  const result = reconcileTailPage(
    messages(61, 100),
    messages(83, 102, '-fresh'),
    40,
    102,
  );

  assert.deepEqual(result.messages.map(({ id }) => id), messages(61, 102).map(({ id }) => id));
  assert.equal(result.messages.find(({ id }) => id === '83')?.content, '83-fresh');
  assert.equal(result.offset, 42);
  assert.equal(result.hasMore, true);
});

test('tail refresh keeps fully loaded history fully loaded', () => {
  const result = reconcileTailPage(
    messages(1, 100),
    messages(83, 102),
    100,
    102,
  );

  assert.deepEqual(result.messages.map(({ id }) => id), messages(1, 102).map(({ id }) => id));
  assert.equal(result.offset, 102);
  assert.equal(result.hasMore, false);
});

test('a no-overlap tail preserves old rows and older-page loading fills the gap', () => {
  const refreshed = reconcileTailPage(
    messages(1, 20),
    messages(41, 60),
    20,
    60,
  );

  assert.deepEqual(
    refreshed.messages.map(({ id }) => id),
    [...messages(1, 20), ...messages(41, 60)].map(({ id }) => id),
  );
  assert.equal(refreshed.offset, 20);
  assert.equal(refreshed.hasMore, true);

  const bridged = reconcileOlderPage(
    refreshed.messages,
    messages(21, 40),
    refreshed.offset,
    60,
  );
  assert.deepEqual(bridged.messages.map(({ id }) => id), messages(1, 60).map(({ id }) => id));
  assert.equal(bridged.offset, 40);
  assert.equal(bridged.hasMore, true);

  const completed = reconcileOlderPage(
    bridged.messages,
    messages(1, 20, '-fresh'),
    bridged.offset,
    60,
  );
  assert.deepEqual(completed.messages.map(({ id }) => id), messages(1, 60).map(({ id }) => id));
  assert.equal(completed.messages[0]?.content, '1-fresh');
  assert.equal(completed.offset, 60);
  assert.equal(completed.hasMore, false);
});

test('a smaller server total invalidates cached fragments before realtime reconciliation', () => {
  const result = reconcileTailPage(
    [...messages(1, 20), ...messages(81, 100)],
    messages(31, 50, '-fresh'),
    20,
    50,
    100,
  );

  assert.deepEqual(result.messages, messages(31, 50, '-fresh'));
  assert.equal(result.offset, 20);
  assert.equal(result.hasMore, true);
});

test('a smaller total retains an overlap-anchored prefix and removes the old suffix', () => {
  const result = reconcileTailPage(
    [...messages(1, 20), ...messages(41, 60)],
    messages(15, 34, '-fresh'),
    20,
    34,
    60,
  );

  assert.deepEqual(result.messages.map(({ id }) => id), messages(1, 34).map(({ id }) => id));
  assert.equal(result.messages.find(({ id }) => id === '15')?.content, '15-fresh');
  assert.equal(result.messages.some(({ id }) => Number(id) >= 35), false);
  assert.equal(result.offset, 34);
  assert.equal(result.hasMore, false);
});

test('a smaller total with no overlap does not retain a stale old segment', () => {
  const result = reconcileTailPage(
    [...messages(1, 20), ...messages(41, 60)],
    messages(101, 120, '-fresh'),
    20,
    34,
    60,
  );

  assert.deepEqual(result.messages, messages(101, 120, '-fresh'));
  assert.equal(result.offset, 20);
  assert.equal(result.hasMore, true);
});

test('a fully truncated transcript clears cached messages', () => {
  const result = reconcileTailPage(messages(1, 20), [], 20, 0, 20);

  assert.deepEqual(result.messages, []);
  assert.equal(result.offset, 0);
  assert.equal(result.hasMore, false);
});

test('successive no-overlap tails retain segments while fetchMore closes each gap', () => {
  const firstRefresh = reconcileTailPage(messages(1, 20), messages(41, 60), 20, 60, 20);
  const secondRefresh = reconcileTailPage(
    firstRefresh.messages,
    messages(81, 100),
    firstRefresh.offset,
    100,
    60,
  );

  assert.deepEqual(
    secondRefresh.messages.map(({ id }) => id),
    [...messages(1, 20), ...messages(41, 60), ...messages(81, 100)].map(({ id }) => id),
  );
  assert.equal(secondRefresh.offset, 20);

  const firstGap = reconcileOlderPage(
    secondRefresh.messages,
    messages(61, 80),
    secondRefresh.offset,
    100,
  );
  assert.deepEqual(
    firstGap.messages.map(({ id }) => id),
    [...messages(1, 20), ...messages(41, 100)].map(({ id }) => id),
  );
  assert.equal(firstGap.offset, 40);

  const secondGap = reconcileOlderPage(firstGap.messages, messages(41, 60), firstGap.offset, 100);
  assert.deepEqual(
    secondGap.messages.map(({ id }) => id),
    [...messages(1, 20), ...messages(41, 100)].map(({ id }) => id),
  );
  assert.equal(secondGap.offset, 60);

  const completed = reconcileOlderPage(secondGap.messages, messages(21, 40), secondGap.offset, 100);
  assert.deepEqual(completed.messages.map(({ id }) => id), messages(1, 100).map(({ id }) => id));
  assert.equal(completed.offset, 80);
  assert.equal(completed.hasMore, true);
});

test('an older page overlapping the current tail refreshes rows without inflating offset', () => {
  const result = reconcileOlderPage(
    messages(41, 60),
    messages(31, 50, '-fresh'),
    20,
    60,
  );

  assert.deepEqual(result.messages.map(({ id }) => id), messages(31, 60).map(({ id }) => id));
  assert.equal(result.messages.find(({ id }) => id === '41')?.content, '41-fresh');
  assert.equal(result.offset, 30);
  assert.equal(result.hasMore, true);
});
