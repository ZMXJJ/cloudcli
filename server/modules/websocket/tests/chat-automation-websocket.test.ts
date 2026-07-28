import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WebSocket } from 'ws';

import {
  ClaudeAutomationService,
  type ClaudeAutomationRunner,
  type NativeClaudeAutomationStartOptions,
  type NativeClaudeGoalCallbacks,
  type NativeClaudeGoalClearOptions,
  type NativeClaudeGoalExit,
  type NativeClaudeGoalHandle,
  type NativeClaudeLoopHandle,
} from '@/modules/automations/index.js';
import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  broadcastAutomationState,
  chatRunRegistry,
} from '@/modules/websocket/index.js';
import {
  handleChatConnection,
  type ChatWebSocketDependencies,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AuthenticatedWebSocketRequest, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

const APP_SESSION_ID = '4f9248f0-5fe3-4a77-a475-23f496272edd';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Array<Record<string, any>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, any>);
  }

  receive(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  disconnect(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

type FakeGoal = {
  callbacks: NativeClaudeGoalCallbacks;
  completion: Deferred<NativeClaudeGoalExit>;
};

class FakeAutomationRunner implements ClaudeAutomationRunner {
  readonly goalStarts: NativeClaudeAutomationStartOptions[] = [];
  readonly goals = new Map<string, FakeGoal>();
  readonly loopStarts: NativeClaudeAutomationStartOptions[] = [];
  readonly loopInputs: Array<{ sessionId: string; text: string }> = [];
  readonly loopStops: string[] = [];
  readonly aliveLoops = new Set<string>();

  startGoal(
    options: NativeClaudeAutomationStartOptions,
    callbacks: NativeClaudeGoalCallbacks = {},
  ): NativeClaudeGoalHandle {
    this.goalStarts.push(options);
    const completion = deferred<NativeClaudeGoalExit>();
    this.goals.set(options.automationId, { callbacks, completion });
    return {
      automationId: options.automationId,
      runtimeId: 'goal-pid-42',
      pid: 42,
      completion: completion.promise,
      interrupt: () => this.interruptGoal(options.automationId),
    };
  }

  interruptGoal(automationId: string): boolean {
    const goal = this.goals.get(automationId);
    if (!goal) return false;
    this.goals.delete(automationId);
    goal.completion.resolve({
      automationId,
      code: null,
      signal: 'SIGINT',
      interrupted: true,
      result: null,
    });
    return true;
  }

  clearGoal(_options: NativeClaudeGoalClearOptions) {
    return Promise.resolve({
      success: true,
      code: 0,
      signal: null,
      events: [],
      result: null,
      stderr: '',
    });
  }

  hasGoal(automationId: string): boolean {
    return this.goals.has(automationId);
  }

  cleanupGoalRuntime() {
    return Promise.resolve({ status: 'not_found' as const, matchedProcessCount: 0 });
  }

  startLoop(options: NativeClaudeAutomationStartOptions) {
    this.loopStarts.push(options);
    this.aliveLoops.add(options.automationId);
    return Promise.resolve({
      automationId: options.automationId,
      runtimeId: `tmux-${options.automationId}`,
    });
  }

  hasLoop(automationId: string): Promise<boolean> {
    return Promise.resolve(this.aliveLoops.has(automationId));
  }

  sendLoopInput(automationId: string, text: string): Promise<void> {
    this.loopInputs.push({ sessionId: automationId, text });
    return Promise.resolve();
  }

  stopLoop(automationId: string): Promise<boolean> {
    this.loopStops.push(automationId);
    return Promise.resolve(this.aliveLoops.delete(automationId));
  }

  readLoopObservation() {
    return Promise.resolve(null);
  }

  clearLoopObservation() {
    return Promise.resolve();
  }

  cleanupStaleLoopEnvironmentFiles() {
    return Promise.resolve(0);
  }

  emitGoalEvent(automationId: string, value: unknown): void {
    this.goals.get(automationId)?.callbacks.onEvent?.(value, JSON.stringify(value));
  }

  completeGoal(automationId: string): void {
    const goal = this.goals.get(automationId);
    assert.ok(goal);
    this.goals.delete(automationId);
    goal.completion.resolve({
      automationId,
      code: 0,
      signal: null,
      interrupted: false,
      result: {
        raw: '{"type":"result","subtype":"success","is_error":false}',
        value: { type: 'result', subtype: 'success', is_error: false },
        subtype: 'success',
        isError: false,
        errors: [],
        message: null,
      },
    });
  }
}

function normalizeClaudeEvent(raw: unknown, sessionId: string | null): NormalizedMessage[] {
  if (!raw || typeof raw !== 'object') return [];
  const event = raw as Record<string, any>;
  if (event.type !== 'assistant' || typeof event.message?.content !== 'string') return [];
  return [createNormalizedMessage({
    kind: 'text',
    role: 'assistant',
    content: event.message.content,
    sessionId,
    provider: 'claude',
  })];
}

function createDependencies(
  automations: ClaudeAutomationService,
): ChatWebSocketDependencies {
  const spawn = async () => undefined;
  const abort = () => false;
  return {
    spawnFns: { claude: spawn, codex: spawn, cursor: spawn, opencode: spawn },
    abortFns: { claude: abort, codex: abort, cursor: abort, opencode: abort },
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
    automations,
    normalizeMessage: (_provider, raw, sessionId) => normalizeClaudeEvent(raw, sessionId),
  };
}

function connect(
  automations: ClaudeAutomationService,
  configureDependencies?: (dependencies: ChatWebSocketDependencies) => void,
): FakeWebSocket {
  const ws = new FakeWebSocket();
  const dependencies = createDependencies(automations);
  configureDependencies?.(dependencies);
  handleChatConnection(
    ws as unknown as WebSocket,
    { user: { id: 'test-user' } } as AuthenticatedWebSocketRequest,
    dependencies,
  );
  return ws;
}

async function flushEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function withIsolatedDatabase(
  runTest: (context: {
    runner: FakeAutomationRunner;
    automations: ClaudeAutomationService;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-automation-ws-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  sessionsDb.createAppSession(APP_SESSION_ID, 'claude', '/workspace/demo');

  const runner = new FakeAutomationRunner();
  const automations = new ClaudeAutomationService({
    runner,
    onState: broadcastAutomationState,
    loopLivenessIntervalMs: 0,
  });

  try {
    await runTest({ runner, automations });
  } finally {
    automations.dispose();
    for (const client of connectedClients) {
      (client as unknown as FakeWebSocket).disconnect();
    }
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('Goal keeps running across browser disconnect and resumes its stream on subscribe', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const firstSocket = connect(automations);
    firstSocket.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      content: '/goal tests pass',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();

    const runningGoal = automations.getSnapshot(APP_SESSION_ID);
    assert.equal(runningGoal?.state, 'running');
    assert.ok(runningGoal?.automationId);
    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), true);
    assert.equal(runner.goalStarts[0]?.sessionId, APP_SESSION_ID);
    assert.equal(runner.goalStarts[0]?.providerSessionId, undefined);

    runner.emitGoalEvent(runningGoal?.automationId ?? '', {
      type: 'system',
      subtype: 'init',
      session_id: APP_SESSION_ID,
    });
    await flushEvents();
    assert.equal(sessionsDb.getSessionById(APP_SESSION_ID)?.provider_session_id, APP_SESSION_ID);

    firstSocket.disconnect();
    assert.equal(automations.getSnapshot(APP_SESSION_ID)?.state, 'running');
    assert.equal(runner.hasGoal(runningGoal?.automationId ?? ''), true);

    const secondSocket = connect(automations);
    secondSocket.receive({
      type: 'chat.subscribe',
      sessions: [{ sessionId: APP_SESSION_ID, lastSeq: 0 }],
    });
    await flushEvents();
    const subscribed = secondSocket.frames.find(({ kind }) => kind === 'chat_subscribed');
    assert.equal(subscribed?.isProcessing, true);
    assert.equal(subscribed?.automation?.state, 'running');

    runner.emitGoalEvent(runningGoal?.automationId ?? '', {
      type: 'assistant',
      message: { content: 'All tests pass.' },
    });
    runner.completeGoal(runningGoal?.automationId ?? '');
    await flushEvents();

    assert.equal(automations.getSnapshot(APP_SESSION_ID)?.state, 'completed');
    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), false);
    assert.ok(secondSocket.frames.some(({ kind, content }) => (
      kind === 'text' && content === 'All tests pass.'
    )));
    assert.equal(secondSocket.frames.filter(({ kind }) => kind === 'complete').length, 1);
    secondSocket.disconnect();
  });
});

test('subscribe replays a replacement run from seq zero when the client sends an old runId', async () => {
  await withIsolatedDatabase(async ({ automations }) => {
    const producer = new FakeWebSocket();
    const firstRun = chatRunRegistry.startRun({
      appSessionId: APP_SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: producer as unknown as WebSocket,
      userId: 'test-user',
    });
    assert.ok(firstRun);
    firstRun.writer.send({
      kind: 'complete',
      provider: 'claude',
      sessionId: APP_SESSION_ID,
      exitCode: 0,
    });

    const secondRun = chatRunRegistry.startRun({
      appSessionId: APP_SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: producer as unknown as WebSocket,
      userId: 'test-user',
    });
    assert.ok(secondRun);
    secondRun.writer.send({
      kind: 'text',
      provider: 'claude',
      sessionId: APP_SESSION_ID,
      content: 'replacement run event',
    });

    const subscriber = connect(automations);
    subscriber.receive({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: APP_SESSION_ID,
        runId: firstRun.runId,
        lastSeq: 999,
      }],
    });
    await flushEvents();

    const subscribed = subscriber.frames.find(({ kind }) => kind === 'chat_subscribed');
    assert.equal(subscribed?.runId, secondRun.runId);
    assert.ok(subscriber.frames.some((frame) => (
      frame.kind === 'text'
      && frame.runId === secondRun.runId
      && frame.seq === 1
      && frame.content === 'replacement run event'
    )));

    chatRunRegistry.completeRun(APP_SESSION_ID, { exitCode: 0 });
    subscriber.disconnect();
  });
});

test('Goal broadcasts its terminal event to every subscribed tab', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const firstSocket = connect(automations);
    const secondSocket = connect(automations);
    for (const socket of [firstSocket, secondSocket]) {
      socket.receive({
        type: 'chat.subscribe',
        sessions: [{ sessionId: APP_SESSION_ID }],
      });
    }
    await flushEvents();

    firstSocket.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      content: '/goal tests pass',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();

    const runningGoal = automations.getSnapshot(APP_SESSION_ID);
    assert.ok(runningGoal?.automationId);

    runner.completeGoal(runningGoal?.automationId ?? '');
    await flushEvents();

    assert.equal(firstSocket.frames.filter(({ kind }) => kind === 'complete').length, 1);
    assert.equal(secondSocket.frames.filter(({ kind }) => kind === 'complete').length, 1);
    firstSocket.disconnect();
    secondSocket.disconnect();
  });
});

test('typed Goal stop requires the current automation generation', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const ws = connect(automations);
    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      content: '/goal tests pass',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();

    const runningGoal = automations.getSnapshot(APP_SESSION_ID);
    assert.ok(runningGoal?.automationId);

    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'goal-stop-without-generation',
      content: '/goal stop',
      options: {},
    });
    await flushEvents();

    assert.equal(automations.getSnapshot(APP_SESSION_ID)?.state, 'running');
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'AUTOMATION_ID_REQUIRED'
      && frame.requestId === 'goal-stop-without-generation'
      && frame.preserveProcessing === true
    )));

    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'goal-stop-current-generation',
      automationId: runningGoal?.automationId,
      content: '/goal stop',
      options: {},
    });
    await flushEvents();

    assert.equal(automations.getSnapshot(APP_SESSION_ID)?.state, 'stopped');
    assert.equal(runner.hasGoal(runningGoal?.automationId ?? ''), false);
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'automation_state'
      && frame.requestId === 'goal-stop-current-generation'
      && frame.automation?.state === 'stopped'
    )));
    ws.disconnect();
  });
});

test('Goal status errors retain request correlation when no automation exists', async () => {
  await withIsolatedDatabase(async ({ automations }) => {
    const ws = connect(automations);
    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'goal-status-without-automation',
      content: '/goal',
      options: {},
    });
    await flushEvents();

    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'NO_AUTOMATION'
      && frame.requestId === 'goal-status-without-automation'
    )));
    ws.disconnect();
  });
});

test('correlates concurrent detached command confirmations without tagging broadcasts', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const loopStart = deferred<NativeClaudeLoopHandle>();
    runner.startLoop = (options) => {
      runner.loopStarts.push(options);
      runner.aliveLoops.add(options.automationId);
      return loopStart.promise;
    };

    const initiator = connect(automations);
    const observer = connect(automations);
    for (const socket of [initiator, observer]) {
      socket.receive({
        type: 'chat.subscribe',
        sessions: [{ sessionId: APP_SESSION_ID }],
      });
    }
    await flushEvents();
    initiator.frames.length = 0;
    observer.frames.length = 0;

    initiator.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-start-delayed',
      content: '/loop 5m check the deployment',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();

    const startingLoop = automations.getSnapshot(APP_SESSION_ID);
    assert.equal(startingLoop?.state, 'starting');
    assert.ok(startingLoop?.automationId);

    initiator.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'goal-status-during-start',
      automationId: startingLoop?.automationId,
      content: '/goal',
      options: {},
    });
    await flushEvents();

    const statusConfirmationIndex = initiator.frames.findIndex((frame) => (
      frame.kind === 'automation_state'
      && frame.requestId === 'goal-status-during-start'
      && frame.automation?.state === 'starting'
    ));
    assert.notEqual(statusConfirmationIndex, -1);
    assert.ok(observer.frames.some((frame) => (
      frame.kind === 'automation_state'
      && frame.automation?.state === 'starting'
      && frame.requestId === undefined
    )));
    assert.ok(observer.frames.every((frame) => (
      frame.kind !== 'automation_state' || frame.requestId === undefined
    )));

    loopStart.resolve({
      automationId: startingLoop?.automationId ?? '',
      runtimeId: `tmux-${startingLoop?.automationId}`,
    });
    await flushEvents();

    const startConfirmationIndex = initiator.frames.findIndex((frame) => (
      frame.kind === 'automation_state'
      && frame.requestId === 'loop-start-delayed'
      && frame.automation?.state === 'running'
    ));
    assert.ok(startConfirmationIndex > statusConfirmationIndex);
    assert.equal(initiator.frames.filter((frame) => (
      frame.kind === 'automation_state'
      && (
        frame.requestId === 'goal-status-during-start'
        || frame.requestId === 'loop-start-delayed'
      )
    )).length, 2);
    assert.ok(observer.frames.some((frame) => (
      frame.kind === 'automation_state'
      && frame.automation?.state === 'running'
      && frame.requestId === undefined
    )));
    assert.ok(observer.frames.every((frame) => (
      frame.kind !== 'automation_state' || frame.requestId === undefined
    )));

    await automations.stop(APP_SESSION_ID, startingLoop?.automationId);
    initiator.disconnect();
    observer.disconnect();
  });
});

test('Loop stays detached, accepts normal chat input, then supports Stop and Dismiss', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const firstSocket = connect(automations);
    firstSocket.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-start-1',
      content: '/loop 5m check the deployment',
      options: {
        permissionMode: 'auto',
        toolsSettings: {
          allowedTools: ['Read', 42, 'Bash'],
          disallowedTools: ['WebFetch', null],
        },
      },
    });
    await flushEvents();

    const runningLoop = automations.getSnapshot(APP_SESSION_ID);
    assert.equal(runningLoop?.state, 'running');
    assert.ok(runningLoop?.automationId);
    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), false);
    assert.equal(runner.aliveLoops.has(runningLoop?.automationId ?? ''), true);
    assert.equal(sessionsDb.getSessionById(APP_SESSION_ID)?.provider_session_id, APP_SESSION_ID);
    assert.deepEqual(runner.loopStarts[0]?.allowedTools, ['Read', 'Bash']);
    assert.deepEqual(runner.loopStarts[0]?.disallowedTools, ['WebFetch']);

    firstSocket.disconnect();
    const secondSocket = connect(automations);
    secondSocket.receive({
      type: 'chat.subscribe',
      sessions: [{ sessionId: APP_SESSION_ID }],
    });
    await flushEvents();
    assert.equal(
      secondSocket.frames.find(({ kind }) => kind === 'chat_subscribed')?.automation?.kind,
      'loop',
    );

    secondSocket.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-input-1',
      automationId: runningLoop?.automationId,
      content: 'check immediately',
      options: {},
    });
    await flushEvents();
    assert.deepEqual(runner.loopInputs, [{
      sessionId: runningLoop?.automationId,
      text: 'check immediately',
    }]);
    assert.ok(secondSocket.frames.some(({ kind, requestId, automationId }) => (
      kind === 'automation_input_ack'
      && requestId === 'loop-input-1'
      && automationId === runningLoop?.automationId
    )));

    secondSocket.receive({
      type: 'automation.stop',
      sessionId: APP_SESSION_ID,
      automationId: runningLoop?.automationId,
    });
    await flushEvents();
    assert.equal(automations.getSnapshot(APP_SESSION_ID)?.state, 'stopped');
    assert.deepEqual(runner.loopStops, [runningLoop?.automationId]);

    secondSocket.receive({
      type: 'automation.dismiss',
      sessionId: APP_SESSION_ID,
      automationId: runningLoop?.automationId,
    });
    await flushEvents();
    assert.equal(automations.getSnapshot(APP_SESSION_ID), null);
    assert.ok(secondSocket.frames.some(({ kind, automation }) => (
      kind === 'automation_state' && automation === null
    )));
    secondSocket.disconnect();
  });
});

test('Loop rejects stale input and control actions with request correlation', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const ws = connect(automations);
    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-start-stale-test',
      content: '/loop 5m check the deployment',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();

    const runningLoop = automations.getSnapshot(APP_SESSION_ID);
    assert.equal(runningLoop?.state, 'running');

    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'stale-loop-input',
      automationId: 'old-automation-id',
      content: 'this must not reach tmux',
      options: {},
    });
    await flushEvents();

    assert.equal(runner.loopInputs.length, 0);
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'AUTOMATION_STALE_ACTION'
      && frame.requestId === 'stale-loop-input'
      && frame.automationId === 'old-automation-id'
      && frame.preserveProcessing === false
    )));

    ws.receive({
      type: 'chat.abort',
      sessionId: APP_SESSION_ID,
      automationId: 'old-automation-id',
    });
    await flushEvents();

    assert.equal(automations.getSnapshot(APP_SESSION_ID)?.state, 'running');
    assert.equal(runner.loopStops.length, 0);
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'AUTOMATION_STALE_ACTION'
      && frame.automationId === 'old-automation-id'
      && frame.preserveProcessing === true
    )));

    ws.receive({
      type: 'automation.stop',
      sessionId: APP_SESSION_ID,
      requestId: 'stale-loop-stop',
      automationId: 'old-automation-id',
    });
    await flushEvents();

    assert.equal(automations.getSnapshot(APP_SESSION_ID)?.state, 'running');
    assert.equal(runner.loopStops.length, 0);
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'AUTOMATION_STALE_ACTION'
      && frame.requestId === 'stale-loop-stop'
      && frame.preserveProcessing === true
    )));

    await automations.stop(APP_SESSION_ID, runningLoop?.automationId);
    ws.disconnect();
  });
});

test('terminal Loop input with its old automationId cannot fall through to a normal chat run', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    let normalSpawnCalls = 0;
    const ws = connect(automations, (dependencies) => {
      dependencies.spawnFns.claude = async () => {
        normalSpawnCalls += 1;
      };
    });
    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-start-terminal-routing',
      content: '/loop 5m check the deployment',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();

    const runningLoop = automations.getSnapshot(APP_SESSION_ID);
    assert.ok(runningLoop?.automationId);
    await automations.stop(APP_SESSION_ID, runningLoop?.automationId);
    assert.equal(automations.getSnapshot(APP_SESSION_ID)?.state, 'stopped');

    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'terminal-loop-input',
      automationId: runningLoop?.automationId,
      content: 'do not route this as ordinary chat',
      options: {},
    });
    await flushEvents();

    assert.equal(normalSpawnCalls, 0);
    assert.equal(runner.loopInputs.length, 0);
    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), false);
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'AUTOMATION_NOT_RUNNING'
      && frame.requestId === 'terminal-loop-input'
      && frame.automationId === runningLoop?.automationId
    )));
    ws.disconnect();
  });
});

test('Abort before a provider session id exists leaves the regular chat run active', async () => {
  await withIsolatedDatabase(async ({ automations }) => {
    let abortCalls = 0;
    const ws = connect(automations, (dependencies) => {
      dependencies.abortFns.claude = () => {
        abortCalls += 1;
        return true;
      };
    });
    const run = chatRunRegistry.startRun({
      appSessionId: APP_SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: ws as unknown as WebSocket,
      userId: 'test-user',
    });
    assert.ok(run);

    ws.receive({ type: 'chat.abort', sessionId: APP_SESSION_ID });
    await flushEvents();

    assert.equal(abortCalls, 0);
    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), true);
    assert.equal(ws.frames.filter(({ kind }) => kind === 'complete').length, 0);
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'ABORT_NOT_READY'
      && frame.preserveProcessing === true
    )));
    ws.disconnect();
  });
});

test('a rejected regular-chat Abort leaves the run active', async () => {
  await withIsolatedDatabase(async ({ automations }) => {
    let abortCalls = 0;
    const ws = connect(automations, (dependencies) => {
      dependencies.abortFns.claude = () => {
        abortCalls += 1;
        return false;
      };
    });
    const run = chatRunRegistry.startRun({
      appSessionId: APP_SESSION_ID,
      provider: 'claude',
      providerSessionId: 'provider-session-abort-rejected',
      connection: ws as unknown as WebSocket,
      userId: 'test-user',
    });
    assert.ok(run);

    ws.receive({ type: 'chat.abort', sessionId: APP_SESSION_ID });
    await flushEvents();

    assert.equal(abortCalls, 1);
    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), true);
    assert.equal(ws.frames.filter(({ kind }) => kind === 'complete').length, 0);
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'ABORT_REJECTED'
      && frame.preserveProcessing === true
    )));
    ws.disconnect();
  });
});

test('a failed regular-chat Abort leaves the run active', async () => {
  await withIsolatedDatabase(async ({ automations }) => {
    const ws = connect(automations, (dependencies) => {
      dependencies.abortFns.claude = async () => {
        throw new Error('abort transport unavailable');
      };
    });
    const run = chatRunRegistry.startRun({
      appSessionId: APP_SESSION_ID,
      provider: 'claude',
      providerSessionId: 'provider-session-abort-failed',
      connection: ws as unknown as WebSocket,
      userId: 'test-user',
    });
    assert.ok(run);

    ws.receive({ type: 'chat.abort', sessionId: APP_SESSION_ID });
    await flushEvents();

    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), true);
    assert.equal(ws.frames.filter(({ kind }) => kind === 'complete').length, 0);
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'ABORT_FAILED'
      && frame.error === 'abort transport unavailable'
      && frame.preserveProcessing === true
    )));
    ws.disconnect();
  });
});

test('Loop rejects permission modes that can block on an invisible terminal prompt', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const ws = connect(automations);

    for (const permissionMode of ['default', 'plan']) {
      ws.receive({
        type: 'chat.send',
        sessionId: APP_SESSION_ID,
        content: '/loop 5m check the deployment',
        options: { permissionMode },
      });
      await flushEvents();
    }

    assert.equal(runner.loopStarts.length, 0);
    assert.equal(automations.getSnapshot(APP_SESSION_ID), null);
    assert.equal(ws.frames.filter(({ kind, code }) => (
      kind === 'protocol_error' && code === 'LOOP_PERMISSION_MODE_REQUIRED'
    )).length, 2);
    ws.disconnect();
  });
});

test('Goal and Loop reject image attachments instead of silently dropping them', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const ws = connect(automations);

    for (const [requestId, content] of [
      ['goal-with-image', '/goal describe the screenshot'],
      ['loop-with-image', '/loop 5m inspect the screenshot'],
    ]) {
      ws.receive({
        type: 'chat.send',
        sessionId: APP_SESSION_ID,
        requestId,
        content,
        options: {
          permissionMode: 'auto',
          images: [{ path: 'screenshot.png', mimeType: 'image/png' }],
        },
      });
      await flushEvents();

      assert.ok(ws.frames.some((frame) => (
        frame.kind === 'protocol_error'
        && frame.code === 'AUTOMATION_ATTACHMENTS_UNSUPPORTED'
        && frame.requestId === requestId
      )));
    }

    assert.equal(runner.goalStarts.length, 0);
    assert.equal(runner.loopStarts.length, 0);
    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), false);
    assert.equal(automations.getSnapshot(APP_SESSION_ID), null);
    ws.disconnect();
  });
});

test('running Loop rejects malformed or empty chat content without pressing Enter', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const ws = connect(automations);
    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-start-content-validation',
      content: '/loop 5m check the deployment',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();
    const runningLoop = automations.getSnapshot(APP_SESSION_ID);
    assert.ok(runningLoop?.automationId);

    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-input-object',
      automationId: runningLoop.automationId,
      content: { text: 'check now' },
      options: {},
    });
    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-input-empty',
      automationId: runningLoop.automationId,
      content: '  \n  ',
      options: {},
    });
    await flushEvents();

    assert.deepEqual(runner.loopInputs, []);
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'INVALID_CONTENT'
      && frame.requestId === 'loop-input-object'
    )));
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'AUTOMATION_INPUT_FAILED'
      && frame.requestId === 'loop-input-empty'
    )));

    await automations.stop(APP_SESSION_ID, runningLoop.automationId);
    ws.disconnect();
  });
});

test('concurrent Loop input duplicates share one tmux write and acknowledge both sockets', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const firstSocket = connect(automations);
    firstSocket.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-start-concurrent-receipt',
      content: '/loop 5m check the deployment',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();
    const runningLoop = automations.getSnapshot(APP_SESSION_ID);
    assert.ok(runningLoop?.automationId);

    const inputGate = deferred<void>();
    runner.sendLoopInput = async (automationId, text) => {
      runner.loopInputs.push({ sessionId: automationId, text });
      await inputGate.promise;
    };
    const secondSocket = connect(automations);
    const inputFrame = {
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-input-concurrent-receipt',
      automationId: runningLoop.automationId,
      content: 'check immediately',
      options: {},
    };
    firstSocket.receive(inputFrame);
    secondSocket.receive(inputFrame);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(runner.loopInputs, [{
      sessionId: runningLoop.automationId,
      text: 'check immediately',
    }]);
    inputGate.resolve();
    await flushEvents();

    for (const socket of [firstSocket, secondSocket]) {
      assert.equal(socket.frames.filter((frame) => (
        frame.kind === 'automation_input_ack'
        && frame.requestId === 'loop-input-concurrent-receipt'
        && frame.automationId === runningLoop.automationId
      )).length, 1);
    }
    await automations.stop(APP_SESSION_ID, runningLoop.automationId);
    firstSocket.disconnect();
    secondSocket.disconnect();
  });
});

test('replays a Loop input acknowledgement after the original socket disconnects', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    const firstSocket = connect(automations);
    firstSocket.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-start-lost-ack',
      content: '/loop 5m check the deployment',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();
    const runningLoop = automations.getSnapshot(APP_SESSION_ID);
    assert.ok(runningLoop?.automationId);

    const inputFrame = {
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-input-lost-ack',
      automationId: runningLoop.automationId,
      content: 'check immediately',
      options: {},
    };
    firstSocket.receive(inputFrame);
    firstSocket.disconnect();
    await flushEvents();
    assert.equal(firstSocket.frames.some((frame) => (
      frame.kind === 'automation_input_ack' && frame.requestId === 'loop-input-lost-ack'
    )), false);
    assert.deepEqual(runner.loopInputs, [{
      sessionId: runningLoop.automationId,
      text: 'check immediately',
    }]);

    const secondSocket = connect(automations);
    secondSocket.receive(inputFrame);
    await flushEvents();
    assert.equal(secondSocket.frames.filter((frame) => (
      frame.kind === 'automation_input_ack'
      && frame.requestId === 'loop-input-lost-ack'
      && frame.automationId === runningLoop.automationId
    )).length, 1);
    assert.equal(runner.loopInputs.length, 1);

    await automations.stop(APP_SESSION_ID, runningLoop.automationId);
    secondSocket.disconnect();
  });
});

test('Loop receipt conflict and uncertain errors stay correlated and never start normal chat', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    let normalSpawnCalls = 0;
    const ws = connect(automations, (dependencies) => {
      dependencies.spawnFns.claude = async () => {
        normalSpawnCalls += 1;
      };
    });
    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-start-receipt-errors',
      content: '/loop 5m check the deployment',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();
    const runningLoop = automations.getSnapshot(APP_SESSION_ID);
    assert.ok(runningLoop?.automationId);

    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-input-conflict',
      automationId: runningLoop.automationId,
      content: 'original content',
      options: {},
    });
    await flushEvents();
    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-input-conflict',
      automationId: runningLoop.automationId,
      content: 'different content',
      options: {},
    });
    await flushEvents();
    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'AUTOMATION_INPUT_CONFLICT'
      && frame.requestId === 'loop-input-conflict'
      && frame.automationId === runningLoop.automationId
    )));

    runner.sendLoopInput = async (automationId, text) => {
      runner.loopInputs.push({ sessionId: automationId, text });
      throw new Error('tmux input result unavailable');
    };
    const uncertainFrame = {
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-input-uncertain',
      automationId: runningLoop.automationId,
      content: 'possibly delivered content',
      options: {},
    };
    ws.receive(uncertainFrame);
    await flushEvents();
    ws.receive(uncertainFrame);
    await flushEvents();

    assert.ok(ws.frames.some((frame) => (
      frame.kind === 'protocol_error'
      && frame.code === 'AUTOMATION_INPUT_UNCERTAIN'
      && frame.requestId === 'loop-input-uncertain'
      && frame.automationId === runningLoop.automationId
    )));
    assert.equal(runner.loopInputs.filter(({ text }) => text === 'possibly delivered content').length, 1);
    assert.equal(normalSpawnCalls, 0);
    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), false);

    await automations.stop(APP_SESSION_ID, runningLoop.automationId);
    ws.disconnect();
  });
});

test('replays an acknowledged Loop input after the automation becomes terminal', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    let normalSpawnCalls = 0;
    const ws = connect(automations, (dependencies) => {
      dependencies.spawnFns.claude = async () => {
        normalSpawnCalls += 1;
      };
    });
    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-start-terminal-replay',
      content: '/loop 5m check the deployment',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();
    const runningLoop = automations.getSnapshot(APP_SESSION_ID);
    assert.ok(runningLoop?.automationId);

    const inputFrame = {
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-input-terminal-replay',
      automationId: runningLoop.automationId,
      content: 'check immediately',
      options: {},
    };
    ws.receive(inputFrame);
    await flushEvents();
    assert.equal(runner.loopInputs.length, 1);
    assert.equal((await automations.stop(APP_SESSION_ID, runningLoop.automationId)).state, 'stopped');

    const acknowledgementsBeforeReplay = ws.frames.filter((frame) => (
      frame.kind === 'automation_input_ack'
      && frame.requestId === 'loop-input-terminal-replay'
    )).length;
    ws.receive(inputFrame);
    await flushEvents();

    assert.equal(ws.frames.filter((frame) => (
      frame.kind === 'automation_input_ack'
      && frame.requestId === 'loop-input-terminal-replay'
      && frame.automationId === runningLoop.automationId
    )).length, acknowledgementsBeforeReplay + 1);
    assert.equal(runner.loopInputs.length, 1);
    assert.equal(normalSpawnCalls, 0);
    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), false);
    ws.disconnect();
  });
});

test('rejects malformed automation correlation ids without falling through to normal chat', async () => {
  await withIsolatedDatabase(async ({ runner, automations }) => {
    let normalSpawnCalls = 0;
    const ws = connect(automations, (dependencies) => {
      dependencies.spawnFns.claude = async () => {
        normalSpawnCalls += 1;
      };
    });
    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'loop-start-invalid-correlation',
      content: '/loop 5m check the deployment',
      options: { permissionMode: 'auto' },
    });
    await flushEvents();
    const runningLoop = automations.getSnapshot(APP_SESSION_ID);
    assert.ok(runningLoop?.automationId);

    ws.receive({
      type: 'chat.send',
      sessionId: APP_SESSION_ID,
      requestId: 'r'.repeat(129),
      automationId: runningLoop.automationId,
      content: 'must not reach tmux',
      options: {},
    });
    await flushEvents();
    const invalidRequest = ws.frames.find((frame) => frame.code === 'INVALID_REQUEST_ID');
    assert.equal(invalidRequest?.requestId, null);
    assert.equal(runner.loopInputs.length, 0);

    await automations.stop(APP_SESSION_ID, runningLoop.automationId);
    const malformedAutomationIds: unknown[] = ['a'.repeat(129), '   ', 42, null];
    for (const [index, automationId] of malformedAutomationIds.entries()) {
      ws.receive({
        type: 'chat.send',
        sessionId: APP_SESSION_ID,
        requestId: `invalid-automation-${index}`,
        automationId,
        content: 'must not become ordinary chat',
        options: {},
      });
      await flushEvents();
      assert.ok(ws.frames.some((frame) => (
        frame.kind === 'protocol_error'
        && frame.code === 'INVALID_AUTOMATION_ID'
        && frame.requestId === `invalid-automation-${index}`
        && frame.automationId === null
      )));
    }

    assert.equal(normalSpawnCalls, 0);
    assert.equal(chatRunRegistry.isProcessing(APP_SESSION_ID), false);
    ws.disconnect();
  });
});
