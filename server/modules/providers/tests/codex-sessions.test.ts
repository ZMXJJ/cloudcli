import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { isCodexDesktopRecentChatPath } from '@/modules/providers/list/codex/codex-project-path.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-db-'));
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

/**
 * Writes one Codex rollout transcript. `firstUserMessage` mirrors the
 * `event_msg`/`user_message` payload the runtime records for the prompt the
 * user typed; omitting it produces a transcript with no user turn.
 */
const writeCodexTranscript = async (
  homeDir: string,
  codexSessionId: string,
  workspacePath: string,
  firstUserMessage?: string,
): Promise<string> => {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '07');
  await mkdir(sessionsDir, { recursive: true });

  const lines: string[] = [
    JSON.stringify({ type: 'session_meta', payload: { id: codexSessionId, cwd: workspacePath } }),
  ];
  if (firstUserMessage !== undefined) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: firstUserMessage } }));
  }

  const filePath = path.join(sessionsDir, `rollout-${codexSessionId}.jsonl`);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

test('Codex synchronizer titles app-created sessions from the first user message', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeCodexTranscript(tempRoot, 'codex-app-1', workspacePath, 'Fix the login redirect bug');
    await withIsolatedDatabase(async () => {
      // The app allocates its own id and later maps the provider id onto it,
      // exactly as a message sent from cloudcli does.
      sessionsDb.createAppSession('app-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-1', 'codex-app-1');

      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the login redirect bug');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer skips sub-agent rollout files', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-subagent-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Codex >=0.144 spawn_agent threads write their own rollout files into the
    // same sessions tree, marked via thread_source/source in session_meta.
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, 'rollout-codex-subagent-1.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'codex-subagent-1',
          cwd: workspacePath,
          thread_source: 'subagent',
          parent_thread_id: 'codex-parent-1',
          source: { subagent: { thread_spawn: { parent_thread_id: 'codex-parent-1', depth: 1 } } },
        },
      })}\n`,
      'utf8'
    );
    await writeCodexTranscript(tempRoot, 'codex-parent-1', workspacePath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      const processed = await synchronizer.synchronize();

      assert.equal(processed, 1);
      assert.ok(sessionsDb.getSessionById('codex-parent-1'));
      assert.equal(sessionsDb.getSessionById('codex-subagent-1'), null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer leaves indexed sessions untitled when no name is available', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-indexed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // A CLI-created session has no app row; its first user message must NOT be
    // used as the title, preserving the existing indexing behavior.
    await writeCodexTranscript(tempRoot, 'codex-indexed-1', workspacePath, 'This prompt should be ignored');
    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('codex-indexed-1')?.custom_name, 'Untitled Codex Session');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex recent-chat path detection only matches generated dated workspaces', () => {
  const homeDir = path.join(path.sep, 'Users', 'demo');

  assert.equal(
    isCodexDesktopRecentChatPath(
      path.join(homeDir, 'Documents', 'Codex', '2026-07-27', 'new-chat'),
      homeDir,
    ),
    true,
  );
  assert.equal(
    isCodexDesktopRecentChatPath(
      path.join(homeDir, 'Documents', 'Codex', '2026-07-27', 'chat', 'nested'),
      homeDir,
    ),
    true,
  );
  assert.equal(
    isCodexDesktopRecentChatPath(
      path.join(homeDir, 'Documents', 'Codex', 'my-project'),
      homeDir,
    ),
    false,
  );
  assert.equal(
    isCodexDesktopRecentChatPath(
      path.join(homeDir, 'Documents', 'Codex', '2026-07-27'),
      homeDir,
    ),
    false,
  );
  assert.equal(
    isCodexDesktopRecentChatPath(path.join(homeDir, 'CodePrograms', 'project'), homeDir),
    false,
  );
});

test('Codex synchronizer skips and prunes Desktop recent chats without deleting transcripts', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-recent-'));
  const generatedPath = path.join(tempRoot, 'Documents', 'Codex', '2026-07-27', 'new-chat');
  const mixedProviderPath = path.join(tempRoot, 'Documents', 'Codex', '2026-07-28', 'mixed-chat');
  const similarProjectPath = path.join(tempRoot, 'Documents', 'Codex', 'not-a-date', 'real-project');
  const regularProjectPath = path.join(tempRoot, 'CodePrograms', 'real-project');
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const generatedTranscript = await writeCodexTranscript(
      tempRoot,
      'codex-generated-new',
      generatedPath,
    );
    await writeCodexTranscript(tempRoot, 'codex-regular', regularProjectPath);
    await writeCodexTranscript(tempRoot, 'codex-similar', similarProjectPath);

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession('codex-generated-old', 'codex', generatedPath);
      sessionsDb.createSession('codex-mixed-old', 'codex', mixedProviderPath);
      sessionsDb.createSession('claude-mixed', 'claude', mixedProviderPath);

      const synchronizer = new CodexSessionSynchronizer();
      const processed = await synchronizer.synchronize();

      assert.equal(processed, 2);
      assert.equal(sessionsDb.getSessionById('codex-generated-new'), null);
      assert.equal(sessionsDb.getSessionById('codex-generated-old'), null);
      assert.equal(projectsDb.getProjectPath(generatedPath), null);

      assert.equal(sessionsDb.getSessionById('codex-mixed-old'), null);
      assert.ok(sessionsDb.getSessionById('claude-mixed'));
      assert.ok(projectsDb.getProjectPath(mixedProviderPath));

      assert.ok(sessionsDb.getSessionById('codex-regular'));
      assert.ok(sessionsDb.getSessionById('codex-similar'));
      await access(generatedTranscript);

      assert.equal(await synchronizer.synchronizeFile(generatedTranscript), null);
      assert.equal(sessionsDb.getSessionById('codex-generated-new'), null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
