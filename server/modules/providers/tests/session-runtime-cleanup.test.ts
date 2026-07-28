import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  configureSessionRuntimeCleanup,
  sessionsService,
} from '@/modules/providers/index.js';

async function withIsolatedDatabase(
  runTest: (tempDirectory: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-runtime-cleanup-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
  } finally {
    configureSessionRuntimeCleanup(null);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('force deleting a session cleans its runtime before removing its row and transcript', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const transcriptPath = path.join(tempDirectory, 'session-force.jsonl');
    await writeFile(transcriptPath, '{"type":"message"}\n', 'utf8');
    sessionsDb.createSession(
      'session-force',
      'claude',
      '/workspace/session-cleanup',
      'Force delete',
      undefined,
      undefined,
      transcriptPath,
    );

    const observations: string[] = [];
    configureSessionRuntimeCleanup(async (sessionId) => {
      observations.push(sessionId);
      assert.ok(sessionsDb.getSessionById(sessionId));
      assert.equal(await readFile(transcriptPath, 'utf8'), '{"type":"message"}\n');
    });

    const result = await sessionsService.deleteOrArchiveSessionById('session-force', {
      force: true,
      deletedFromDisk: true,
    });

    assert.deepEqual(observations, ['session-force']);
    assert.deepEqual(result, {
      sessionId: 'session-force',
      action: 'deleted',
      deletedFromDisk: true,
    });
    assert.equal(sessionsDb.getSessionById('session-force'), null);
    await assert.rejects(access(transcriptPath), { code: 'ENOENT' });
  });
});

test('a runtime cleanup failure aborts force deletion', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const transcriptPath = path.join(tempDirectory, 'session-failure.jsonl');
    await writeFile(transcriptPath, 'still here\n', 'utf8');
    sessionsDb.createSession(
      'session-failure',
      'claude',
      '/workspace/session-cleanup',
      'Cleanup failure',
      undefined,
      undefined,
      transcriptPath,
    );
    configureSessionRuntimeCleanup(() => {
      throw new Error('runtime refused to stop');
    });

    await assert.rejects(
      sessionsService.deleteOrArchiveSessionById('session-failure', {
        force: true,
        deletedFromDisk: true,
      }),
      /runtime refused to stop/,
    );

    assert.ok(sessionsDb.getSessionById('session-failure'));
    assert.equal(await readFile(transcriptPath, 'utf8'), 'still here\n');
  });
});

test('soft archiving a session leaves its runtime and transcript untouched', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const transcriptPath = path.join(tempDirectory, 'session-archive.jsonl');
    await writeFile(transcriptPath, 'archived\n', 'utf8');
    sessionsDb.createSession(
      'session-archive',
      'claude',
      '/workspace/session-cleanup',
      'Archive only',
      undefined,
      undefined,
      transcriptPath,
    );
    let cleanupCalls = 0;
    configureSessionRuntimeCleanup(() => {
      cleanupCalls += 1;
    });

    const result = await sessionsService.deleteOrArchiveSessionById('session-archive');

    assert.equal(cleanupCalls, 0);
    assert.equal(result.action, 'archived');
    assert.equal(sessionsDb.getSessionById('session-archive')?.isArchived, 1);
    assert.equal(await readFile(transcriptPath, 'utf8'), 'archived\n');
  });
});
