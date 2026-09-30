import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  getProjectSessionsPage,
  getProjectsWithSessions,
} from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-projects-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

test('provider filters hide unmatched projects and keep mixed projects once', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('mixed-claude', 'claude', '/workspace/mixed', 'Claude');
    sessionsDb.createSession('mixed-codex', 'codex', '/workspace/mixed', 'Codex');
    sessionsDb.createSession('codex-only', 'codex', '/workspace/codex-only', 'Codex only');
    projectsDb.createProjectPath('/workspace/empty');

    const claudeProjects = await getProjectsWithSessions({
      skipSynchronization: true,
      providers: ['claude'],
    });

    assert.equal(claudeProjects.length, 1);
    assert.equal(claudeProjects[0]?.path, '/workspace/mixed');
    assert.deepEqual(claudeProjects[0]?.sessions.map((session) => session.provider), ['claude']);
    assert.deepEqual(claudeProjects[0]?.providerCounts, { claude: 1, codex: 1 });

    const allProjects = await getProjectsWithSessions({ skipSynchronization: true });
    assert.equal(allProjects.length, 3);
  });
});

test('provider-filtered session pages report filtered totals and hasMore', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('codex-one', 'codex', '/workspace/paginated', 'One');
    sessionsDb.createSession('codex-two', 'codex', '/workspace/paginated', 'Two');
    sessionsDb.createSession('claude-one', 'claude', '/workspace/paginated', 'Claude');
    const project = projectsDb.getProjectPath('/workspace/paginated');
    assert.ok(project);

    const firstPage = await getProjectSessionsPage(project.project_id, {
      limit: 1,
      providers: ['codex'],
    });

    assert.equal(firstPage.sessions.length, 1);
    assert.equal(firstPage.sessions[0]?.provider, 'codex');
    assert.deepEqual(firstPage.sessionMeta, { total: 2, hasMore: true });
  });
});
