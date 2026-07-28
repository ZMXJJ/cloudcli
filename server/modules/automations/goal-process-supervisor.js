#!/usr/bin/env node

import { spawn } from 'node:child_process';

const EXIT_EVENT_TYPE = 'cloudcli_goal_supervisor_exit_v1';
const AUTOMATION_ARG_PREFIX = '--cloudcli-automation-id=';
const TOKEN_ARG_PREFIX = '--cloudcli-runtime-token=';
const COMMAND_ARG_PREFIX = '--cloudcli-command=';
const ARGS_ARG_PREFIX = '--cloudcli-args=';
const AUTOMATION_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;
const TOKEN_PATTERN = /^[0-9a-f-]{36}$/i;
const INTERRUPT_TIMEOUT_MS = 5_000;
const TERMINATE_TIMEOUT_MS = 2_000;

function readArgument(prefix) {
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  return value?.slice(prefix.length) ?? '';
}

function decodeBase64Json(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function signalProcessGroup(signal) {
  try {
    process.kill(-process.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function fail(message) {
  process.stderr.write(`[CloudCLI Goal supervisor] ${message}\n`);
  process.exitCode = 1;
}

if (process.platform === 'win32') {
  fail('The Goal supervisor requires POSIX process groups.');
} else {
  const automationId = readArgument(AUTOMATION_ARG_PREFIX);
  const runtimeToken = readArgument(TOKEN_ARG_PREFIX);
  const encodedCommand = readArgument(COMMAND_ARG_PREFIX);
  const encodedArgs = readArgument(ARGS_ARG_PREFIX);

  let command;
  let args;
  try {
    command = decodeBase64Json(encodedCommand);
    args = decodeBase64Json(encodedArgs);
  } catch {
    fail('The supervisor received an invalid Claude command payload.');
  }

  if (!AUTOMATION_ID_PATTERN.test(automationId) || !TOKEN_PATTERN.test(runtimeToken)
    || typeof command !== 'string' || command.length === 0
    || !Array.isArray(args) || !args.every((argument) => typeof argument === 'string')) {
    fail('The supervisor received invalid automation identity or Claude arguments.');
  } else {
    const childEnvironment = { ...process.env };
    delete childEnvironment.ELECTRON_RUN_AS_NODE;

    const child = spawn(command, args, {
      env: childEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });

    let finishing = false;
    let orphanCleanupStarted = false;
    let terminateTimer;
    let forceKillTimer;

    const forceKillGroup = () => {
      try {
        signalProcessGroup('SIGKILL');
      } catch (error) {
        fail(`Unable to force-kill the Goal process group: ${error.message}`);
        process.exit(1);
      }
    };

    const beginOrphanCleanup = () => {
      if (orphanCleanupStarted || finishing) return;
      orphanCleanupStarted = true;
      try {
        signalProcessGroup('SIGINT');
      } catch (error) {
        fail(`Unable to interrupt the orphaned Goal process group: ${error.message}`);
        forceKillGroup();
        return;
      }
      terminateTimer = setTimeout(() => {
        try {
          signalProcessGroup('SIGTERM');
        } catch (error) {
          fail(`Unable to terminate the orphaned Goal process group: ${error.message}`);
        }
        forceKillTimer = setTimeout(forceKillGroup, TERMINATE_TIMEOUT_MS);
      }, INTERRUPT_TIMEOUT_MS);
    };

    // The parent keeps stdin open as a lifetime lease. EOF is delivered even
    // when CloudCLI is force-killed, so the supervisor can clean the whole PG.
    process.stdin.resume();
    process.stdin.once('end', beginOrphanCleanup);
    process.stdin.once('close', beginOrphanCleanup);
    process.stdin.on('error', beginOrphanCleanup);
    // A force-killed parent closes both output readers. Keep these listeners
    // installed until the process dies; otherwise a second EPIPE can crash the
    // supervisor before its TERM/KILL escalation reaches Claude's descendants.
    process.stdout.on('error', beginOrphanCleanup);
    process.stderr.on('error', beginOrphanCleanup);

    // Group signals already reach Claude and its tools. Keeping the supervisor
    // alive lets the parent escalate to TERM/KILL if descendants ignore them.
    process.on('SIGINT', () => undefined);
    process.on('SIGTERM', () => undefined);

    const finishChild = (code, signal) => {
      if (finishing) return;
      finishing = true;
      if (terminateTimer) clearTimeout(terminateTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const marker = JSON.stringify({
        type: EXIT_EVENT_TYPE,
        automation_id: automationId,
        runtime_token: runtimeToken,
        code,
        signal,
      });
      let killed = false;
      const finish = () => {
        if (killed) return;
        killed = true;
        forceKillGroup();
      };
      process.stdout.write(`\n${marker}\n`, finish);
      setTimeout(finish, 250);
    };
    child.once('error', (error) => {
      fail(`Unable to launch Claude Code: ${error.message}`);
      // Some spawn failures do not reliably produce a later close event.
      finishChild(1, null);
    });
    child.once('close', finishChild);
  }
}
