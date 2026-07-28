import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { deleteOrArchiveProject } from '@/modules/projects/index.js';
import { configureSessionRuntimeCleanup } from '@/modules/providers/index.js';

async function withIsolatedDatabase(
  runTest: (tempDirectory: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-runtime-cleanup-'));

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

test('force deleting a project cleans every session runtime before deleting rows and transcripts', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const projectPath = path.join(tempDirectory, 'workspace');
    const activeTranscript = path.join(tempDirectory, 'active.jsonl');
    const archivedTranscript = path.join(tempDirectory, 'archived.jsonl');
    await writeFile(activeTranscript, 'active\n', 'utf8');
    await writeFile(archivedTranscript, 'archived\n', 'utf8');
    sessionsDb.createSession('project-active', 'claude', projectPath, 'Active', undefined, undefined, activeTranscript);
    sessionsDb.createSession('project-archived', 'claude', projectPath, 'Archived', undefined, undefined, archivedTranscript);
    sessionsDb.updateSessionIsArchived('project-archived', true);
    const project = projectsDb.getProjectPath(projectPath);
    assert.ok(project);

    const cleaned: string[] = [];
    configureSessionRuntimeCleanup(async (sessionId) => {
      cleaned.push(sessionId);
      assert.ok(sessionsDb.getSessionById(sessionId));
      const transcriptPath = sessionId === 'project-active' ? activeTranscript : archivedTranscript;
      assert.ok((await readFile(transcriptPath, 'utf8')).length > 0);
    });

    await deleteOrArchiveProject(project.project_id, true);

    assert.deepEqual(cleaned.sort(), ['project-active', 'project-archived']);
    assert.equal(projectsDb.getProjectById(project.project_id), null);
    assert.equal(sessionsDb.getSessionById('project-active'), null);
    assert.equal(sessionsDb.getSessionById('project-archived'), null);
    await assert.rejects(access(activeTranscript), { code: 'ENOENT' });
    await assert.rejects(access(archivedTranscript), { code: 'ENOENT' });
  });
});

test('project cleanup failure aborts deletion while soft archive skips cleanup', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const projectPath = path.join(tempDirectory, 'workspace');
    const transcriptPath = path.join(tempDirectory, 'session.jsonl');
    await writeFile(transcriptPath, 'retained\n', 'utf8');
    sessionsDb.createSession('project-session', 'claude', projectPath, 'Session', undefined, undefined, transcriptPath);
    const project = projectsDb.getProjectPath(projectPath);
    assert.ok(project);

    let cleanupCalls = 0;
    configureSessionRuntimeCleanup(() => {
      cleanupCalls += 1;
      throw new Error('runtime refused to stop');
    });

    await deleteOrArchiveProject(project.project_id, false);
    assert.equal(cleanupCalls, 0);
    assert.equal(projectsDb.getProjectById(project.project_id)?.isArchived, 1);

    await assert.rejects(deleteOrArchiveProject(project.project_id, true), /runtime refused to stop/);
    assert.equal(cleanupCalls, 1);
    assert.ok(projectsDb.getProjectById(project.project_id));
    assert.ok(sessionsDb.getSessionById('project-session'));
    assert.equal(await readFile(transcriptPath, 'utf8'), 'retained\n');
  });
});
