import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  ClaudeAutomationInputRow,
  ClaudeAutomationRow,
  StartClaudeAutomationInput as StartClaudeAutomationRowInput,
  UpdateClaudeAutomationInput,
} from '@/modules/database/index.js';

import {
  ClaudeAutomationService,
  ClaudeAutomationServiceError,
  resolveGoalClearOptionsForSession,
  type ClaudeAutomationRepository,
  type ClaudeAutomationRunner,
  type ClaudeAutomationStartInput,
} from '../claude-automation.service.js';
import {
  buildGoalClearClaudeArgs,
  type NativeClaudeAutomationStartOptions,
  type NativeClaudeGoalCallbacks,
  type NativeClaudeGoalCleanupResult,
  type NativeClaudeGoalClearOptions,
  type NativeClaudeGoalClearResult,
  type NativeClaudeGoalExit,
  type NativeClaudeGoalHandle,
  type NativeClaudeLoopHandle,
  type NativeClaudeLoopObservation,
} from '../native-claude-automation.runner.js';

const SESSION_ID = '4f9248f0-5fe3-4a77-a475-23f496272edd';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeAutomationRepository implements ClaudeAutomationRepository {
  readonly rows = new Map<string, ClaudeAutomationRow>();
  readonly inputs = new Map<string, ClaudeAutomationInputRow>();
  private clock = 0;

  getBySessionId(sessionId: string): ClaudeAutomationRow | null {
    return this.rows.get(sessionId) ?? null;
  }

  start(input: StartClaudeAutomationRowInput): ClaudeAutomationRow {
    for (const [key, receipt] of this.inputs) {
      if (receipt.session_id === input.sessionId) this.inputs.delete(key);
    }
    const timestamp = this.timestamp();
    const row: ClaudeAutomationRow = {
      session_id: input.sessionId,
      kind: input.kind,
      state: 'starting',
      runtime: input.runtime,
      command: input.command,
      runtime_id: input.runtimeId ?? null,
      native_task_id: input.nativeTaskId ?? null,
      error: null,
      started_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
    };
    this.rows.set(input.sessionId, row);
    return row;
  }

  update(sessionId: string, patch: UpdateClaudeAutomationInput): ClaudeAutomationRow | null {
    const current = this.rows.get(sessionId);
    if (!current) return null;
    const state = patch.state ?? current.state;
    const terminal = state === 'completed' || state === 'stopped' || state === 'failed';
    const next: ClaudeAutomationRow = {
      ...current,
      state,
      runtime: patch.runtime ?? current.runtime,
      runtime_id: patch.runtimeId === undefined ? current.runtime_id : patch.runtimeId,
      native_task_id: patch.nativeTaskId === undefined
        ? current.native_task_id
        : patch.nativeTaskId,
      error: patch.error === undefined ? current.error : patch.error,
      updated_at: this.timestamp(),
      completed_at: terminal ? current.completed_at ?? this.timestamp() : null,
    };
    this.rows.set(sessionId, next);
    return next;
  }

  dismiss(sessionId: string): boolean {
    const dismissed = this.rows.delete(sessionId);
    if (dismissed) {
      for (const [key, receipt] of this.inputs) {
        if (receipt.session_id === sessionId) this.inputs.delete(key);
      }
    }
    return dismissed;
  }

  listActive(): ClaudeAutomationRow[] {
    return [...this.rows.values()].filter(({ state }) => (
      state === 'starting' || state === 'running' || state === 'stopping'
    ));
  }

  getInput(automationId: string, requestId: string): ClaudeAutomationInputRow | null {
    return this.inputs.get(`${automationId}\u0000${requestId}`) ?? null;
  }

  reserveInput(input: {
    sessionId: string;
    automationId: string;
    requestId: string;
    contentHash: string;
  }): { row: ClaudeAutomationInputRow; inserted: boolean } {
    const key = `${input.automationId}\u0000${input.requestId}`;
    const existing = this.inputs.get(key);
    if (existing) return { row: existing, inserted: false };
    const timestamp = this.timestamp();
    const row: ClaudeAutomationInputRow = {
      session_id: input.sessionId,
      automation_id: input.automationId,
      request_id: input.requestId,
      content_hash: input.contentHash,
      state: 'processing',
      error: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.inputs.set(key, row);
    return { row, inserted: true };
  }

  updateInput(
    automationId: string,
    requestId: string,
    state: ClaudeAutomationInputRow['state'],
    error: string | null,
  ): ClaudeAutomationInputRow | null {
    const key = `${automationId}\u0000${requestId}`;
    const existing = this.inputs.get(key);
    if (!existing) return null;
    const row = { ...existing, state, error, updated_at: this.timestamp() };
    this.inputs.set(key, row);
    return row;
  }

  seed(row: Partial<ClaudeAutomationRow> & Pick<ClaudeAutomationRow, 'session_id' | 'kind'>): void {
    const timestamp = this.timestamp();
    this.rows.set(row.session_id, {
      session_id: row.session_id,
      kind: row.kind,
      state: row.state ?? 'running',
      runtime: row.runtime ?? (row.kind === 'goal' ? 'headless' : 'tmux'),
      command: row.command ?? `/${row.kind} test`,
      runtime_id: row.runtime_id ?? null,
      native_task_id: row.native_task_id ?? null,
      error: row.error ?? null,
      started_at: row.started_at ?? timestamp,
      updated_at: row.updated_at ?? timestamp,
      completed_at: row.completed_at ?? null,
    });
  }

  private timestamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
  }
}

type FakeGoal = {
  callbacks: NativeClaudeGoalCallbacks;
  completion: Deferred<NativeClaudeGoalExit>;
  handle: NativeClaudeGoalHandle;
};

class FakeAutomationRunner implements ClaudeAutomationRunner {
  readonly goalStarts: NativeClaudeAutomationStartOptions[] = [];
  readonly goals = new Map<string, FakeGoal>();
  readonly goalCleanups: Array<{ automationId: string; runtimeId: string | null }> = [];
  readonly loopStarts: NativeClaudeAutomationStartOptions[] = [];
  readonly loopInputs: Array<{ sessionId: string; text: string }> = [];
  readonly loopStops: string[] = [];
  readonly clearCalls: NativeClaudeGoalClearOptions[] = [];
  readonly clearedObservations: string[] = [];
  staleEnvironmentCleanupCalls = 0;
  readonly aliveLoops = new Set<string>();
  readonly observations = new Map<string, NativeClaudeLoopObservation>();
  nextLoopStart: Deferred<NativeClaudeLoopHandle> | null = null;
  nextClear: Deferred<NativeClaudeGoalClearResult> | null = null;
  goalCleanupResult: NativeClaudeGoalCleanupResult = {
    status: 'not_found',
    matchedProcessCount: 0,
  };
  clearResult: NativeClaudeGoalClearResult = {
    success: true,
    code: 0,
    signal: null,
    events: [],
    result: null,
    stderr: '',
  };

  startGoal(
    options: NativeClaudeAutomationStartOptions,
    callbacks: NativeClaudeGoalCallbacks = {},
  ): NativeClaudeGoalHandle {
    this.goalStarts.push(options);
    const completion = deferred<NativeClaudeGoalExit>();
    const handle: NativeClaudeGoalHandle = {
      automationId: options.automationId,
      runtimeId: 'pid-123',
      pid: 123,
      completion: completion.promise,
      interrupt: () => this.interruptGoal(options.automationId),
    };
    this.goals.set(options.automationId, { callbacks, completion, handle });
    return handle;
  }

  interruptGoal(automationId: string): boolean {
    return this.goals.has(automationId);
  }

  clearGoal(options: NativeClaudeGoalClearOptions): Promise<NativeClaudeGoalClearResult> {
    this.clearCalls.push(options);
    if (this.nextClear) return this.nextClear.promise;
    return Promise.resolve(this.clearResult);
  }

  hasGoal(automationId: string): boolean {
    return this.goals.has(automationId);
  }

  cleanupGoalRuntime(automationId: string, runtimeId: string | null) {
    this.goalCleanups.push({ automationId, runtimeId });
    return Promise.resolve(this.goalCleanupResult);
  }

  startLoop(options: NativeClaudeAutomationStartOptions): Promise<NativeClaudeLoopHandle> {
    this.loopStarts.push(options);
    if (this.nextLoopStart) return this.nextLoopStart.promise;
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
    if (!this.aliveLoops.has(automationId)) return Promise.reject(new Error('tmux missing'));
    this.loopInputs.push({ sessionId: automationId, text });
    return Promise.resolve();
  }

  stopLoop(automationId: string): Promise<boolean> {
    this.loopStops.push(automationId);
    return Promise.resolve(this.aliveLoops.delete(automationId));
  }

  readLoopObservation(automationId: string): Promise<NativeClaudeLoopObservation | null> {
    return Promise.resolve(this.observations.get(automationId) ?? null);
  }

  clearLoopObservation(automationId: string): Promise<void> {
    this.clearedObservations.push(automationId);
    this.observations.delete(automationId);
    return Promise.resolve();
  }

  cleanupStaleLoopEnvironmentFiles(): Promise<number> {
    this.staleEnvironmentCleanupCalls += 1;
    return Promise.resolve(0);
  }

  exitGoal(
    automationId: string,
    result: Partial<NativeClaudeGoalExit> = {},
  ): void {
    const goal = this.goals.get(automationId);
    assert.ok(goal);
    this.goals.delete(automationId);
    const exit: NativeClaudeGoalExit = {
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
      ...result,
    };
    goal.callbacks.onExit?.(exit);
    goal.completion.resolve(exit);
  }
}

function goalInput(overrides: Partial<ClaudeAutomationStartInput> = {}): ClaudeAutomationStartInput {
  return {
    sessionId: SESSION_ID,
    providerSessionId: 'provider-session-1',
    cwd: '/workspace/project',
    command: '/goal make tests pass',
    model: 'claude-opus-4-6',
    effort: 'high',
    permissionMode: 'acceptEdits',
    ...overrides,
  };
}

test('starts Goal without awaiting completion, forwards events, and persists completion', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const states: Array<{ sessionId: string; state: string | null }> = [];
  const events: unknown[] = [];
  const malformed: string[] = [];
  const stderr: string[] = [];
  const service = new ClaudeAutomationService({
    db,
    runner,
    onState: (sessionId, snapshot) => states.push({ sessionId, state: snapshot?.state ?? null }),
  });

  const handle = service.startGoal(goalInput(), {
    onEvent: (value) => events.push(value),
    onMalformed: (raw) => malformed.push(raw),
    onStderr: (chunk) => stderr.push(chunk),
  });
  assert.equal(handle.runtimeId, 'pid-123');
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
  assert.deepEqual(states.map(({ state }) => state), ['starting', 'running']);
  assert.deepEqual(runner.goalStarts[0], {
    automationId: handle.automationId,
    providerSessionId: 'provider-session-1',
    cwd: '/workspace/project',
    command: '/goal make tests pass',
    model: 'claude-opus-4-6',
    effort: 'high',
    permissionMode: 'acceptEdits',
    allowedTools: undefined,
    disallowedTools: undefined,
    env: undefined,
  });

  const callbacks = runner.goals.get(handle.automationId)?.callbacks;
  callbacks?.onEvent?.({ type: 'assistant' }, '{"type":"assistant"}');
  callbacks?.onMalformedOutput?.('invalid', new Error('invalid JSON'));
  callbacks?.onStderr?.('warning');
  assert.deepEqual(events, [{ type: 'assistant' }]);
  assert.deepEqual(malformed, ['invalid']);
  assert.deepEqual(stderr, ['warning']);

  runner.exitGoal(handle.automationId);
  await handle.completion;
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'completed');
  assert.deepEqual(states.map(({ state }) => state), ['starting', 'running', 'completed']);
});

test('does not resolve Goal completion until native clear and terminal persistence finish', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const clear = deferred<NativeClaudeGoalClearResult>();
  runner.nextClear = clear;
  const service = new ClaudeAutomationService({ db, runner });
  const handle = service.startGoal(goalInput());
  let settled = false;
  void handle.completion.then(() => {
    settled = true;
  });

  runner.exitGoal(handle.automationId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');

  clear.resolve(runner.clearResult);
  await handle.completion;
  assert.equal(settled, true);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'completed');
});

test('clears a fresh Goal by resuming the session created with the app UUID', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner });
  const handle = service.startGoal(goalInput({ providerSessionId: null }));

  assert.equal(runner.goalStarts[0].sessionId, SESSION_ID);
  assert.equal(runner.goalStarts[0].providerSessionId, undefined);
  runner.exitGoal(handle.automationId);
  await handle.completion;

  assert.equal(runner.clearCalls.length, 1);
  assert.equal(runner.clearCalls[0].providerSessionId, SESSION_ID);
  assert.equal(runner.clearCalls[0].sessionId, undefined);
});

test('default Goal clear resolution resumes the app session when provider id is blank', () => {
  const options = resolveGoalClearOptionsForSession({
    session_id: SESSION_ID,
    provider: 'claude',
    provider_session_id: '   ',
    project_path: ' /workspace/project ',
  });

  assert.ok(options);
  assert.equal(options.cwd, '/workspace/project');
  assert.deepEqual(buildGoalClearClaudeArgs(options).slice(-3), [
    '--resume',
    SESSION_ID,
    '/goal clear',
  ]);
});

test('persists failed and externally interrupted Goal exits', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner });

  const failedHandle = service.startGoal(goalInput());
  runner.exitGoal(failedHandle.automationId, { code: 2 });
  await failedHandle.completion;
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'failed');
  assert.match(service.getSnapshot(SESSION_ID)?.error ?? '', /code 2/);

  const interruptedHandle = service.startGoal(goalInput({ command: '/goal retry' }));
  runner.exitGoal(interruptedHandle.automationId, {
    code: null,
    signal: 'SIGINT',
    interrupted: true,
  });
  await interruptedHandle.completion;
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopped');
});

test('treats an error result as failed even when the Goal process exits zero', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner });
  const handle = service.startGoal(goalInput());
  runner.exitGoal(handle.automationId, {
    code: 0,
    result: {
      raw: '{"type":"result","subtype":"error_during_execution","is_error":true}',
      value: { type: 'result', subtype: 'error_during_execution', is_error: true },
      subtype: 'error_during_execution',
      isError: true,
      errors: ['tool failed'],
      message: 'tool failed',
    },
  });

  await handle.completion;
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'failed');
  assert.equal(service.getSnapshot(SESSION_ID)?.error, 'tool failed');
});

test('Goal Stop wins the completion race, clears native Goal state, and becomes stopped', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const states: string[] = [];
  const service = new ClaudeAutomationService({
    db,
    runner,
    onState: (_sessionId, snapshot) => {
      if (snapshot) states.push(snapshot.state);
    },
  });
  const handle = service.startGoal(goalInput());

  const stopped = service.stop(SESSION_ID);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopping');
  runner.exitGoal(handle.automationId, { code: 0, interrupted: true });
  const snapshot = await stopped;

  assert.equal(snapshot.state, 'stopped');
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopped');
  assert.deepEqual(states, ['starting', 'running', 'stopping', 'stopped']);
  assert.deepEqual(runner.clearCalls, [{
    providerSessionId: 'provider-session-1',
    cwd: '/workspace/project',
    model: 'claude-opus-4-6',
    effort: 'high',
    permissionMode: 'acceptEdits',
    allowedTools: undefined,
    disallowedTools: undefined,
    env: undefined,
  }]);
});

test('keeps Goal stopping when native clear fails and lets Stop retry the clear', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  runner.clearResult = {
    success: false,
    code: 1,
    signal: null,
    events: [],
    result: null,
    stderr: 'clear rejected',
  };
  const service = new ClaudeAutomationService({
    db,
    runner,
    resolveGoalClearOptions: () => ({
      cwd: '/workspace/project',
      providerSessionId: 'provider-session-1',
    }),
  });
  const handle = service.startGoal(goalInput());

  const stopped = service.stop(SESSION_ID);
  runner.exitGoal(handle.automationId, { interrupted: true, code: null, signal: 'SIGINT' });
  await assert.rejects(
    stopped,
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_STOP_FAILED',
  );
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopping');
  assert.match(service.getSnapshot(SESSION_ID)?.error ?? '', /clear rejected/);
  assert.throws(
    () => service.startGoal(goalInput({ command: '/goal must stay blocked' })),
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_ALREADY_ACTIVE',
  );
  await assert.rejects(service.dismiss(SESSION_ID), /must finish/);

  runner.clearResult = {
    ...runner.clearResult,
    success: true,
    code: 0,
    stderr: '',
  };
  const retried = await service.stop(SESSION_ID, handle.automationId);
  await handle.completion;
  assert.equal(retried.state, 'stopped');
  assert.equal(runner.clearCalls.length, 2);
});

test('keeps a naturally finished Goal non-terminal until a failed clear is retried', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  runner.clearResult = {
    success: false,
    code: 1,
    signal: null,
    events: [],
    result: null,
    stderr: 'clear temporarily unavailable',
  };
  const service = new ClaudeAutomationService({
    db,
    runner,
    resolveGoalClearOptions: () => ({
      cwd: '/workspace/project',
      providerSessionId: 'provider-session-1',
    }),
  });
  const handle = service.startGoal(goalInput());
  runner.exitGoal(handle.automationId);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopping');
  runner.clearResult = { ...runner.clearResult, success: true, code: 0, stderr: '' };
  const retried = await service.stop(SESSION_ID, handle.automationId);
  await handle.completion;
  assert.equal(retried.state, 'stopped');
  assert.equal(runner.clearCalls.length, 2);
});

test('session deletion retries unresolved Goal clear and dismisses only after cleanup succeeds', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  runner.clearResult = {
    success: false,
    code: 1,
    signal: null,
    events: [],
    result: null,
    stderr: 'clear temporarily unavailable',
  };
  const service = new ClaudeAutomationService({ db, runner });
  const handle = service.startGoal(goalInput());

  const firstDeletion = service.stopForSessionDeletion(SESSION_ID);
  runner.exitGoal(handle.automationId, {
    interrupted: true,
    code: null,
    signal: 'SIGINT',
  });
  await assert.rejects(firstDeletion, /Could not verify that Claude Goal stopped/);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopping');

  await assert.rejects(
    service.stopForSessionDeletion(SESSION_ID),
    /Could not verify that Claude Goal stopped/,
  );
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopping');
  assert.equal(runner.clearCalls.length, 2);

  runner.clearResult = { ...runner.clearResult, success: true, code: 0, stderr: '' };
  await service.stopForSessionDeletion(SESSION_ID);
  await handle.completion;
  assert.equal(service.getSnapshot(SESSION_ID), null);
  assert.equal(runner.clearCalls.length, 3);
});

test('starts Loop with a fresh Claude session, acknowledges input, stops, and dismisses', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const states: Array<string | null> = [];
  const service = new ClaudeAutomationService({
    db,
    runner,
    onState: (_sessionId, snapshot) => states.push(snapshot?.state ?? null),
  });
  const input = goalInput({
    providerSessionId: null,
    command: '/loop 5m check tests',
  });

  await service.startLoop(input);
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
  assert.equal(runner.loopStarts[0].sessionId, SESSION_ID);
  assert.equal(runner.loopStarts[0].providerSessionId, undefined);
  await service.sendLoopInput(SESSION_ID, 'show status; do not interpolate', automationId, 'input-1');
  assert.deepEqual(runner.loopInputs, [{
    sessionId: automationId,
    text: 'show status; do not interpolate',
  }]);
  assert.deepEqual(states, ['starting', 'running', 'running']);

  const stopped = await service.stop(SESSION_ID);
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(runner.loopStops, [automationId]);
  assert.equal(await service.dismiss(SESSION_ID), true);
  assert.equal(service.getSnapshot(SESSION_ID), null);
  assert.deepEqual(states.slice(-3), ['stopping', 'stopped', null]);
});

test('replays an acknowledged Loop input without writing it to tmux again', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);

  const first = await service.sendLoopInput(
    SESSION_ID,
    'check immediately',
    automationId,
    'input-replay',
  );
  const replayed = await service.sendLoopInput(
    SESSION_ID,
    'check immediately',
    automationId,
    'input-replay',
  );

  assert.equal(first.automationId, automationId);
  assert.equal(replayed.automationId, automationId);
  assert.deepEqual(runner.loopInputs, [{ sessionId: automationId, text: 'check immediately' }]);
  assert.equal(db.getInput(automationId, 'input-replay')?.state, 'acknowledged');
});

test('rejects reuse of a Loop input request id with different content', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);

  await service.sendLoopInput(SESSION_ID, 'first content', automationId, 'input-conflict');
  await assert.rejects(
    service.sendLoopInput(SESSION_ID, 'different content', automationId, 'input-conflict'),
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_INPUT_CONFLICT',
  );

  assert.deepEqual(runner.loopInputs, [{ sessionId: automationId, text: 'first content' }]);
});

test('marks persisted processing Loop input uncertain and keeps uncertain retries non-delivering', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  const content = 'check whether this was delivered';
  db.reserveInput({
    sessionId: SESSION_ID,
    automationId,
    requestId: 'input-uncertain',
    contentHash: createHash('sha256').update(content).digest('hex'),
  });

  for (const expectedStoredState of ['processing', 'uncertain'] as const) {
    assert.equal(db.getInput(automationId, 'input-uncertain')?.state, expectedStoredState);
    await assert.rejects(
      service.sendLoopInput(SESSION_ID, content, automationId, 'input-uncertain'),
      (error: unknown) => error instanceof ClaudeAutomationServiceError
        && error.code === 'AUTOMATION_INPUT_UNCERTAIN',
    );
  }

  assert.equal(db.getInput(automationId, 'input-uncertain')?.state, 'uncertain');
  assert.deepEqual(runner.loopInputs, []);
});

test('clears the previous Loop completion observation before sending new input', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const order: string[] = [];
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  runner.observations.set(automationId, {
    automationId,
    observedAt: new Date().toISOString(),
    sessionId: 'provider-session-1',
    everScheduled: true,
    sessionCrons: [],
    backgroundTasks: [],
  });
  runner.clearLoopObservation = async (id) => {
    order.push('clear');
    runner.clearedObservations.push(id);
    runner.observations.delete(id);
  };
  runner.sendLoopInput = async (id, text) => {
    order.push('send');
    runner.loopInputs.push({ sessionId: id, text });
  };

  await service.sendLoopInput(SESSION_ID, 'run another check', automationId, 'input-clear');

  assert.deepEqual(order, ['clear', 'send']);
  assert.deepEqual(runner.clearedObservations, [automationId]);
  assert.equal(runner.observations.has(automationId), false);
  assert.deepEqual(runner.loopInputs, [{ sessionId: automationId, text: 'run another check' }]);
});

test('serializes Loop input and makes Stop wait for in-flight tmux input', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const firstGate = deferred<void>();
  const thirdGate = deferred<void>();
  const order: string[] = [];
  let activeInputs = 0;
  let maxActiveInputs = 0;
  runner.sendLoopInput = async (_sessionId: string, text: string) => {
    order.push(`start:${text}`);
    activeInputs += 1;
    maxActiveInputs = Math.max(maxActiveInputs, activeInputs);
    if (text === 'first') await firstGate.promise;
    if (text === 'third') await thirdGate.promise;
    activeInputs -= 1;
    order.push(`end:${text}`);
  };
  const service = new ClaudeAutomationService({ db, runner });
  await service.startLoop(goalInput({ command: '/loop check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);

  const first = service.sendLoopInput(SESSION_ID, 'first', automationId, 'input-first');
  const second = service.sendLoopInput(SESSION_ID, 'second', automationId, 'input-second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['start:first']);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
  assert.equal(maxActiveInputs, 1);

  const third = service.sendLoopInput(SESSION_ID, 'third', automationId, 'input-third');
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = service.stop(SESSION_ID);
  await assert.rejects(
    service.sendLoopInput(SESSION_ID, 'after-stop', automationId, 'input-after-stop'),
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_NOT_RUNNING',
  );
  assert.deepEqual(runner.loopStops, []);

  thirdGate.resolve();
  assert.equal((await third).state, 'stopping');
  assert.equal((await stopping).state, 'stopped');
  assert.deepEqual(runner.loopStops, [automationId]);
});

test('rejects unsafe Loop input before reserving a receipt or writing to tmux', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner });
  await service.startLoop(goalInput({ command: '/loop check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);

  await assert.rejects(
    service.sendLoopInput(SESSION_ID, 'invalid\u0000input', automationId, 'input-invalid'),
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_INPUT_FAILED',
  );
  assert.equal(db.getInput(automationId, 'input-invalid'), null);
  assert.deepEqual(runner.loopInputs, []);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
  assert.equal((await service.stop(SESSION_ID, automationId)).state, 'stopped');
  assert.deepEqual(runner.loopStops, [automationId]);
});

test('marks the first failed Loop delivery uncertain and never retries the same receipt', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  runner.sendLoopInput = async (id, text) => {
    runner.loopInputs.push({ sessionId: id, text });
    throw new Error('tmux input result unavailable');
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      service.sendLoopInput(SESSION_ID, 'check now', automationId, 'input-failed-delivery'),
      (error: unknown) => error instanceof ClaudeAutomationServiceError
        && error.code === 'AUTOMATION_INPUT_UNCERTAIN'
        && error.message.includes('Check the transcript'),
    );
  }

  assert.equal(db.getInput(automationId, 'input-failed-delivery')?.state, 'uncertain');
  assert.deepEqual(runner.loopInputs, [{ sessionId: automationId, text: 'check now' }]);
});

test('does not restore running when Loop is stopped while tmux startup is pending', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const loopStart = deferred<NativeClaudeLoopHandle>();
  runner.nextLoopStart = loopStart;
  const states: string[] = [];
  const service = new ClaudeAutomationService({
    db,
    runner,
    onState: (_sessionId, snapshot) => {
      if (snapshot) states.push(snapshot.state);
    },
  });

  const starting = service.startLoop(goalInput({ command: '/loop check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  const stopping = service.stop(SESSION_ID);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopping');
  runner.aliveLoops.add(automationId);
  loopStart.resolve({ automationId, runtimeId: `tmux-${automationId}` });

  await starting;
  assert.equal((await stopping).state, 'stopped');
  assert.deepEqual(states, ['starting', 'stopping', 'stopped']);
});

test('rejects conflicts and only dismisses terminal state', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner });
  service.startGoal(goalInput());

  assert.throws(
    () => service.startGoal(goalInput({ command: '/goal another task' })),
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_ALREADY_ACTIVE',
  );
  await assert.rejects(
    service.dismiss(SESSION_ID),
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_NOT_DISMISSIBLE',
  );
});

test('reconciles surviving tmux Loops and fails missing Loops and headless Goals', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const aliveLoop = '5f9248f0-5fe3-4a77-a475-23f496272edd';
  const missingLoop = '6f9248f0-5fe3-4a77-a475-23f496272edd';
  const staleGoal = '7f9248f0-5fe3-4a77-a475-23f496272edd';
  db.seed({ session_id: aliveLoop, kind: 'loop', state: 'stopping' });
  db.seed({ session_id: missingLoop, kind: 'loop' });
  db.seed({ session_id: staleGoal, kind: 'goal', state: 'starting' });
  runner.aliveLoops.add(aliveLoop);
  const emitted: Array<{ sessionId: string; state: string }> = [];
  const service = new ClaudeAutomationService({
    db,
    runner,
    resolveGoalClearOptions: (sessionId) => ({
      cwd: `/workspace/${sessionId}`,
      providerSessionId: sessionId,
    }),
    onState: (sessionId, snapshot) => {
      if (snapshot) emitted.push({ sessionId, state: snapshot.state });
    },
  });

  const snapshots = await service.reconcileOnStartup();
  assert.equal(snapshots.length, 3);
  assert.equal(service.getSnapshot(aliveLoop)?.state, 'stopped');
  assert.equal(service.getSnapshot(missingLoop)?.state, 'failed');
  assert.match(service.getSnapshot(missingLoop)?.error ?? '', /tmux session was not found/);
  assert.equal(service.getSnapshot(staleGoal)?.state, 'failed');
  assert.match(service.getSnapshot(staleGoal)?.error ?? '', /server restarted/);
  assert.deepEqual(runner.goalCleanups, [{ automationId: staleGoal, runtimeId: null }]);
  assert.deepEqual(runner.clearCalls, [{
    cwd: `/workspace/${staleGoal}`,
    providerSessionId: staleGoal,
  }]);
  assert.deepEqual(emitted, [
    { sessionId: aliveLoop, state: 'stopped' },
    { sessionId: missingLoop, state: 'failed' },
    { sessionId: staleGoal, state: 'failed' },
  ]);
});

test('keeps a restarted Goal active when its process tree cannot be inspected safely', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const automationId = '7f9248f0-5fe3-4a77-a475-23f496272edd';
  db.seed({
    session_id: SESSION_ID,
    kind: 'goal',
    state: 'running',
    native_task_id: automationId,
    runtime_id: 'cloudcli-goal-v1:identity',
  });
  runner.cleanupGoalRuntime = async () => {
    throw new Error('ps permission denied');
  };
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });

  assert.deepEqual(await service.reconcileOnStartup(), []);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopping');
  assert.match(service.getSnapshot(SESSION_ID)?.error ?? '', /inspection failed/);
});

test('keeps unsupported recovered Goal cleanup fail-closed until Stop can verify and clear it', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const automationId = '7f9248f0-5fe3-4a77-a475-23f496272edd';
  const runtimeId = 'legacy-windows-pid-42';
  db.seed({
    session_id: SESSION_ID,
    kind: 'goal',
    state: 'running',
    native_task_id: automationId,
    runtime_id: runtimeId,
  });
  runner.goalCleanupResult = { status: 'unsupported', matchedProcessCount: 0 };
  const service = new ClaudeAutomationService({
    db,
    runner,
    loopLivenessIntervalMs: 0,
    resolveGoalClearOptions: () => ({
      cwd: '/workspace/project',
      providerSessionId: SESSION_ID,
    }),
  });

  assert.deepEqual(await service.reconcileOnStartup(), []);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopping');
  assert.equal(runner.clearCalls.length, 0);

  runner.goalCleanupResult = { status: 'not_found', matchedProcessCount: 0 };
  const stopped = await service.stop(SESSION_ID, automationId);
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(runner.goalCleanups, [
    { automationId, runtimeId },
    { automationId, runtimeId },
  ]);
  assert.deepEqual(runner.clearCalls, [{
    cwd: '/workspace/project',
    providerSessionId: SESSION_ID,
  }]);
});

test('does not clear a replacement Goal generation after recovered cleanup yields', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const oldAutomationId = '7f9248f0-5fe3-4a77-a475-23f496272edd';
  const replacementId = '8f9248f0-5fe3-4a77-a475-23f496272edd';
  db.seed({
    session_id: SESSION_ID,
    kind: 'goal',
    state: 'running',
    native_task_id: oldAutomationId,
    runtime_id: 'cloudcli-goal-v1:old',
  });
  const cleanupGate = deferred<NativeClaudeGoalCleanupResult>();
  const cleanupStarted = deferred<void>();
  runner.cleanupGoalRuntime = () => {
    cleanupStarted.resolve();
    return cleanupGate.promise;
  };
  const service = new ClaudeAutomationService({
    db,
    runner,
    loopLivenessIntervalMs: 0,
    resolveGoalClearOptions: () => ({
      cwd: '/workspace/project',
      providerSessionId: SESSION_ID,
    }),
  });

  const reconciliation = service.reconcileOnStartup();
  await cleanupStarted.promise;
  db.seed({
    session_id: SESSION_ID,
    kind: 'goal',
    state: 'running',
    native_task_id: replacementId,
    runtime_id: 'cloudcli-goal-v1:replacement',
  });
  cleanupGate.resolve({ status: 'not_found', matchedProcessCount: 0 });

  assert.deepEqual(await reconciliation, []);
  assert.equal(service.getSnapshot(SESSION_ID)?.automationId, replacementId);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
  assert.equal(runner.clearCalls.length, 0);
});

test('keeps a Loop manageable when startup tmux inspection fails', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const automationId = '8f9248f0-5fe3-4a77-a475-23f496272edd';
  db.seed({
    session_id: SESSION_ID,
    kind: 'loop',
    state: 'running',
    native_task_id: automationId,
  });
  runner.hasLoop = async () => {
    throw new Error('tmux socket permission denied');
  };
  const emitted: string[] = [];
  const service = new ClaudeAutomationService({
    db,
    runner,
    loopLivenessIntervalMs: 0,
    onState: (_sessionId, snapshot) => {
      if (snapshot) emitted.push(snapshot.state);
    },
  });

  assert.deepEqual(await service.reconcileOnStartup(), []);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
  assert.deepEqual(emitted, []);
  await service.dispose();
});

test('liveness check fails a running Loop after its tmux session exits', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const states: string[] = [];
  const service = new ClaudeAutomationService({
    db,
    runner,
    loopLivenessIntervalMs: 0,
    onState: (_sessionId, snapshot) => {
      if (snapshot) states.push(snapshot.state);
    },
  });
  await service.startLoop(goalInput({ command: '/loop check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  await service.sendLoopInput(SESSION_ID, '/exit', automationId, 'input-exit');
  runner.aliveLoops.delete(automationId);

  const changed = await service.checkLoopLiveness();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].state, 'failed');
  assert.match(changed[0].error ?? '', /exited unexpectedly/);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'failed');
  assert.deepEqual(states.slice(-2), ['running', 'failed']);
  await service.dispose();
});

test('completes a Loop only after its scheduler was armed and all background work is done', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  runner.observations.set(automationId, {
    automationId,
    observedAt: new Date().toISOString(),
    sessionId: 'provider-session-1',
    everScheduled: false,
    sessionCrons: [],
    backgroundTasks: [],
  });

  assert.deepEqual(await service.checkLoopLiveness(), []);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
  assert.deepEqual(runner.loopStops, []);

  runner.observations.set(automationId, {
    automationId,
    observedAt: new Date().toISOString(),
    sessionId: 'provider-session-1',
    everScheduled: true,
    sessionCrons: [],
    backgroundTasks: [{ id: 'background-1' }],
  });
  assert.deepEqual(await service.checkLoopLiveness(), []);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');

  runner.observations.set(automationId, {
    automationId,
    observedAt: new Date().toISOString(),
    sessionId: 'provider-session-1',
    everScheduled: true,
    sessionCrons: [],
    backgroundTasks: [],
  });
  const changed = await service.checkLoopLiveness();
  assert.equal(changed[0]?.state, 'completed');
  assert.deepEqual(runner.loopStops, [automationId]);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'completed');
});

test('an in-flight Loop input prevents liveness from claiming a stale completion observation', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const clearGate = deferred<void>();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  runner.observations.set(automationId, {
    automationId,
    observedAt: new Date().toISOString(),
    sessionId: 'provider-session-1',
    everScheduled: true,
    sessionCrons: [],
    backgroundTasks: [],
  });
  runner.clearLoopObservation = async (id) => {
    runner.clearedObservations.push(id);
    await clearGate.promise;
    runner.observations.delete(id);
  };

  const input = service.sendLoopInput(
    SESSION_ID,
    'continue checking',
    automationId,
    'input-continue',
  );
  const changed = await service.checkLoopLiveness();

  assert.deepEqual(changed, []);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
  assert.deepEqual(runner.loopStops, []);

  clearGate.resolve();
  assert.equal((await input).state, 'running');
  assert.deepEqual(runner.loopInputs, [{ sessionId: automationId, text: 'continue checking' }]);
});

test('a Loop completion claim rejects concurrent input before stopping the runtime', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const stopGate = deferred<void>();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  runner.observations.set(automationId, {
    automationId,
    observedAt: new Date().toISOString(),
    sessionId: 'provider-session-1',
    everScheduled: true,
    sessionCrons: [],
    backgroundTasks: [],
  });
  runner.stopLoop = async (id) => {
    runner.loopStops.push(id);
    await stopGate.promise;
    return runner.aliveLoops.delete(id);
  };

  const liveness = service.checkLoopLiveness();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runner.loopStops, [automationId]);
  await assert.rejects(
    service.sendLoopInput(SESSION_ID, 'too late', automationId, 'input-too-late'),
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_NOT_RUNNING',
  );
  assert.deepEqual(runner.loopInputs, []);

  stopGate.resolve();
  assert.equal((await liveness)[0]?.state, 'completed');
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'completed');
});

test('liveness probe errors leave a running Loop manageable for a later retry', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);

  runner.readLoopObservation = async () => {
    throw new Error('observation permission denied');
  };
  assert.deepEqual(await service.checkLoopLiveness(), []);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
  assert.deepEqual(runner.loopStops, []);

  runner.readLoopObservation = async () => null;
  runner.hasLoop = async () => {
    throw new Error('tmux socket permission denied');
  };
  assert.deepEqual(await service.checkLoopLiveness(), []);
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
  assert.deepEqual(runner.loopStops, []);
});

test('reconciles an armed Loop observation as completed after restart', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const automationId = '8f9248f0-5fe3-4a77-a475-23f496272edd';
  db.seed({
    session_id: SESSION_ID,
    kind: 'loop',
    state: 'running',
    native_task_id: automationId,
  });
  runner.aliveLoops.add(automationId);
  runner.observations.set(automationId, {
    automationId,
    observedAt: new Date().toISOString(),
    sessionId: 'provider-session-1',
    everScheduled: true,
    sessionCrons: [],
    backgroundTasks: [],
  });
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });

  const reconciled = await service.reconcileOnStartup();

  assert.equal(reconciled[0]?.state, 'completed');
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'completed');
  assert.deepEqual(runner.loopStops, [automationId]);
});

test('Dismiss cannot clear the state broadcast for a replacement automation', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const clearGate = deferred<void>();
  const emitted: Array<string | null> = [];
  const service = new ClaudeAutomationService({
    db,
    runner,
    loopLivenessIntervalMs: 0,
    onState: (_sessionId, snapshot) => emitted.push(snapshot?.automationId ?? null),
  });
  await service.startLoop(goalInput({ command: '/loop 5m first' }));
  const oldId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(oldId);
  await service.stop(SESSION_ID, oldId);
  runner.clearLoopObservation = async () => clearGate.promise;

  const dismissing = service.dismiss(SESSION_ID, oldId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getSnapshot(SESSION_ID), null);
  await service.startLoop(goalInput({ command: '/loop 5m replacement' }));
  const replacementId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(replacementId);
  assert.notEqual(replacementId, oldId);

  clearGate.resolve();
  await dismissing;
  assert.equal(service.getSnapshot(SESSION_ID)?.automationId, replacementId);
  assert.equal(emitted.at(-1), replacementId);
});

test('rejects stale automation actions after a replacement starts', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m first' }));
  const oldId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(oldId);
  await service.stop(SESSION_ID, oldId);
  await service.dismiss(SESSION_ID, oldId);
  await service.startLoop(goalInput({ command: '/loop 5m replacement' }));

  assert.throws(
    () => service.stop(SESSION_ID, oldId),
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_STALE_ACTION',
  );
});

test('shutdown interrupts and waits for headless Goals', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner });
  const handle = service.startGoal(goalInput());
  const shutdown = service.shutdown();
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopping');
  runner.exitGoal(handle.automationId, { interrupted: true, code: null, signal: 'SIGINT' });

  await shutdown;
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'stopped');
});

test('shutdown waits for a pending Loop start and preserves the detached runtime', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const startGate = deferred<NativeClaudeLoopHandle>();
  runner.nextLoopStart = startGate;
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  const starting = service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);

  let shutdownSettled = false;
  const shutdown = service.shutdown().then(() => {
    shutdownSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownSettled, false);

  runner.aliveLoops.add(automationId);
  startGate.resolve({ automationId, runtimeId: `tmux-${automationId}` });
  await starting;
  await shutdown;

  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
  assert.equal(runner.aliveLoops.has(automationId), true);
  assert.deepEqual(runner.loopStops, []);
});

test('shutdown drains an in-flight Loop input and rejects later input', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const inputGate = deferred<void>();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  runner.sendLoopInput = async () => inputGate.promise;
  const input = service.sendLoopInput(SESSION_ID, 'status', automationId, 'input-status');

  let shutdownSettled = false;
  const shutdown = service.shutdown().then(() => {
    shutdownSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownSettled, false);
  await assert.rejects(
    service.sendLoopInput(SESSION_ID, 'too late', automationId, 'input-shutdown-too-late'),
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_NOT_RUNNING',
  );

  inputGate.resolve();
  await input;
  await shutdown;
  assert.equal(service.getSnapshot(SESSION_ID)?.state, 'running');
});

test('shutdown still replays an acknowledged Loop input but rejects a new request', async () => {
  const db = new FakeAutomationRepository();
  const runner = new FakeAutomationRunner();
  const service = new ClaudeAutomationService({ db, runner, loopLivenessIntervalMs: 0 });
  await service.startLoop(goalInput({ command: '/loop 5m check tests' }));
  const automationId = service.getSnapshot(SESSION_ID)?.automationId;
  assert.ok(automationId);
  await service.sendLoopInput(SESSION_ID, 'status', automationId, 'input-before-shutdown');
  await service.shutdown();

  const replayed = await service.sendLoopInput(
    SESSION_ID,
    'status',
    automationId,
    'input-before-shutdown',
  );
  assert.equal(replayed.automationId, automationId);
  assert.equal(runner.loopInputs.length, 1);
  await assert.rejects(
    service.sendLoopInput(SESSION_ID, 'new status', automationId, 'input-after-shutdown'),
    (error: unknown) => error instanceof ClaudeAutomationServiceError
      && error.code === 'AUTOMATION_NOT_RUNNING',
  );
});
