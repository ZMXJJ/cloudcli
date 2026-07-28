import { EventEmitter } from 'node:events';
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NativeClaudeAutomationError,
  NativeClaudeAutomationRunner,
  buildClaudeAutomationPreferenceArgs,
  buildGoalClearClaudeArgs,
  buildGoalClaudeArgs,
  createTmuxSessionName,
  parseClaudeVersion,
  type ExecFileResult,
  type NativeClaudeAutomationDependencies,
  type NativeClaudeAutomationStartOptions,
} from '../native-claude-automation.runner.js';

const EXISTING_SESSION_ID = 'provider-session-123';
const NEW_SESSION_ID = '4f9248f0-5fe3-4a77-a475-23f496272edd';

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
}

function createGoalOptions(
  overrides: Partial<NativeClaudeAutomationStartOptions> = {},
): NativeClaudeAutomationStartOptions {
  return {
    automationId: 'chat-session-1',
    command: '/goal tests pass',
    cwd: '/workspace/project',
    providerSessionId: EXISTING_SESSION_ID,
    ...overrides,
  } as NativeClaudeAutomationStartOptions;
}

async function runLoopObserver(
  stateDir: string,
  automationId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const scriptPath = fileURLToPath(new URL('../loop-stop-observer.js', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        CLOUDCLI_AUTOMATION_ID: automationId,
        CLOUDCLI_AUTOMATION_STATE_DIR: stateDir,
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Loop observer exited ${String(code)}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function acknowledgeLoopEnvironment(
  tmuxArgs: readonly string[],
): Promise<Record<string, string>> {
  const socketEntry = tmuxArgs.find((argument) => (
    argument.startsWith('CLOUDCLI_AUTOMATION_ENV_SOCKET=')
  ));
  const tokenEntry = tmuxArgs.find((argument) => (
    argument.startsWith('CLOUDCLI_AUTOMATION_ENV_TOKEN=')
  ));
  assert.ok(socketEntry);
  assert.ok(tokenEntry);
  const socketPath = socketEntry.slice(socketEntry.indexOf('=') + 1);
  const runtimeToken = tokenEntry.slice(tokenEntry.indexOf('=') + 1);

  return new Promise<Record<string, string>>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ type: 'request', runtime_token: runtimeToken })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      try {
        const payload = JSON.parse(buffer.slice(0, newlineIndex)) as {
          type?: unknown;
          runtime_token?: unknown;
          environment?: unknown;
        };
        assert.equal(payload.type, 'environment');
        assert.equal(payload.runtime_token, runtimeToken);
        assert.ok(payload.environment && typeof payload.environment === 'object');
        socket.write(
          `${JSON.stringify({ type: 'ack', runtime_token: runtimeToken })}\n`,
          (error) => {
            socket.end();
            if (error) reject(error);
            else resolve(payload.environment as Record<string, string>);
          },
        );
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

test('builds conservative Claude flags and selects exactly one native session mode', () => {
  assert.deepEqual(buildClaudeAutomationPreferenceArgs({
    model: 'claude-opus-4-6',
    effort: 'high',
    permissionMode: 'acceptEdits',
  }), [
    '--model',
    'claude-opus-4-6',
    '--effort',
    'high',
    '--permission-mode',
    'acceptEdits',
  ]);
  assert.deepEqual(buildClaudeAutomationPreferenceArgs({
    model: 'default',
    effort: 'turbo',
    permissionMode: 'unknown',
  }), []);

  const resumed = buildGoalClaudeArgs(createGoalOptions());
  assert.deepEqual(resumed, [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--resume',
    EXISTING_SESSION_ID,
    '/goal tests pass',
  ]);

  const fresh = buildGoalClaudeArgs(createGoalOptions({
    providerSessionId: undefined,
    sessionId: NEW_SESSION_ID,
  }));
  assert.deepEqual(fresh.slice(-3), ['--session-id', NEW_SESSION_ID, '/goal tests pass']);
});

test('parses Claude versions used by automation feature gates', () => {
  assert.deepEqual(parseClaudeVersion('2.1.145 (Claude Code)'), [2, 1, 145]);
  assert.deepEqual(parseClaudeVersion('claude v3.0.1-beta.2'), [3, 0, 1]);
  assert.equal(parseClaudeVersion('Claude Code development build'), null);
});

test('rejects ambiguous session targets and non-start goal commands', () => {
  assert.throws(
    () => buildGoalClaudeArgs({
      ...createGoalOptions(),
      providerSessionId: EXISTING_SESSION_ID,
      sessionId: NEW_SESSION_ID,
    } as unknown as NativeClaudeAutomationStartOptions),
    (error: unknown) => error instanceof NativeClaudeAutomationError
      && error.code === 'INVALID_OPTIONS',
  );
  assert.throws(
    () => buildGoalClaudeArgs(createGoalOptions({ command: '/goal clear' })),
    (error: unknown) => error instanceof NativeClaudeAutomationError
      && error.code === 'INVALID_COMMAND',
  );
});

test('streams split NDJSON records, stderr, malformed output, exit, and interrupt state', async () => {
  const child = new FakeChildProcess();
  const spawnCalls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  const events: unknown[] = [];
  const malformed: string[] = [];
  const stderr: string[] = [];
  const runner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    claudeCommand: '/opt/bin/claude',
    platform: 'win32',
    processEnv: { BASE: 'one' },
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child as unknown as ChildProcess;
    },
  });

  const handle = runner.startGoal(createGoalOptions({ env: { EXTRA: 'two' } }), {
    onRawEvent: ({ value }) => events.push(value),
    onMalformedOutput: (raw) => malformed.push(raw),
    onStderr: (chunk) => stderr.push(chunk),
  });

  assert.equal(runner.hasGoal('chat-session-1'), true);
  assert.equal(handle.runtimeId, '4321');
  assert.equal(spawnCalls[0].command, '/opt/bin/claude');
  assert.deepEqual(spawnCalls[0].args, buildGoalClaudeArgs(createGoalOptions({ env: { EXTRA: 'two' } })));
  assert.deepEqual(spawnCalls[0].options, {
    cwd: '/workspace/project',
    env: { BASE: 'one', EXTRA: 'two' },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.write('{"type":"assis');
  child.stdout.write(
    'tant","message":"one"}\nnot-json\n'
      + '{"type":"result","subtype":"success","is_error":false}',
  );
  child.stderr.write('permission warning');
  child.stdout.end();
  child.stderr.end();
  assert.equal(handle.interrupt(), true);
  child.emit('close', null, 'SIGINT');

  const result = await handle.completion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    { type: 'assistant', message: 'one' },
    { type: 'result', subtype: 'success', is_error: false },
  ]);
  assert.deepEqual(malformed, ['not-json']);
  assert.deepEqual(stderr, ['permission warning']);
  assert.deepEqual(child.signals, ['SIGINT']);
  assert.equal(result.interrupted, true);
  assert.equal(result.signal, 'SIGINT');
  assert.equal(result.result?.subtype, 'success');
  assert.equal(result.result?.isError, false);
  assert.equal(runner.hasGoal('chat-session-1'), false);
});

test('runs a POSIX Goal under a detached supervisor and signals the whole process group', async () => {
  const child = new FakeChildProcess();
  const spawnCalls: Array<{ command: string; args: readonly string[]; options: any }> = [];
  const groupSignals: Array<{ processGroupId: number; signal: NodeJS.Signals }> = [];
  const events: unknown[] = [];
  const runner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    claudeCommand: '/opt/bin/claude',
    nodeCommand: '/opt/bin/node',
    goalSupervisorPath: '/opt/cloudcli/goal-process-supervisor.js',
    platform: 'linux',
    processEnv: { BASE: 'one' },
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child as unknown as ChildProcess;
    },
    signalProcessGroup: (processGroupId, signal) => {
      groupSignals.push({ processGroupId, signal });
      return true;
    },
  });

  const handle = runner.startGoal(createGoalOptions({ env: { EXTRA: 'two' } }), {
    onRawEvent: ({ value }) => events.push(value),
  });
  const call = spawnCalls[0];
  assert.equal(call.command, '/opt/bin/node');
  assert.equal(call.args[0], '/opt/cloudcli/goal-process-supervisor.js');
  assert.ok(call.args.includes('--cloudcli-automation-id=chat-session-1'));
  const tokenArgument = call.args.find((argument) => argument.startsWith('--cloudcli-runtime-token='));
  assert.ok(tokenArgument);
  const runtimeToken = tokenArgument.slice(tokenArgument.indexOf('=') + 1);
  const encodedCommand = call.args.find((argument) => argument.startsWith('--cloudcli-command='));
  const encodedArgs = call.args.find((argument) => argument.startsWith('--cloudcli-args='));
  assert.ok(encodedCommand);
  assert.ok(encodedArgs);
  assert.equal(
    JSON.parse(Buffer.from(encodedCommand.slice(encodedCommand.indexOf('=') + 1), 'base64url').toString('utf8')),
    '/opt/bin/claude',
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(encodedArgs.slice(encodedArgs.indexOf('=') + 1), 'base64url').toString('utf8')),
    buildGoalClaudeArgs(createGoalOptions({ env: { EXTRA: 'two' } })),
  );
  assert.deepEqual(call.options, {
    cwd: '/workspace/project',
    env: { BASE: 'one', EXTRA: 'two', ELECTRON_RUN_AS_NODE: '1' },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: true,
  });
  assert.match(handle.runtimeId, /^cloudcli-goal-v1:/);

  assert.equal(handle.interrupt(), true);
  assert.deepEqual(groupSignals, [{ processGroupId: 4321, signal: 'SIGINT' }]);
  child.stdout.end([
    '{"type":"result","subtype":"success","is_error":false}',
    JSON.stringify({
      type: 'cloudcli_goal_supervisor_exit_v1',
      automation_id: 'chat-session-1',
      runtime_token: runtimeToken,
      code: 0,
      signal: null,
    }),
    '',
  ].join('\n'));
  child.stderr.end();
  child.emit('close', null, 'SIGKILL');

  const result = await handle.completion;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.result?.subtype, 'success');
  assert.deepEqual(events, [{ type: 'result', subtype: 'success', is_error: false }]);
});

test('reclaims only a persisted Goal supervisor whose versioned identity still matches', async () => {
  const child = new FakeChildProcess();
  let supervisorCommand = '';
  const starter = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    nodeCommand: '/opt/bin/node',
    goalSupervisorPath: '/opt/cloudcli/goal-process-supervisor.js',
    platform: 'linux',
    spawn: (_command, args) => {
      supervisorCommand = ['/opt/bin/node', ...args].join(' ');
      return child as unknown as ChildProcess;
    },
    signalProcessGroup: () => true,
  });
  const runtimeId = starter.startGoal(createGoalOptions()).runtimeId;

  let snapshots = [{
    pid: 4321,
    processGroupId: 4321,
    command: supervisorCommand,
  }];
  const groupSignals: NodeJS.Signals[] = [];
  const restarted = new NativeClaudeAutomationRunner({
    goalSupervisorPath: '/opt/cloudcli/goal-process-supervisor.js',
    platform: 'linux',
    listProcesses: () => snapshots,
    signalProcessGroup: (_processGroupId, signal) => {
      groupSignals.push(signal);
      snapshots = [];
      return true;
    },
    goalInterruptTimeoutMs: 0,
    goalTerminateTimeoutMs: 0,
  });
  assert.deepEqual(await restarted.cleanupGoalRuntime('chat-session-1', runtimeId), {
    status: 'terminated',
    matchedProcessCount: 1,
  });
  assert.deepEqual(groupSignals, ['SIGINT']);

  const reusedPid = new NativeClaudeAutomationRunner({
    goalSupervisorPath: '/opt/cloudcli/goal-process-supervisor.js',
    platform: 'linux',
    listProcesses: () => [{
      pid: 4321,
      processGroupId: 4321,
      command: '/usr/bin/unrelated --serve',
    }],
    signalProcessGroup: () => {
      throw new Error('must not signal a recycled PID');
    },
  });
  assert.deepEqual(await reusedPid.cleanupGoalRuntime('chat-session-1', runtimeId), {
    status: 'identity_mismatch',
    matchedProcessCount: 0,
  });
});

test('finds a Goal supervisor by automation marker when runtime_id was not persisted', async () => {
  const automationId = 'chat-session-1';
  const token = '83daecad-b75d-4e10-a876-24eb659eac24';
  let alive = true;
  const runner = new NativeClaudeAutomationRunner({
    goalSupervisorPath: '/opt/cloudcli/goal-process-supervisor.js',
    platform: 'darwin',
    listProcesses: () => alive ? [{
      pid: 9123,
      processGroupId: 9123,
      command: `/opt/bin/node /opt/cloudcli/goal-process-supervisor.js --cloudcli-automation-id=${automationId} --cloudcli-runtime-token=${token}`,
    }] : [],
    signalProcessGroup: () => {
      alive = false;
      return true;
    },
    goalInterruptTimeoutMs: 0,
    goalTerminateTimeoutMs: 0,
  });

  assert.deepEqual(await runner.cleanupGoalRuntime(automationId, null), {
    status: 'terminated',
    matchedProcessCount: 1,
  });
});

test('Goal supervisor survives broken stdout and stderr pipes long enough to clean its group', async () => {
  const supervisorPath = fileURLToPath(new URL('../goal-process-supervisor.js', import.meta.url));
  const automationId = 'broken-pipe-goal';
  const runtimeToken = '83daecad-b75d-4e10-a876-24eb659eac24';
  const fakeClaudeArgs = [
    '-e',
    [
      "process.on('SIGINT', () => {",
      "  process.stdout.write('{\"type\":\"result\",\"subtype\":\"success\"}\\n');",
      "  process.stderr.write('closing fake Claude\\n');",
      '  setTimeout(() => process.exit(0), 10);',
      '});',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  ];
  const supervisor = spawnProcess(process.execPath, [
    supervisorPath,
    `--cloudcli-automation-id=${automationId}`,
    `--cloudcli-runtime-token=${runtimeToken}`,
    `--cloudcli-command=${Buffer.from(JSON.stringify(process.execPath)).toString('base64url')}`,
    `--cloudcli-args=${Buffer.from(JSON.stringify(fakeClaudeArgs)).toString('base64url')}`,
  ], {
    detached: true,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 75));
    supervisor.stdout.destroy();
    supervisor.stderr.destroy();
    supervisor.stdin.destroy();
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        supervisor.once('error', reject);
        supervisor.once('close', (code, signal) => resolve({ code, signal }));
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Goal supervisor did not self-clean after EPIPE')), 2_000);
      }),
    ]);
    assert.equal(exit.code, null);
    assert.equal(exit.signal, 'SIGKILL');
  } finally {
    if (supervisor.pid) {
      try {
        process.kill(-supervisor.pid, 'SIGKILL');
      } catch {
        // The expected supervisor cleanup already removed the process group.
      }
    }
  }
});

test('force-kills a Goal that does not exit before the injectable interrupt timeout', async () => {
  const child = new FakeChildProcess();
  const scheduledCallbacks: Array<() => void> = [];
  let scheduledMilliseconds: number | undefined;
  let unrefCalled = false;
  const timeout = {
    unref() {
      unrefCalled = true;
      return this;
    },
  } as unknown as NodeJS.Timeout;
  const runner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    spawn: () => child as unknown as ChildProcess,
    platform: 'win32',
    goalInterruptTimeoutMs: 25,
    setTimeout: (callback, milliseconds) => {
      scheduledCallbacks.push(callback);
      scheduledMilliseconds = milliseconds;
      return timeout;
    },
    clearTimeout: () => undefined,
  });

  const handle = runner.startGoal(createGoalOptions());
  assert.equal(handle.interrupt(), true);
  assert.equal(handle.interrupt(), true);
  assert.deepEqual(child.signals, ['SIGINT']);
  assert.equal(scheduledMilliseconds, 25);
  assert.equal(unrefCalled, true);

  assert.ok(scheduledCallbacks[0]);
  scheduledCallbacks[0]();
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM']);
  assert.ok(scheduledCallbacks[1]);
  scheduledCallbacks[1]();
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  child.emit('close', null, 'SIGKILL');
  const result = await handle.completion;
  assert.equal(result.interrupted, true);
});

test('clears the pending Goal force-kill timer when the process exits', async () => {
  const child = new FakeChildProcess();
  let scheduledCallback: (() => void) | undefined;
  let clearedTimeout: NodeJS.Timeout | undefined;
  const timeout = {
    unref() {
      return this;
    },
  } as unknown as NodeJS.Timeout;
  const runner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    spawn: () => child as unknown as ChildProcess,
    platform: 'win32',
    setTimeout: (callback) => {
      scheduledCallback = callback;
      return timeout;
    },
    clearTimeout: (handle) => {
      clearedTimeout = handle;
    },
  });

  const handle = runner.startGoal(createGoalOptions());
  handle.interrupt();
  child.emit('close', 0, null);
  await handle.completion;
  assert.equal(clearedTimeout, timeout);

  assert.ok(scheduledCallback);
  scheduledCallback();
  assert.deepEqual(child.signals, ['SIGINT']);
});

test('clears goal in the same native session without occupying the active process map', async () => {
  const child = new FakeChildProcess();
  let spawnedArgs: readonly string[] = [];
  const runner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    claudeCommand: '/opt/bin/claude',
    platform: 'win32',
    spawn: (_command, args) => {
      spawnedArgs = args;
      return child as unknown as ChildProcess;
    },
  });
  const clearOptions = {
    cwd: '/workspace/project',
    providerSessionId: EXISTING_SESSION_ID,
  } as const;

  const completion = runner.clearGoal(clearOptions);
  assert.equal(runner.hasLocal('chat-session-1'), false);
  assert.deepEqual(spawnedArgs, buildGoalClearClaudeArgs(clearOptions));
  child.stdout.end('{"type":"result","subtype":"success"}\n');
  child.stderr.end();
  child.emit('close', 0, null);

  const result = await completion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.success, true);
  assert.equal(result.code, 0);
  assert.deepEqual(result.events.map(({ value }) => value), [
    { type: 'result', subtype: 'success' },
  ]);
});

test('runs POSIX goal clear under the same leased process-group supervisor', async () => {
  const child = new FakeChildProcess();
  let spawnCall: { command: string; args: readonly string[]; options: any } | null = null;
  const runner = new NativeClaudeAutomationRunner({
    claudeCommand: '/opt/bin/claude',
    nodeCommand: '/opt/bin/node',
    goalSupervisorPath: '/opt/cloudcli/goal-process-supervisor.js',
    platform: 'linux',
    spawn: (command, args, options) => {
      spawnCall = { command, args, options };
      return child as unknown as ChildProcess;
    },
    signalProcessGroup: () => true,
  });
  const completion = runner.clearGoal({
    cwd: '/workspace/project',
    providerSessionId: EXISTING_SESSION_ID,
  });
  const capturedSpawn = spawnCall as {
    command: string;
    args: readonly string[];
    options: any;
  } | null;
  assert.ok(capturedSpawn);
  assert.equal(capturedSpawn.command, '/opt/bin/node');
  assert.equal(capturedSpawn.options.detached, true);
  assert.deepEqual(capturedSpawn.options.stdio, ['pipe', 'pipe', 'pipe']);
  const automationEntry = capturedSpawn.args.find((argument) => (
    argument.startsWith('--cloudcli-automation-id=')
  ));
  const tokenEntry = capturedSpawn.args.find((argument) => (
    argument.startsWith('--cloudcli-runtime-token=')
  ));
  assert.ok(automationEntry);
  assert.ok(tokenEntry);
  child.stdout.end([
    '{"type":"result","subtype":"success"}',
    JSON.stringify({
      type: 'cloudcli_goal_supervisor_exit_v1',
      automation_id: automationEntry.slice(automationEntry.indexOf('=') + 1),
      runtime_token: tokenEntry.slice(tokenEntry.indexOf('=') + 1),
      code: 0,
      signal: null,
    }),
    '',
  ].join('\n'));
  child.stderr.end();
  child.emit('close', null, 'SIGKILL');

  const result = await completion;
  assert.equal(result.success, true);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
});

test('bounds a hung goal clear with TERM and KILL escalation', async () => {
  const child = new FakeChildProcess();
  const callbacks: Array<() => void> = [];
  const timeout = { unref() { return this; } } as unknown as NodeJS.Timeout;
  const runner = new NativeClaudeAutomationRunner({
    spawn: () => child as unknown as ChildProcess,
    platform: 'win32',
    goalClearTimeoutMs: 25,
    goalClearKillTimeoutMs: 10,
    setTimeout: (callback) => {
      callbacks.push(callback);
      return timeout;
    },
    clearTimeout: () => undefined,
  });

  const completion = runner.clearGoal({
    cwd: '/workspace/project',
    providerSessionId: EXISTING_SESSION_ID,
  });
  callbacks[0]();
  callbacks[1]();
  const result = await completion;
  assert.equal(result.success, false);
  assert.match(result.error?.message ?? '', /timed out/);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('starts loop in a deterministic tmux session without interpolating user input into a shell command', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'cloudcli-loop-start-'));
  let alive = false;
  let deliveredEnvironment: Record<string, string> | null = null;
  const calls: Array<{ command: string; args: readonly string[]; options: any }> = [];
  const execFile: NonNullable<NativeClaudeAutomationDependencies['execFile']> = async (
    command,
    args,
    options,
  ) => {
    calls.push({ command, args: [...args], options });
    if (args[0] === '-V') return { stdout: 'tmux 3.6', stderr: '' };
    if (args[0] === 'has-session') {
      if (alive) return { stdout: '', stderr: '' };
      throw Object.assign(new Error('missing session'), { code: 1, stderr: "can't find session" });
    }
    if (args[0] === 'new-session') {
      alive = true;
      deliveredEnvironment = await acknowledgeLoopEnvironment(args);
    }
    return { stdout: '', stderr: '' };
  };
  const runner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    claudeCommand: '/opt/Claude Code/claude',
    execFile,
    launcherPath: '/opt/CloudCLI/tmux-claude-launcher.js',
    nodeCommand: '/opt/node/bin/node',
    platform: 'darwin',
    processEnv: {
      ANTHROPIC_API_KEY: 'secret-from-process',
      CLOUDCLI_AUTOMATION_ID: 'must-not-leak',
      TMUX: 'stale-tmux-client',
    },
    automationStateDir: stateDir,
  });
  const command = '/loop 5m check build; touch /tmp/should-not-run';
  const handle = await runner.startLoop(createGoalOptions({
    command,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-from-options' },
  }));

  assert.equal(handle.runtimeId, createTmuxSessionName('chat-session-1'));
  const newSessionCall = calls.find(({ args }) => args[0] === 'new-session');
  assert.ok(newSessionCall);
  assert.equal(newSessionCall.command, 'tmux');
  assert.equal(newSessionCall.args.at(-1), 'exec "$CLOUDCLI_AUTOMATION_NODE" "$CLOUDCLI_AUTOMATION_LAUNCHER"');
  assert.equal(newSessionCall.args.some((arg) => arg.includes('touch /tmp/should-not-run')), false);
  assert.equal(newSessionCall.args.includes('ELECTRON_RUN_AS_NODE=1'), true);
  assert.equal(newSessionCall.args.some((arg) => arg.includes('secret-from-')), false);
  assert.deepEqual(newSessionCall.options.env, { TMUX: 'stale-tmux-client' });

  const encodedEntry = newSessionCall.args.find((arg) => arg.startsWith('CLOUDCLI_AUTOMATION_CLAUDE_ARGS='));
  assert.ok(encodedEntry);
  const encodedArgs = encodedEntry.slice(encodedEntry.indexOf('=') + 1);
  const claudeArgs = JSON.parse(Buffer.from(encodedArgs, 'base64url').toString('utf8')) as string[];
  assert.equal(claudeArgs[0], '--ax-screen-reader');
  assert.ok(claudeArgs.includes('--plugin-dir'));
  assert.deepEqual(claudeArgs.slice(-3), ['--resume', EXISTING_SESSION_ID, command]);

  assert.equal(newSessionCall.args.some((arg) => arg.includes('ENV_PATH=')), false);
  const receivedEnvironment = deliveredEnvironment as Record<string, string> | null;
  assert.ok(receivedEnvironment);
  assert.equal(receivedEnvironment.ANTHROPIC_API_KEY, 'secret-from-process');
  assert.equal(receivedEnvironment.CLAUDE_CODE_OAUTH_TOKEN, 'secret-from-options');
  assert.equal(receivedEnvironment.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(receivedEnvironment.CLOUDCLI_AUTOMATION_ID, 'chat-session-1');
  assert.equal(receivedEnvironment.TMUX, undefined);
  const socketEntry = newSessionCall.args.find((arg) => (
    arg.startsWith('CLOUDCLI_AUTOMATION_ENV_SOCKET=')
  ));
  assert.ok(socketEntry);
  await assert.rejects(readFile(socketEntry.slice(socketEntry.indexOf('=') + 1), 'utf8'));
  await rm(stateDir, { recursive: true, force: true });
});

test('times out an unacknowledged Loop environment handoff and removes every socket artifact', async () => {
  const calls: string[][] = [];
  let socketPath = '';
  const runner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    execFile: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === '-V') return { stdout: '', stderr: '' };
      if (args[0] === 'new-session') {
        const entry = args.find((argument) => (
          argument.startsWith('CLOUDCLI_AUTOMATION_ENV_SOCKET=')
        ));
        assert.ok(entry);
        socketPath = entry.slice(entry.indexOf('=') + 1);
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'kill-session') return { stdout: '', stderr: '' };
      throw Object.assign(new Error('missing session'), { code: 1, stderr: "can't find session" });
    },
    platform: 'linux',
    processEnv: {},
    loopEnvironmentHandshakeTimeoutMs: 10,
  });

  await assert.rejects(
    runner.startLoop(createGoalOptions({ command: '/loop 5m check status' })),
    /did not acknowledge/,
  );
  assert.ok(calls.some((args) => args[0] === 'kill-session'));
  assert.ok(socketPath);
  await assert.rejects(readFile(socketPath, 'utf8'));
});

test('rejects oversized Loop environments before tmux starts and removes legacy env files', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'cloudcli-loop-legacy-env-'));
  await writeFile(path.join(stateDir, 'old.env.json'), '{"TOKEN":"secret"}', 'utf8');
  await writeFile(path.join(stateDir, 'keep.json'), '{}', 'utf8');
  const calls: string[][] = [];
  const runner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    execFile: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === '-V') return { stdout: 'tmux 3.6', stderr: '' };
      if (args[0] === 'has-session') {
        throw Object.assign(new Error('missing session'), {
          code: 1,
          stderr: "can't find session",
        });
      }
      return { stdout: '', stderr: '' };
    },
    platform: 'linux',
    processEnv: { PATH: '/usr/bin' },
    automationStateDir: stateDir,
  });

  assert.equal(await runner.cleanupStaleLoopEnvironmentFiles(), 1);
  await assert.rejects(readFile(path.join(stateDir, 'old.env.json'), 'utf8'));
  assert.equal(await readFile(path.join(stateDir, 'keep.json'), 'utf8'), '{}');
  await assert.rejects(
    runner.startLoop(createGoalOptions({
      command: '/loop 5m check status',
      env: { HUGE_SECRET: 'x'.repeat(4 * 1024 * 1024) },
    })),
    /environment exceeds/,
  );
  assert.equal(calls.some((args) => args[0] === 'new-session'), false);
  await rm(stateDir, { recursive: true, force: true });
});

test('rejects a Loop whose tmux session exits during startup confirmation', async () => {
  const calls: string[][] = [];
  const runner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    execFile: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === '-V') return { stdout: '', stderr: '' };
      if (args[0] === 'new-session') {
        await acknowledgeLoopEnvironment(args);
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'kill-session') return { stdout: '', stderr: '' };
      throw Object.assign(new Error('missing session'), { code: 1, stderr: "can't find session" });
    },
    delay: async () => undefined,
    platform: 'linux',
    processEnv: {},
  });

  await assert.rejects(
    runner.startLoop(createGoalOptions({ command: '/loop 5m check status' })),
    (error: unknown) => error instanceof NativeClaudeAutomationError
      && error.code === 'AUTOMATION_NOT_FOUND',
  );
  assert.ok(calls.some((args) => args[0] === 'kill-session'));
});

test('sends literal loop input and stops with Escape, /exit, then a tmux kill fallback', async () => {
  let alive = false;
  const calls: string[][] = [];
  const delays: number[] = [];
  const execFile = async (_command: string, args: readonly string[]): Promise<ExecFileResult> => {
    calls.push([...args]);
    if (args[0] === '-V') return { stdout: 'tmux 3.6', stderr: '' };
    if (args[0] === 'has-session') {
      if (alive) return { stdout: '', stderr: '' };
      throw Object.assign(new Error('missing session'), { code: 1, stderr: "can't find session" });
    }
    if (args[0] === 'new-session') alive = true;
    if (args[0] === 'new-session') await acknowledgeLoopEnvironment(args);
    if (args[0] === 'kill-session') alive = false;
    return { stdout: '', stderr: '' };
  };
  const runner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    execFile,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
    platform: 'linux',
    processEnv: {},
    escapeDelayMs: 10,
    exitDelayMs: 20,
  });
  await runner.startLoop(createGoalOptions({ command: '/loop 5m check status' }));
  calls.length = 0;
  delays.length = 0;

  const multilineInput = 'status; rm -rf /\nthen summarize';
  await runner.sendInput('chat-session-1', multilineInput);
  const inputCalls = calls.filter((args) => args[0] !== 'has-session');
  assert.equal(inputCalls[0][0], 'load-buffer');
  assert.deepEqual(inputCalls[1], [
    'paste-buffer',
    '-p',
    '-b',
    inputCalls[0][2],
    '-t',
    createTmuxSessionName('chat-session-1'),
    ';',
    'send-keys',
    '-t',
    createTmuxSessionName('chat-session-1'),
    'Enter',
    ';',
    'delete-buffer',
    '-b',
    inputCalls[0][2],
  ]);
  assert.equal(inputCalls.length, 2);
  assert.equal(calls.some((args) => args.includes(multilineInput)), false);
  await assert.rejects(
    runner.sendInput('chat-session-1', '  \n  '),
    (error: unknown) => error instanceof NativeClaudeAutomationError
      && error.code === 'INVALID_OPTIONS',
  );
  await assert.rejects(
    runner.sendInput('chat-session-1', 'unsafe\u001b[2J'),
    (error: unknown) => error instanceof NativeClaudeAutomationError
      && error.code === 'INVALID_OPTIONS',
  );

  calls.length = 0;
  assert.equal(await runner.stop('chat-session-1'), true);
  const meaningfulCalls = calls.filter((args) => args[0] !== 'has-session');
  assert.deepEqual(meaningfulCalls, [
    ['send-keys', '-t', createTmuxSessionName('chat-session-1'), 'Escape'],
    ['send-keys', '-t', createTmuxSessionName('chat-session-1'), '-l', '--', '/exit'],
    ['send-keys', '-t', createTmuxSessionName('chat-session-1'), 'Enter'],
    ['kill-session', '-t', createTmuxSessionName('chat-session-1')],
  ]);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(await runner.has('chat-session-1'), false);
});

test('discovers a deterministic tmux loop after a service restart', async () => {
  const expectedRuntimeId = createTmuxSessionName('persisted-chat');
  const runner = new NativeClaudeAutomationRunner({
    execFile: async (_command, args) => {
      if (args[0] === '-V') return { stdout: 'tmux 3.6', stderr: '' };
      if (args[0] === 'has-session' && args.at(-1) === expectedRuntimeId) {
        return { stdout: '', stderr: '' };
      }
      throw Object.assign(new Error('missing session'), { code: 1, stderr: "can't find session" });
    },
    platform: 'linux',
    processEnv: {},
  });

  assert.equal(runner.hasLocal('persisted-chat'), false);
  assert.equal(await runner.hasLoop('persisted-chat'), true);
  assert.equal(await runner.has('persisted-chat'), true);
});

test('does not mistake tmux permission failures for a missing Loop session', async () => {
  const runner = new NativeClaudeAutomationRunner({
    execFile: async (_command, args) => {
      if (args[0] === '-V') return { stdout: 'tmux 3.6', stderr: '' };
      throw Object.assign(new Error('tmux socket permission denied'), {
        code: 1,
        stderr: 'error connecting to /tmp/tmux/default (Permission denied)',
      });
    },
    platform: 'linux',
    processEnv: {},
  });

  await assert.rejects(runner.hasLoop('persisted-chat'), /permission denied/);
});

test('Loop observer persists whether a scheduler was ever armed across Stop hooks', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'cloudcli-loop-observer-'));
  const automationId = 'observer-generation-1';
  const runner = new NativeClaudeAutomationRunner({ automationStateDir: stateDir });

  try {
    await runLoopObserver(stateDir, automationId, {
      session_id: 'native-session',
      session_crons: [],
      background_tasks: [],
    });
    assert.deepEqual(await runner.readLoopObservation(automationId), {
      automationId,
      observedAt: (await runner.readLoopObservation(automationId))?.observedAt,
      sessionId: 'native-session',
      everScheduled: false,
      sessionCrons: [],
      backgroundTasks: [],
    });

    await runLoopObserver(stateDir, automationId, {
      session_id: 'native-session',
      session_crons: [{ id: 'cron-1' }],
      background_tasks: [],
    });
    assert.equal((await runner.readLoopObservation(automationId))?.everScheduled, true);

    await runLoopObserver(stateDir, automationId, {
      session_id: 'native-session',
      session_crons: [],
      background_tasks: [{ id: 'task-1' }],
    });
    const completedCronObservation = await runner.readLoopObservation(automationId);
    assert.equal(completedCronObservation?.everScheduled, true);
    assert.deepEqual(completedCronObservation?.sessionCrons, []);
    assert.deepEqual(completedCronObservation?.backgroundTasks, [{ id: 'task-1' }]);

    const legacyId = 'legacy-observer-generation';
    await writeFile(path.join(stateDir, `${legacyId}.json`), JSON.stringify({
      schema_version: 1,
      automation_id: legacyId,
      observed_at: new Date().toISOString(),
      session_id: 'legacy-session',
      session_crons: [],
      background_tasks: [],
    }), 'utf8');
    assert.equal((await runner.readLoopObservation(legacyId))?.everScheduled, false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('reports a clear error when tmux is missing and rejects loop on Windows', async () => {
  const missingTmuxRunner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    execFile: async () => {
      throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
    },
    platform: 'linux',
    processEnv: {},
  });
  await assert.rejects(
    missingTmuxRunner.startLoop(createGoalOptions({ command: '/loop' })),
    (error: unknown) => error instanceof NativeClaudeAutomationError
      && error.code === 'TMUX_UNAVAILABLE'
      && error.message.includes('tmux is required'),
  );

  const windowsRunner = new NativeClaudeAutomationRunner({
    claudeVersion: '2.1.145 (Claude Code)',
    platform: 'win32',
  });
  await assert.rejects(
    windowsRunner.startLoop(createGoalOptions({ command: '/loop' })),
    (error: unknown) => error instanceof NativeClaudeAutomationError
      && error.code === 'UNSUPPORTED_PLATFORM',
  );
});
