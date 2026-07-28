#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_HOOK_INPUT_BYTES = 8 * 1024 * 1024;
const AUTOMATION_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;

async function readHookInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_HOOK_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function observeStop() {
  const automationId = process.env.CLOUDCLI_AUTOMATION_ID;
  const stateDir = process.env.CLOUDCLI_AUTOMATION_STATE_DIR;
  if (!automationId || !AUTOMATION_ID_PATTERN.test(automationId) || !stateDir) return;

  const input = await readHookInput();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if (!Array.isArray(input.session_crons)) return;

  const targetPath = join(stateDir, `${automationId}.json`);
  let everScheduled = input.session_crons.length > 0;
  try {
    const previous = JSON.parse(await readFile(targetPath, 'utf8'));
    if (previous?.automation_id === automationId) {
      everScheduled = everScheduled
        || previous.ever_scheduled === true
        || (Array.isArray(previous.session_crons) && previous.session_crons.length > 0);
    }
  } catch {
    // A missing or partial prior snapshot simply means this observation starts fresh.
  }

  const snapshot = {
    schema_version: 2,
    automation_id: automationId,
    observed_at: new Date().toISOString(),
    session_id: typeof input.session_id === 'string' ? input.session_id : null,
    ever_scheduled: everScheduled,
    session_crons: input.session_crons,
    background_tasks: Array.isArray(input.background_tasks) ? input.background_tasks : [],
  };
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

// Hooks must never delay or alter Claude's Stop decision if observation fails.
await observeStop().catch(() => undefined);
