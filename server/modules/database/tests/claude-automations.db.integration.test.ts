import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { claudeAutomationsDb } from '@/modules/database/repositories/claude-automations.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-automations-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function createSession(sessionId: string): void {
  sessionsDb.createAppSession(sessionId, 'claude', `/workspace/${sessionId}`);
}

test('start creates and replaces one automation row per app session', async () => {
  await withIsolatedDatabase(() => {
    createSession('session-start');

    const started = claudeAutomationsDb.start({
      sessionId: 'session-start',
      kind: 'goal',
      runtime: 'headless',
      command: '/goal make the test suite pass',
      runtimeId: 'process-1',
      nativeTaskId: 'goal-1',
    });

    assert.equal(started.session_id, 'session-start');
    assert.equal(started.kind, 'goal');
    assert.equal(started.state, 'starting');
    assert.equal(started.runtime, 'headless');
    assert.equal(started.command, '/goal make the test suite pass');
    assert.equal(started.runtime_id, 'process-1');
    assert.equal(started.native_task_id, 'goal-1');
    assert.equal(started.error, null);
    assert.equal(started.completed_at, null);
    assert.match(started.started_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(started.started_at.endsWith('Z'));
    assert.ok(started.updated_at.endsWith('Z'));

    claudeAutomationsDb.update('session-start', {
      state: 'failed',
      error: 'runtime exited',
    });

    const restarted = claudeAutomationsDb.start({
      sessionId: 'session-start',
      kind: 'loop',
      runtime: 'tmux',
      command: '/loop 5m check deployment',
    });

    assert.equal(restarted.kind, 'loop');
    assert.equal(restarted.state, 'starting');
    assert.equal(restarted.runtime, 'tmux');
    assert.equal(restarted.command, '/loop 5m check deployment');
    assert.equal(restarted.runtime_id, null);
    assert.equal(restarted.native_task_id, null);
    assert.equal(restarted.error, null);
    assert.equal(restarted.completed_at, null);
  });
});

test('update preserves undefined fields, clears explicit nulls, and tracks terminal state', async () => {
  await withIsolatedDatabase(() => {
    createSession('session-update');
    claudeAutomationsDb.start({
      sessionId: 'session-update',
      kind: 'loop',
      runtime: 'tmux',
      command: '/loop check deployment',
      runtimeId: 'tmux-session',
      nativeTaskId: 'cron-1',
    });

    const running = claudeAutomationsDb.update('session-update', { state: 'running' });
    assert.equal(running?.runtime_id, 'tmux-session');
    assert.equal(running?.native_task_id, 'cron-1');

    const cleared = claudeAutomationsDb.update('session-update', {
      runtimeId: null,
      nativeTaskId: null,
      error: null,
    });
    assert.equal(cleared?.state, 'running');
    assert.equal(cleared?.runtime_id, null);
    assert.equal(cleared?.native_task_id, null);
    assert.equal(cleared?.error, null);

    const failed = claudeAutomationsDb.update('session-update', {
      state: 'failed',
      error: 'Claude process exited with code 1',
    });
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.error, 'Claude process exited with code 1');
    assert.ok(failed?.completed_at?.endsWith('Z'));

    const resumed = claudeAutomationsDb.update('session-update', {
      state: 'running',
      error: null,
    });
    assert.equal(resumed?.completed_at, null);
    assert.equal(resumed?.error, null);

    assert.equal(claudeAutomationsDb.update('missing-session', { state: 'running' }), null);
  });
});

test('listActive excludes terminal rows and dismiss removes stored state', async () => {
  await withIsolatedDatabase(() => {
    for (const sessionId of ['starting', 'running', 'stopping', 'completed', 'failed']) {
      createSession(sessionId);
      claudeAutomationsDb.start({
        sessionId,
        kind: 'goal',
        runtime: 'headless',
        command: `/goal ${sessionId}`,
      });
    }

    claudeAutomationsDb.update('running', { state: 'running' });
    claudeAutomationsDb.update('stopping', { state: 'stopping' });
    claudeAutomationsDb.update('completed', { state: 'completed' });
    claudeAutomationsDb.update('failed', { state: 'failed', error: 'failed' });

    assert.deepEqual(
      claudeAutomationsDb.listActive().map((automation) => automation.session_id).sort(),
      ['running', 'starting', 'stopping'],
    );
    assert.equal(claudeAutomationsDb.dismiss('completed'), true);
    assert.equal(claudeAutomationsDb.getBySessionId('completed'), null);
    assert.equal(claudeAutomationsDb.dismiss('completed'), false);
  });
});

test('deleting an app session cascades to its automation row', async () => {
  await withIsolatedDatabase(() => {
    createSession('session-delete');
    claudeAutomationsDb.start({
      sessionId: 'session-delete',
      kind: 'goal',
      runtime: 'headless',
      command: '/goal finish cleanup',
    });

    assert.equal(sessionsDb.deleteSessionById('session-delete'), true);
    assert.equal(claudeAutomationsDb.getBySessionId('session-delete'), null);
  });
});

test('persists Loop input receipts and clears the old generation when automation restarts', async () => {
  await withIsolatedDatabase(() => {
    const sessionId = 'session-input-receipts';
    createSession(sessionId);
    claudeAutomationsDb.start({
      sessionId,
      kind: 'loop',
      runtime: 'tmux',
      command: '/loop 5m check deployment',
      nativeTaskId: 'loop-generation-1',
    });

    const reserved = claudeAutomationsDb.reserveInput({
      sessionId,
      automationId: 'loop-generation-1',
      requestId: 'input-request-1',
      contentHash: 'a'.repeat(64),
    });
    assert.equal(reserved.inserted, true);
    assert.equal(reserved.row.state, 'processing');
    const acknowledged = claudeAutomationsDb.updateInput(
      'loop-generation-1',
      'input-request-1',
      'acknowledged',
      null,
    );
    assert.equal(acknowledged?.state, 'acknowledged');

    closeConnection();
    const persisted = claudeAutomationsDb.getInput('loop-generation-1', 'input-request-1');
    assert.equal(persisted?.session_id, sessionId);
    assert.equal(persisted?.content_hash, 'a'.repeat(64));
    assert.equal(persisted?.state, 'acknowledged');
    assert.ok(persisted?.created_at.endsWith('Z'));
    assert.ok(persisted?.updated_at.endsWith('Z'));

    claudeAutomationsDb.start({
      sessionId,
      kind: 'loop',
      runtime: 'tmux',
      command: '/loop 10m check deployment',
      nativeTaskId: 'loop-generation-2',
    });
    assert.equal(
      claudeAutomationsDb.getInput('loop-generation-1', 'input-request-1'),
      null,
    );
    const reusedRequestId = claudeAutomationsDb.reserveInput({
      sessionId,
      automationId: 'loop-generation-2',
      requestId: 'input-request-1',
      contentHash: 'b'.repeat(64),
    });
    assert.equal(reusedRequestId.inserted, true);
    assert.equal(reusedRequestId.row.automation_id, 'loop-generation-2');
  });
});

test('dismissing an automation removes its Loop input receipts', async () => {
  await withIsolatedDatabase(() => {
    const sessionId = 'session-dismiss-input-receipts';
    createSession(sessionId);
    claudeAutomationsDb.start({
      sessionId,
      kind: 'loop',
      runtime: 'tmux',
      command: '/loop 5m check deployment',
      nativeTaskId: 'loop-dismiss-generation',
    });
    claudeAutomationsDb.reserveInput({
      sessionId,
      automationId: 'loop-dismiss-generation',
      requestId: 'input-before-dismiss',
      contentHash: 'c'.repeat(64),
    });
    claudeAutomationsDb.update(sessionId, { state: 'completed' });

    assert.equal(claudeAutomationsDb.dismiss(sessionId), true);
    assert.equal(
      claudeAutomationsDb.getInput('loop-dismiss-generation', 'input-before-dismiss'),
      null,
    );
  });
});
