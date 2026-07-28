import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

test('Claude history paginates the same visible rows it reports in total', { concurrency: false }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-history-pagination-'));
  const databasePath = path.join(directory, 'auth.db');
  const transcriptPath = path.join(directory, 'session.jsonl');
  const sessionId = 'claude-history-pagination-session';

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    const rows = [
      {
        uuid: 'assistant-tool-1',
        sessionId,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] },
      },
      {
        uuid: 'result-1',
        sessionId,
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'one' }] },
      },
      {
        uuid: 'assistant-text-1',
        sessionId,
        timestamp: '2026-01-01T00:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'between tools' }] },
      },
      {
        uuid: 'assistant-tool-2',
        sessionId,
        timestamp: '2026-01-01T00:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: {} }] },
      },
      {
        uuid: 'result-2',
        sessionId,
        timestamp: '2026-01-01T00:00:05.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'two' }] },
      },
      {
        uuid: 'assistant-text-2',
        sessionId,
        timestamp: '2026-01-01T00:00:06.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }] },
      },
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    sessionsDb.createSession(
      sessionId,
      'claude',
      directory,
      'Pagination test',
      undefined,
      undefined,
      transcriptPath,
    );

    const provider = new ClaudeSessionsProvider();
    const newest = await provider.fetchHistory(sessionId, { limit: 2, offset: 0 });
    assert.equal(newest.total, 4);
    assert.equal(newest.hasMore, true);
    assert.deepEqual(newest.messages.map(({ id }) => id), [
      'assistant-tool-2_0',
      'assistant-text-2_0',
    ]);
    assert.equal(newest.messages[0]?.toolResult?.content, 'two');
    assert.ok(newest.messages.every(({ kind }) => kind !== 'tool_result'));

    const older = await provider.fetchHistory(sessionId, { limit: 2, offset: 2 });
    assert.equal(older.total, 4);
    assert.equal(older.hasMore, false);
    assert.deepEqual(older.messages.map(({ id }) => id), [
      'assistant-tool-1_0',
      'assistant-text-1_0',
    ]);
    assert.equal(older.messages[0]?.toolResult?.content, 'one');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
