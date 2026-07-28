import { createHash, randomUUID } from 'node:crypto';

import {
  claudeAutomationsDb,
  sessionsDb,
  type ClaudeAutomationInputRow,
  type ClaudeAutomationRow,
  type StartClaudeAutomationInput as StartClaudeAutomationRowInput,
  type UpdateClaudeAutomationInput,
} from '@/modules/database/index.js';
import type {
  ClaudeAutomationSnapshot,
  ClaudeAutomationState,
} from '@/shared/types.js';

import {
  NativeClaudeAutomationRunner,
  validateClaudeLoopInput,
  type NativeClaudeAutomationStartOptions,
  type NativeClaudeGoalClearOptions,
  type NativeClaudeGoalClearResult,
  type NativeClaudeGoalExit,
  type NativeClaudeGoalHandle,
  type NativeClaudeLoopHandle,
  type NativeClaudeLoopObservation,
} from './native-claude-automation.runner.js';

const ACTIVE_STATES = new Set<ClaudeAutomationState>(['starting', 'running', 'stopping']);
const TERMINAL_STATES = new Set<ClaudeAutomationState>(['completed', 'stopped', 'failed']);
const DEFAULT_LOOP_LIVENESS_INTERVAL_MS = 15_000;
export const MAX_AUTOMATION_CORRELATION_ID_LENGTH = 128;

export type ClaudeAutomationServiceErrorCode =
  | 'AUTOMATION_ALREADY_ACTIVE'
  | 'AUTOMATION_NOT_FOUND'
  | 'AUTOMATION_NOT_RUNNING'
  | 'AUTOMATION_NOT_DISMISSIBLE'
  | 'AUTOMATION_STALE_ACTION'
  | 'AUTOMATION_WRONG_KIND'
  | 'AUTOMATION_START_FAILED'
  | 'AUTOMATION_INPUT_FAILED'
  | 'AUTOMATION_INPUT_CONFLICT'
  | 'AUTOMATION_INPUT_UNCERTAIN'
  | 'AUTOMATION_STOP_FAILED';

export class ClaudeAutomationServiceError extends Error {
  constructor(
    message: string,
    readonly code: ClaudeAutomationServiceErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ClaudeAutomationServiceError';
  }
}

class GoalRuntimeCleanupUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalRuntimeCleanupUnconfirmedError';
  }
}

function isConfirmedGoalCleanup(status: string): boolean {
  return status === 'terminated' || status === 'not_found';
}

export type ClaudeAutomationRepository = {
  getBySessionId(sessionId: string): ClaudeAutomationRow | null;
  start(input: StartClaudeAutomationRowInput): ClaudeAutomationRow;
  update(sessionId: string, patch: UpdateClaudeAutomationInput): ClaudeAutomationRow | null;
  dismiss(sessionId: string): boolean;
  listActive(): ClaudeAutomationRow[];
  getInput(automationId: string, requestId: string): ClaudeAutomationInputRow | null;
  reserveInput(input: {
    sessionId: string;
    automationId: string;
    requestId: string;
    contentHash: string;
  }): { row: ClaudeAutomationInputRow; inserted: boolean };
  updateInput(
    automationId: string,
    requestId: string,
    state: ClaudeAutomationInputRow['state'],
    error: string | null,
  ): ClaudeAutomationInputRow | null;
};

export type ClaudeAutomationRunner = Pick<
  NativeClaudeAutomationRunner,
  | 'startGoal'
  | 'interruptGoal'
  | 'clearGoal'
  | 'hasGoal'
  | 'cleanupGoalRuntime'
  | 'startLoop'
  | 'hasLoop'
  | 'sendLoopInput'
  | 'stopLoop'
  | 'readLoopObservation'
  | 'clearLoopObservation'
  | 'cleanupStaleLoopEnvironmentFiles'
>;

export type ClaudeAutomationStartInput = {
  sessionId: string;
  providerSessionId?: string | null;
  cwd: string;
  command: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  allowedTools?: readonly string[] | null;
  disallowedTools?: readonly string[] | null;
  env?: NodeJS.ProcessEnv;
};

export type ClaudeAutomationGoalCallbacks = {
  onEvent?: (value: unknown, raw: string) => void;
  onMalformed?: (raw: string, error: Error) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (result: NativeClaudeGoalExit) => void;
};

export type ClaudeAutomationStateListener = (
  sessionId: string,
  snapshot: ClaudeAutomationServiceSnapshot | null,
) => void;

export type ClaudeAutomationServiceSnapshot = ClaudeAutomationSnapshot & {
  automationId: string;
};

export type ClaudeAutomationServiceDependencies = {
  db?: ClaudeAutomationRepository;
  runner?: ClaudeAutomationRunner;
  onState?: ClaudeAutomationStateListener;
  /** Set to zero to disable automatic tmux liveness checks. */
  loopLivenessIntervalMs?: number;
  resolveGoalClearOptions?: (
    sessionId: string,
  ) => NativeClaudeGoalClearOptions | null | Promise<NativeClaudeGoalClearOptions | null>;
};

export type ClaudeGoalClearSession = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
};

export function resolveGoalClearOptionsForSession(
  session: ClaudeGoalClearSession | null,
): NativeClaudeGoalClearOptions | null {
  const cwd = session?.project_path?.trim();
  if (!session || session.provider !== 'claude' || !cwd) return null;
  return {
    cwd,
    providerSessionId: session.provider_session_id?.trim() || session.session_id,
  };
}

type ActiveGoalExecution = {
  automationId: string;
  input: ClaudeAutomationStartInput;
  nativeHandle: NativeClaudeGoalHandle;
  terminal: Promise<void>;
  resolveTerminal: () => void;
  terminalResolved: boolean;
  clearPromise?: Promise<NativeClaudeGoalClearResult>;
};

type GenerationOperation<T> = {
  automationId: string;
  promise: Promise<T>;
};

type LoopInputRequestOperation = {
  sessionId: string;
  automationId: string;
  requestId: string;
  contentHash: string;
  promise: Promise<ClaudeAutomationServiceSnapshot>;
};

export function toClaudeAutomationSnapshot(row: ClaudeAutomationRow): ClaudeAutomationServiceSnapshot {
  return {
    automationId: row.native_task_id ?? row.session_id,
    kind: row.kind,
    state: row.state,
    command: row.command,
    runtime: row.runtime,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function describeGoalExit(result: NativeClaudeGoalExit): string {
  if (result.error) return result.error.message;
  if (result.result?.message) return result.result.message;
  if (result.result?.subtype && result.result.subtype !== 'success') {
    return `Claude Goal returned ${result.result.subtype}.`;
  }
  if (!result.result) return 'Claude Goal exited without a final result event.';
  if (result.signal) return `Claude Goal exited after signal ${result.signal}.`;
  return `Claude Goal exited with code ${String(result.code)}.`;
}

function describeClearFailure(result: NativeClaudeGoalClearResult): string {
  if (result.error) return result.error.message;
  if (result.result?.message) return result.result.message;
  if (result.result?.subtype && result.result.subtype !== 'success') {
    return `/goal clear returned ${result.result.subtype}.`;
  }
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  if (result.signal) return `/goal clear exited after signal ${result.signal}.`;
  return `/goal clear exited with code ${String(result.code)}.`;
}

function isSuccessfulGoalExit(result: NativeClaudeGoalExit): boolean {
  return !result.error
    && result.code === 0
    && result.result?.subtype === 'success'
    && !result.result.isError;
}

export class ClaudeAutomationService {
  private readonly db: ClaudeAutomationRepository;
  private readonly runner: ClaudeAutomationRunner;
  private readonly onState?: ClaudeAutomationStateListener;
  private readonly resolveGoalClearOptions: NonNullable<
    ClaudeAutomationServiceDependencies['resolveGoalClearOptions']
  >;
  private readonly activeGoals = new Map<string, ActiveGoalExecution>();
  private readonly loopStarts = new Map<
    string,
    GenerationOperation<NativeClaudeLoopHandle>
  >();
  private readonly loopInputQueues = new Map<string, GenerationOperation<void>>();
  private readonly loopInputRequests = new Map<string, LoopInputRequestOperation>();
  private readonly stops = new Map<
    string,
    GenerationOperation<ClaudeAutomationServiceSnapshot>
  >();
  private readonly loopRuntimeStops = new Map<string, Promise<boolean>>();
  /** Prevents new input after liveness has claimed a naturally completed Loop. */
  private readonly loopCompletionClaims = new Map<string, string>();
  private loopLivenessCheck: Promise<ClaudeAutomationServiceSnapshot[]> | null = null;
  private loopLivenessTimer: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(dependencies: ClaudeAutomationServiceDependencies = {}) {
    this.db = dependencies.db ?? claudeAutomationsDb;
    this.runner = dependencies.runner ?? new NativeClaudeAutomationRunner();
    this.onState = dependencies.onState;
    this.resolveGoalClearOptions = dependencies.resolveGoalClearOptions ?? ((sessionId) => (
      resolveGoalClearOptionsForSession(sessionsDb.getSessionById(sessionId))
    ));
    const intervalMs = dependencies.loopLivenessIntervalMs
      ?? DEFAULT_LOOP_LIVENESS_INTERVAL_MS;
    if (intervalMs > 0) {
      this.loopLivenessTimer = setInterval(() => {
        void this.checkLoopLiveness().catch(() => undefined);
      }, intervalMs);
      this.loopLivenessTimer.unref();
    }
  }

  getSnapshot(sessionId: string): ClaudeAutomationServiceSnapshot | null {
    const row = this.db.getBySessionId(sessionId);
    return row ? toClaudeAutomationSnapshot(row) : null;
  }

  getActiveRow(sessionId: string): ClaudeAutomationRow | null {
    const row = this.db.getBySessionId(sessionId);
    return row && ACTIVE_STATES.has(row.state) ? row : null;
  }

  /** Starts the process synchronously and returns its non-blocking completion handle. */
  startGoal(
    input: ClaudeAutomationStartInput,
    callbacks: ClaudeAutomationGoalCallbacks = {},
  ): NativeClaudeGoalHandle {
    this.assertCanStart(input.sessionId);
    const automationId = randomUUID();
    this.emit(this.db.start({
      sessionId: input.sessionId,
      kind: 'goal',
      runtime: 'headless',
      command: input.command,
      nativeTaskId: automationId,
    }));

    let nativeHandle: NativeClaudeGoalHandle;
    try {
      nativeHandle = this.runner.startGoal(this.toNativeOptions(input, automationId), {
        onEvent: callbacks.onEvent
          ? (value, raw) => this.invokeCallback(() => callbacks.onEvent?.(value, raw))
          : undefined,
        onMalformedOutput: callbacks.onMalformed
          ? (raw, error) => this.invokeCallback(() => callbacks.onMalformed?.(raw, error))
          : undefined,
        onStderr: callbacks.onStderr
          ? (chunk) => this.invokeCallback(() => callbacks.onStderr?.(chunk))
          : undefined,
      });
    } catch (error) {
      this.fail(input.sessionId, toError(error).message, automationId);
      throw new ClaudeAutomationServiceError(
        `Could not start Claude Goal: ${toError(error).message}`,
        'AUTOMATION_START_FAILED',
        { cause: error },
      );
    }

    let resolveTerminal: () => void = () => undefined;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const execution: ActiveGoalExecution = {
      automationId,
      input,
      nativeHandle,
      terminal,
      resolveTerminal,
      terminalResolved: false,
    };
    this.activeGoals.set(input.sessionId, execution);
    const current = this.db.getBySessionId(input.sessionId);
    if (!current || current.native_task_id !== automationId) {
      nativeHandle.interrupt();
      this.activeGoals.delete(input.sessionId);
      throw new ClaudeAutomationServiceError(
        `Automation state for session ${input.sessionId} changed while Goal was starting.`,
        'AUTOMATION_START_FAILED',
      );
    }
    const running = this.db.update(input.sessionId, {
      state: 'running',
      runtimeId: nativeHandle.runtimeId,
      error: null,
    });
    if (!running) {
      nativeHandle.interrupt();
      this.activeGoals.delete(input.sessionId);
      throw new ClaudeAutomationServiceError(
        `Automation state for session ${input.sessionId} disappeared while Goal was starting.`,
        'AUTOMATION_START_FAILED',
      );
    }
    this.emit(running);

    const completion = nativeHandle.completion.then(
      async (result) => {
        await this.finishGoal(input.sessionId, execution, result);
        await execution.terminal;
        if (callbacks.onExit) this.invokeCallback(() => callbacks.onExit?.(result));
        return result;
      },
      async (error: unknown) => {
        this.finishRejectedGoal(input.sessionId, execution, error);
        await execution.terminal;
        throw error;
      },
    );
    void completion.catch(() => undefined);
    return { ...nativeHandle, automationId, completion };
  }

  async startLoop(input: ClaudeAutomationStartInput): Promise<NativeClaudeLoopHandle> {
    this.assertCanStart(input.sessionId);
    const automationId = randomUUID();
    this.emit(this.db.start({
      sessionId: input.sessionId,
      kind: 'loop',
      runtime: 'tmux',
      command: input.command,
      nativeTaskId: automationId,
    }));

    let start: Promise<NativeClaudeLoopHandle>;
    try {
      start = this.runner.startLoop(this.toNativeOptions(input, automationId));
    } catch (error) {
      this.fail(input.sessionId, toError(error).message, automationId);
      throw new ClaudeAutomationServiceError(
        `Could not start Claude Loop: ${toError(error).message}`,
        'AUTOMATION_START_FAILED',
        { cause: error },
      );
    }
    const startOperation = { automationId, promise: start };
    this.loopStarts.set(input.sessionId, startOperation);
    try {
      const handle = await start;
      const current = this.db.getBySessionId(input.sessionId);
      if (!current || current.native_task_id !== automationId) {
        await this.runner.stopLoop(automationId);
        throw new ClaudeAutomationServiceError(
          `Automation state for session ${input.sessionId} changed while Loop was starting.`,
          'AUTOMATION_START_FAILED',
        );
      }

      // A concurrent Stop owns the remaining transition once startup has completed.
      if (current.state === 'stopping') return handle;
      if (TERMINAL_STATES.has(current.state)) {
        await this.runner.stopLoop(automationId);
        return handle;
      }

      const running = this.db.update(input.sessionId, {
        state: 'running',
        runtimeId: handle.runtimeId,
        error: null,
      });
      if (!running) {
        await this.runner.stopLoop(automationId);
        throw new ClaudeAutomationServiceError(
          `Automation state for session ${input.sessionId} disappeared while Loop was starting.`,
          'AUTOMATION_START_FAILED',
        );
      }
      this.emit(running);
      return handle;
    } catch (error) {
      const current = this.db.getBySessionId(input.sessionId);
      if (current?.native_task_id === automationId && !TERMINAL_STATES.has(current.state)) {
        this.fail(input.sessionId, toError(error).message, automationId);
      }
      if (error instanceof ClaudeAutomationServiceError) throw error;
      throw new ClaudeAutomationServiceError(
        `Could not start Claude Loop: ${toError(error).message}`,
        'AUTOMATION_START_FAILED',
        { cause: error },
      );
    } finally {
      if (this.loopStarts.get(input.sessionId) === startOperation) {
        this.loopStarts.delete(input.sessionId);
      }
    }
  }

  async sendLoopInput(
    sessionId: string,
    text: string,
    expectedAutomationId: string,
    requestId: string,
  ): Promise<ClaudeAutomationServiceSnapshot> {
    if (!requestId.trim() || requestId.trim().length > MAX_AUTOMATION_CORRELATION_ID_LENGTH) {
      throw new ClaudeAutomationServiceError(
        `Claude Loop input requires a request id of at most ${MAX_AUTOMATION_CORRELATION_ID_LENGTH} characters.`,
        'AUTOMATION_INPUT_FAILED',
      );
    }
    if (
      !expectedAutomationId.trim()
      || expectedAutomationId.trim().length > MAX_AUTOMATION_CORRELATION_ID_LENGTH
    ) {
      throw new ClaudeAutomationServiceError(
        `Claude Loop input requires the current automation id of at most ${MAX_AUTOMATION_CORRELATION_ID_LENGTH} characters.`,
        'AUTOMATION_INPUT_FAILED',
      );
    }
    try {
      validateClaudeLoopInput(text);
    } catch (error) {
      throw new ClaudeAutomationServiceError(
        toError(error).message,
        'AUTOMATION_INPUT_FAILED',
        { cause: error },
      );
    }

    const automationId = expectedAutomationId.trim();
    const normalizedRequestId = requestId.trim();
    const contentHash = createHash('sha256').update(text).digest('hex');
    const requestKey = this.getLoopInputRequestKey(automationId, normalizedRequestId);
    const inFlight = this.loopInputRequests.get(requestKey);
    if (inFlight) {
      if (inFlight.sessionId !== sessionId || inFlight.contentHash !== contentHash) {
        throw this.createLoopInputConflict(sessionId, normalizedRequestId);
      }
      return inFlight.promise;
    }

    const stored = this.db.getInput(automationId, normalizedRequestId);
    if (stored) {
      return this.replayLoopInputReceipt(
        sessionId,
        automationId,
        normalizedRequestId,
        contentHash,
        stored,
      );
    }

    if (this.shuttingDown) {
      throw new ClaudeAutomationServiceError(
        'CloudCLI is shutting down and cannot accept new Loop input.',
        'AUTOMATION_NOT_RUNNING',
      );
    }

    const row = this.requireRow(sessionId);
    this.assertExpectedAutomation(row, automationId);
    if (row.kind !== 'loop') {
      throw new ClaudeAutomationServiceError(
        `Automation for session ${sessionId} is not a Loop.`,
        'AUTOMATION_WRONG_KIND',
      );
    }
    if (row.state !== 'running') {
      throw new ClaudeAutomationServiceError(
        `Loop automation for session ${sessionId} is not running.`,
        'AUTOMATION_NOT_RUNNING',
      );
    }
    if (this.loopCompletionClaims.get(sessionId) === automationId) {
      throw new ClaudeAutomationServiceError(
        `Loop automation for session ${sessionId} is completing and cannot accept input.`,
        'AUTOMATION_NOT_RUNNING',
      );
    }

    const reservation = this.db.reserveInput({
      sessionId,
      automationId,
      requestId: normalizedRequestId,
      contentHash,
    });
    if (!reservation.inserted) {
      return this.replayLoopInputReceipt(
        sessionId,
        automationId,
        normalizedRequestId,
        contentHash,
        reservation.row,
      );
    }

    const previous = this.loopInputQueues.get(sessionId)?.promise ?? Promise.resolve();
    const operation = previous.then(async () => {
      try {
        const snapshot = await this.sendLoopInputNow(sessionId, text, automationId);
        const acknowledged = this.db.updateInput(
          automationId,
          normalizedRequestId,
          'acknowledged',
          null,
        );
        if (!acknowledged) {
          throw new Error('Loop input receipt disappeared before it could be acknowledged.');
        }
        return snapshot;
      } catch (error) {
        const deliveryError = toError(error);
        this.db.updateInput(
          automationId,
          normalizedRequestId,
          'uncertain',
          deliveryError.message,
        );
        throw new ClaudeAutomationServiceError(
          `${deliveryError.message} Check the transcript before sending the message again.`,
          'AUTOMATION_INPUT_UNCERTAIN',
          { cause: error },
        );
      }
    });
    const queueTail = operation.then(() => undefined, () => undefined);
    const queueOperation = { automationId, promise: queueTail };
    const requestOperation: LoopInputRequestOperation = {
      sessionId,
      automationId,
      requestId: normalizedRequestId,
      contentHash,
      promise: operation,
    };
    this.loopInputQueues.set(sessionId, queueOperation);
    this.loopInputRequests.set(requestKey, requestOperation);
    try {
      return await operation;
    } finally {
      if (this.loopInputQueues.get(sessionId) === queueOperation) {
        this.loopInputQueues.delete(sessionId);
      }
      if (this.loopInputRequests.get(requestKey) === requestOperation) {
        this.loopInputRequests.delete(requestKey);
      }
    }
  }

  stop(
    sessionId: string,
    expectedAutomationId?: string,
  ): Promise<ClaudeAutomationServiceSnapshot> {
    const row = this.requireRow(sessionId);
    const automationId = this.assertExpectedAutomation(row, expectedAutomationId);
    const existingStop = this.stops.get(sessionId);
    if (existingStop?.automationId === automationId) return existingStop.promise;

    if (!ACTIVE_STATES.has(row.state)) {
      throw new ClaudeAutomationServiceError(
        `Automation for session ${sessionId} is not active.`,
        'AUTOMATION_NOT_RUNNING',
      );
    }
    const stopping = row.state === 'stopping'
      ? row
      : this.db.update(sessionId, { state: 'stopping', error: null });
    if (!stopping) {
      throw new ClaudeAutomationServiceError(
        `Automation for session ${sessionId} no longer exists.`,
        'AUTOMATION_NOT_FOUND',
      );
    }
    this.emit(stopping);

    const operation = this.stopInternal(stopping, automationId).finally(() => {
      if (this.stops.get(sessionId) === stopOperation) this.stops.delete(sessionId);
    });
    const stopOperation = { automationId, promise: operation };
    this.stops.set(sessionId, stopOperation);
    return operation;
  }

  async dismiss(sessionId: string, expectedAutomationId?: string): Promise<boolean> {
    const row = this.requireRow(sessionId);
    const automationId = this.assertExpectedAutomation(row, expectedAutomationId);
    if (!TERMINAL_STATES.has(row.state)) {
      throw new ClaudeAutomationServiceError(
        `Automation for session ${sessionId} must finish before it can be dismissed.`,
        'AUTOMATION_NOT_DISMISSIBLE',
      );
    }
    const dismissed = this.db.dismiss(sessionId);
    if (dismissed) {
      this.notify(sessionId, null);
      await this.runner.clearLoopObservation(automationId).catch(() => undefined);
    }
    return dismissed;
  }

  async reconcileOnStartup(): Promise<ClaudeAutomationServiceSnapshot[]> {
    const reconciled: ClaudeAutomationServiceSnapshot[] = [];
    try {
      await this.runner.cleanupStaleLoopEnvironmentFiles();
    } catch (error) {
      console.warn('[Automation] Could not remove stale Loop environment files', {
        error: toError(error).message,
      });
    }
    for (const row of this.db.listActive()) {
      const automationId = this.getAutomationId(row);
      if (row.kind === 'goal') {
        try {
          await this.reclaimPersistedGoal(row.session_id, automationId, row.runtime_id);
        } catch (error) {
          // An inspection failure means we cannot prove the old process tree
          // was reclaimed. Keep the row active so a new Goal cannot overlap it.
          console.warn('[Automation] Could not reclaim Goal runtime after restart', {
            sessionId: row.session_id,
            automationId,
            runtimeId: row.runtime_id,
            error: toError(error).message,
          });
          this.updateAndEmit(row.session_id, {
            state: 'stopping',
            error: toError(error).message,
          }, automationId);
          continue;
        }
        const failed = this.fail(
          row.session_id,
          'Claude Goal was interrupted because the CloudCLI server restarted.',
          automationId,
        );
        if (failed) reconciled.push(toClaudeAutomationSnapshot(failed));
        continue;
      }

      try {
        if (row.state === 'stopping') {
          await this.stopLoopRuntime(automationId);
          const stopped = this.completeStop(row.session_id, automationId);
          reconciled.push(stopped);
          continue;
        }

        const observation = await this.runner.readLoopObservation(automationId);
        if (this.isLoopComplete(observation)) {
          await this.stopLoopRuntime(automationId);
          const completed = this.completeLoop(row.session_id, automationId);
          if (completed) reconciled.push(toClaudeAutomationSnapshot(completed));
          continue;
        }

        if (await this.runner.hasLoop(automationId)) {
          if (!this.isCurrentAutomation(row.session_id, automationId)) continue;
          const running = this.db.update(row.session_id, { state: 'running', error: null });
          if (running) {
            this.emit(running);
            reconciled.push(toClaudeAutomationSnapshot(running));
          }
        } else {
          const failed = this.fail(
            row.session_id,
            'Claude Loop tmux session was not found after the CloudCLI server restarted.',
            automationId,
          );
          if (failed) reconciled.push(toClaudeAutomationSnapshot(failed));
        }
      } catch (error) {
        // A permission/I/O failure does not prove that the detached runtime
        // died. Preserve the active state so the user can still stop it and
        // let the periodic liveness check retry the inspection.
        console.warn('[Automation] Could not reconcile Loop runtime', {
          sessionId: row.session_id,
          automationId,
          state: row.state,
          error: toError(error).message,
        });
      }
    }
    return reconciled;
  }

  checkLoopLiveness(): Promise<ClaudeAutomationServiceSnapshot[]> {
    if (this.loopLivenessCheck) return this.loopLivenessCheck;
    const check = this.checkLoopLivenessNow().finally(() => {
      if (this.loopLivenessCheck === check) this.loopLivenessCheck = null;
    });
    this.loopLivenessCheck = check;
    return check;
  }

  /** Stops headless Goals while intentionally leaving detached tmux Loops running. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    if (this.loopLivenessTimer) {
      clearInterval(this.loopLivenessTimer);
      this.loopLivenessTimer = null;
    }
    this.shutdownPromise = (async () => {
      await Promise.allSettled(
        [...this.activeGoals.entries()].map(([sessionId, execution]) => (
          this.stop(sessionId, execution.automationId)
        )),
      );
      await this.drainInFlightLoopOperations();
    })();
    return this.shutdownPromise;
  }

  dispose(): Promise<void> {
    return this.shutdown();
  }

  async stopForSessionDeletion(sessionId: string): Promise<void> {
    const row = this.db.getBySessionId(sessionId);
    if (!row) return;
    const automationId = this.getAutomationId(row);
    if (ACTIVE_STATES.has(row.state)) await this.stop(sessionId, automationId);
    const current = this.db.getBySessionId(sessionId);
    if (current && TERMINAL_STATES.has(current.state)) {
      await this.dismiss(sessionId, this.getAutomationId(current));
    }
  }

  private async stopInternal(
    row: ClaudeAutomationRow,
    automationId: string,
  ): Promise<ClaudeAutomationServiceSnapshot> {
    try {
      if (row.kind === 'goal') {
        await this.stopGoal(row.session_id, automationId);
      } else {
        const pendingStart = this.loopStarts.get(row.session_id);
        if (pendingStart?.automationId === automationId) await pendingStart.promise;
        const pendingInput = this.loopInputQueues.get(row.session_id);
        if (pendingInput?.automationId === automationId) await pendingInput.promise;
        await this.stopLoopRuntime(automationId);
        await this.runner.clearLoopObservation(automationId).catch(() => undefined);
      }
      return this.completeStop(row.session_id, automationId);
    } catch (error) {
      if (error instanceof GoalRuntimeCleanupUnconfirmedError) {
        this.updateAndEmit(row.session_id, {
          state: 'stopping',
          error: error.message,
        }, automationId);
        throw new ClaudeAutomationServiceError(
          `Could not verify that Claude Goal stopped: ${error.message}`,
          'AUTOMATION_STOP_FAILED',
          { cause: error },
        );
      }
      const failed = this.fail(row.session_id, toError(error).message, automationId);
      if (row.kind === 'goal') this.finalizeGoalExecution(row.session_id, automationId);
      throw new ClaudeAutomationServiceError(
        `Could not stop Claude ${row.kind === 'goal' ? 'Goal' : 'Loop'}: ${toError(error).message}`,
        'AUTOMATION_STOP_FAILED',
        { cause: error ?? failed },
      );
    }
  }

  private async stopGoal(sessionId: string, automationId: string): Promise<void> {
    const execution = this.activeGoals.get(sessionId);
    if (!execution || execution.automationId !== automationId) {
      const row = this.requireRow(sessionId);
      await this.reclaimPersistedGoal(sessionId, automationId, row.runtime_id);
      return;
    }

    execution.nativeHandle.interrupt();
    const result = await execution.nativeHandle.completion;
    let clearResult: NativeClaudeGoalClearResult;
    try {
      clearResult = await this.ensureGoalCleared(execution);
    } catch (error) {
      throw new GoalRuntimeCleanupUnconfirmedError(
        `/goal clear failed: ${toError(error).message}`,
      );
    }
    if (!clearResult.success) {
      throw new GoalRuntimeCleanupUnconfirmedError(
        `/goal clear failed: ${describeClearFailure(clearResult)}`,
      );
    }
    if (result.error) throw result.error;
  }

  private async reclaimPersistedGoal(
    sessionId: string,
    automationId: string,
    runtimeId: string | null,
  ): Promise<void> {
    this.assertPersistedGoalGeneration(sessionId, automationId);
    let cleanup;
    try {
      cleanup = await this.runner.cleanupGoalRuntime(automationId, runtimeId);
    } catch (error) {
      throw new GoalRuntimeCleanupUnconfirmedError(
        `Goal runtime inspection failed: ${toError(error).message}`,
      );
    }
    if (!isConfirmedGoalCleanup(cleanup.status)) {
      throw new GoalRuntimeCleanupUnconfirmedError(
        `Goal runtime cleanup is ${cleanup.status}; no new Goal will be allowed until cleanup is confirmed.`,
      );
    }
    this.assertPersistedGoalGeneration(sessionId, automationId);

    let clearOptions: NativeClaudeGoalClearOptions | null;
    try {
      clearOptions = await this.resolveGoalClearOptions(sessionId);
    } catch (error) {
      throw new GoalRuntimeCleanupUnconfirmedError(
        `Goal runtime stopped, but its native session could not be resolved for /goal clear: ${toError(error).message}`,
      );
    }
    if (!clearOptions) {
      throw new GoalRuntimeCleanupUnconfirmedError(
        'Goal runtime stopped, but its native session could not be resolved for /goal clear.',
      );
    }
    this.assertPersistedGoalGeneration(sessionId, automationId);
    let clearResult: NativeClaudeGoalClearResult;
    try {
      clearResult = await this.runner.clearGoal(clearOptions);
    } catch (error) {
      throw new GoalRuntimeCleanupUnconfirmedError(
        `Goal runtime stopped, but /goal clear failed: ${toError(error).message}`,
      );
    }
    if (!clearResult.success) {
      throw new GoalRuntimeCleanupUnconfirmedError(
        `Goal runtime stopped, but /goal clear failed: ${describeClearFailure(clearResult)}`,
      );
    }
    this.assertPersistedGoalGeneration(sessionId, automationId);
  }

  private assertPersistedGoalGeneration(sessionId: string, automationId: string): void {
    const current = this.db.getBySessionId(sessionId);
    if (!current || current.kind !== 'goal' || this.getAutomationId(current) !== automationId) {
      throw new ClaudeAutomationServiceError(
        `Automation ${automationId} is no longer current for session ${sessionId}.`,
        'AUTOMATION_STALE_ACTION',
      );
    }
  }

  private async sendLoopInputNow(
    sessionId: string,
    text: string,
    automationId: string,
  ): Promise<ClaudeAutomationServiceSnapshot> {
    const queuedRow = this.requireRow(sessionId);
    this.assertExpectedAutomation(queuedRow, automationId);
    if (queuedRow.kind !== 'loop') {
      throw new ClaudeAutomationServiceError(
        `Automation for session ${sessionId} is not a Loop.`,
        'AUTOMATION_WRONG_KIND',
      );
    }
    if (queuedRow.state !== 'running') {
      throw new ClaudeAutomationServiceError(
        `Loop automation for session ${sessionId} is not running.`,
        'AUTOMATION_NOT_RUNNING',
      );
    }

    try {
      // A Stop hook snapshot describes the turn that just ended. Remove it
      // before injecting another turn so the next liveness poll cannot mistake
      // stale "no cron/tasks" state for completion of the new input.
      await this.runner.clearLoopObservation(automationId);
      await this.runner.sendLoopInput(automationId, text);
    } catch (error) {
      const current = this.db.getBySessionId(sessionId);
      let loopAlive: boolean | null = null;
      try {
        loopAlive = await this.runner.hasLoop(automationId);
      } catch {
        // A later liveness check will settle an unknown runtime state.
      }
      if (loopAlive === false && current && current.state === 'running'
        && this.getAutomationId(current) === automationId) {
        this.fail(sessionId, toError(error).message, automationId);
      }
      throw new ClaudeAutomationServiceError(
        `Could not send input to Claude Loop: ${toError(error).message}`,
        'AUTOMATION_INPUT_FAILED',
        { cause: error },
      );
    }

    const current = this.requireRow(sessionId);
    this.assertExpectedAutomation(current, automationId);
    if (current.state !== 'running') return toClaudeAutomationSnapshot(current);
    const acknowledged = this.db.update(sessionId, { state: 'running' });
    if (!acknowledged) {
      throw new ClaudeAutomationServiceError(
        `Automation for session ${sessionId} no longer exists.`,
        'AUTOMATION_NOT_FOUND',
      );
    }
    this.emit(acknowledged);
    return toClaudeAutomationSnapshot(acknowledged);
  }

  private async checkLoopLivenessNow(): Promise<ClaudeAutomationServiceSnapshot[]> {
    const changed: ClaudeAutomationServiceSnapshot[] = [];
    const loops = this.db.listActive().filter((row) => (
      row.kind === 'loop' && row.state === 'running'
    ));
    for (const row of loops) {
      const automationId = this.getAutomationId(row);
      let observation: NativeClaudeLoopObservation | null = null;
      try {
        observation = await this.runner.readLoopObservation(automationId);
        if (this.isLoopComplete(observation)) {
          const current = this.db.getBySessionId(row.session_id);
          if (!current || current.kind !== 'loop' || current.state !== 'running'
            || this.getAutomationId(current) !== automationId) {
            continue;
          }
          // An input operation registers itself synchronously before awaiting
          // tmux. Let that turn invalidate the old observation and defer the
          // completion decision to a later poll.
          if (this.loopInputQueues.get(row.session_id)?.automationId === automationId) {
            continue;
          }
          if (this.loopCompletionClaims.has(row.session_id)) continue;
          this.loopCompletionClaims.set(row.session_id, automationId);
          try {
            await this.stopLoopRuntime(automationId);
            const completed = this.completeLoop(row.session_id, automationId);
            if (completed) changed.push(toClaudeAutomationSnapshot(completed));
          } finally {
            if (this.loopCompletionClaims.get(row.session_id) === automationId) {
              this.loopCompletionClaims.delete(row.session_id);
            }
          }
          continue;
        }
      } catch (error) {
        // A permission/I/O failure does not prove the detached runtime died.
        // Leave it manageable and retry on the next liveness interval.
        console.warn('[Automation] Could not inspect Loop completion state', {
          sessionId: row.session_id,
          automationId,
          error: toError(error).message,
        });
        continue;
      }

      let alive: boolean;
      try {
        alive = await this.runner.hasLoop(automationId);
      } catch (error) {
        console.warn('[Automation] Could not inspect Loop tmux liveness', {
          sessionId: row.session_id,
          automationId,
          error: toError(error).message,
        });
        continue;
      }
      if (alive) continue;

      const current = this.db.getBySessionId(row.session_id);
      if (!current || current.kind !== 'loop' || current.state !== 'running'
        || this.getAutomationId(current) !== automationId) continue;
      const failed = this.fail(
        row.session_id,
        'Claude Loop tmux session exited unexpectedly.',
        automationId,
      );
      if (failed) changed.push(toClaudeAutomationSnapshot(failed));
    }
    return changed;
  }

  private async finishGoal(
    sessionId: string,
    execution: ActiveGoalExecution,
    result: NativeClaudeGoalExit,
  ): Promise<void> {
    if (this.activeGoals.get(sessionId) !== execution) {
      this.resolveGoalTerminal(execution);
      return;
    }

    let clearResult: NativeClaudeGoalClearResult | null = null;
    try {
      clearResult = await this.ensureGoalCleared(execution);
    } catch (error) {
      this.updateAndEmit(sessionId, {
        state: 'stopping',
        error: `/goal clear failed: ${toError(error).message}`,
      }, execution.automationId);
      return;
    }

    const current = this.db.getBySessionId(sessionId);
    if (!current || this.getAutomationId(current) !== execution.automationId) {
      this.finalizeGoalExecution(sessionId, execution.automationId);
      return;
    }
    if (current.state === 'stopping') {
      return;
    }
    if (current.kind !== 'goal' || TERMINAL_STATES.has(current.state)) {
      this.finalizeGoalExecution(sessionId, execution.automationId);
      return;
    }
    if (clearResult && !clearResult.success) {
      this.updateAndEmit(sessionId, {
        state: 'stopping',
        error: `/goal clear failed: ${describeClearFailure(clearResult)}`,
      }, execution.automationId);
      return;
    } else if (result.interrupted) {
      this.updateAndEmit(sessionId, { state: 'stopped', error: null }, execution.automationId);
    } else if (isSuccessfulGoalExit(result)) {
      this.updateAndEmit(sessionId, { state: 'completed', error: null }, execution.automationId);
    } else {
      this.fail(sessionId, describeGoalExit(result), execution.automationId);
    }
    this.finalizeGoalExecution(sessionId, execution.automationId);
  }

  private finishRejectedGoal(
    sessionId: string,
    execution: ActiveGoalExecution,
    error: unknown,
  ): void {
    if (this.activeGoals.get(sessionId) !== execution) {
      this.resolveGoalTerminal(execution);
      return;
    }
    const current = this.db.getBySessionId(sessionId);
    if (current && this.getAutomationId(current) === execution.automationId
      && current.state !== 'stopping' && !TERMINAL_STATES.has(current.state)) {
      this.fail(sessionId, toError(error).message, execution.automationId);
    }
    this.finalizeGoalExecution(sessionId, execution.automationId);
  }

  private completeStop(
    sessionId: string,
    automationId: string,
  ): ClaudeAutomationServiceSnapshot {
    if (!this.isCurrentAutomation(sessionId, automationId)) {
      throw new ClaudeAutomationServiceError(
        `Automation ${automationId} is no longer current for session ${sessionId}.`,
        'AUTOMATION_STALE_ACTION',
      );
    }
    const stopped = this.db.update(sessionId, { state: 'stopped', error: null });
    if (!stopped) {
      throw new ClaudeAutomationServiceError(
        `Automation for session ${sessionId} no longer exists.`,
        'AUTOMATION_NOT_FOUND',
      );
    }
    this.emit(stopped);
    this.finalizeGoalExecution(sessionId, automationId);
    return toClaudeAutomationSnapshot(stopped);
  }

  private fail(
    sessionId: string,
    error: string,
    automationId?: string,
  ): ClaudeAutomationRow | null {
    if (automationId && !this.isCurrentAutomation(sessionId, automationId)) return null;
    const failed = this.db.update(sessionId, { state: 'failed', error });
    if (failed) this.emit(failed);
    return failed;
  }

  private updateAndEmit(
    sessionId: string,
    patch: UpdateClaudeAutomationInput,
    automationId?: string,
  ): ClaudeAutomationRow | null {
    if (automationId && !this.isCurrentAutomation(sessionId, automationId)) return null;
    const row = this.db.update(sessionId, patch);
    if (row) this.emit(row);
    return row;
  }

  private emit(row: ClaudeAutomationRow): void {
    this.notify(row.session_id, toClaudeAutomationSnapshot(row));
  }

  private notify(sessionId: string, snapshot: ClaudeAutomationSnapshot | null): void {
    try {
      this.onState?.(sessionId, snapshot);
    } catch {
      // Transport listeners must not be able to corrupt persisted automation state.
    }
  }

  private invokeCallback(callback: () => void): void {
    try {
      callback();
    } catch {
      // Provider event consumers cannot be allowed to prevent process finalization.
    }
  }

  private ensureGoalCleared(
    execution: ActiveGoalExecution,
  ): Promise<NativeClaudeGoalClearResult> {
    execution.clearPromise ??= this.runner.clearGoal(
      this.toNativeClearOptions(execution.input),
    ).then(
      (result) => {
        if (!result.success) execution.clearPromise = undefined;
        return result;
      },
      (error: unknown) => {
        execution.clearPromise = undefined;
        throw error;
      },
    );
    return execution.clearPromise;
  }

  private finalizeGoalExecution(sessionId: string, automationId: string): void {
    const execution = this.activeGoals.get(sessionId);
    if (!execution || execution.automationId !== automationId) return;
    this.activeGoals.delete(sessionId);
    this.resolveGoalTerminal(execution);
  }

  private resolveGoalTerminal(execution: ActiveGoalExecution): void {
    if (execution.terminalResolved) return;
    execution.terminalResolved = true;
    execution.resolveTerminal();
  }

  private completeLoop(sessionId: string, automationId: string): ClaudeAutomationRow | null {
    const current = this.db.getBySessionId(sessionId);
    if (!current || current.kind !== 'loop' || current.state !== 'running'
      || this.getAutomationId(current) !== automationId) return null;
    const completed = this.db.update(sessionId, { state: 'completed', error: null });
    if (completed) this.emit(completed);
    void this.runner.clearLoopObservation(automationId).catch(() => undefined);
    return completed;
  }

  private isLoopComplete(observation: NativeClaudeLoopObservation | null): boolean {
    return Boolean(
      observation
      && observation.everScheduled
      && observation.sessionCrons.length === 0
      && observation.backgroundTasks.length === 0,
    );
  }

  private stopLoopRuntime(automationId: string): Promise<boolean> {
    const existing = this.loopRuntimeStops.get(automationId);
    if (existing) return existing;
    const operation = this.runner.stopLoop(automationId).finally(() => {
      if (this.loopRuntimeStops.get(automationId) === operation) {
        this.loopRuntimeStops.delete(automationId);
      }
    });
    this.loopRuntimeStops.set(automationId, operation);
    return operation;
  }

  private async drainInFlightLoopOperations(): Promise<void> {
    while (true) {
      const operations = new Set<Promise<unknown>>();
      for (const operation of this.loopStarts.values()) operations.add(operation.promise);
      for (const operation of this.loopInputQueues.values()) operations.add(operation.promise);
      for (const operation of this.stops.values()) operations.add(operation.promise);
      for (const operation of this.loopRuntimeStops.values()) operations.add(operation);
      if (this.loopLivenessCheck) operations.add(this.loopLivenessCheck);
      if (operations.size === 0) return;
      await Promise.allSettled(operations);
      // Let service-level continuations update DB state and remove their map
      // entries before checking whether they spawned another operation.
      await Promise.resolve();
    }
  }

  private getAutomationId(row: ClaudeAutomationRow): string {
    return row.native_task_id ?? row.session_id;
  }

  private getLoopInputRequestKey(automationId: string, requestId: string): string {
    return `${automationId}\u0000${requestId}`;
  }

  private createLoopInputConflict(
    sessionId: string,
    requestId: string,
  ): ClaudeAutomationServiceError {
    return new ClaudeAutomationServiceError(
      `Loop input request ${requestId} was already used with different content or session ${sessionId}.`,
      'AUTOMATION_INPUT_CONFLICT',
    );
  }

  private replayLoopInputReceipt(
    sessionId: string,
    automationId: string,
    requestId: string,
    contentHash: string,
    receipt: ClaudeAutomationInputRow,
  ): ClaudeAutomationServiceSnapshot {
    if (receipt.session_id !== sessionId || receipt.content_hash !== contentHash) {
      throw this.createLoopInputConflict(sessionId, requestId);
    }

    const current = this.requireRow(sessionId);
    this.assertExpectedAutomation(current, automationId);
    if (receipt.state === 'acknowledged') {
      return toClaudeAutomationSnapshot(current);
    }

    const error = receipt.error
      ?? 'The server restarted or lost contact while delivering this Loop input.';
    if (receipt.state === 'processing') {
      this.db.updateInput(automationId, requestId, 'uncertain', error);
    }
    throw new ClaudeAutomationServiceError(
      `${error} Check the transcript before sending the message again.`,
      'AUTOMATION_INPUT_UNCERTAIN',
    );
  }

  private isCurrentAutomation(sessionId: string, automationId: string): boolean {
    const current = this.db.getBySessionId(sessionId);
    return Boolean(current && this.getAutomationId(current) === automationId);
  }

  private assertExpectedAutomation(
    row: ClaudeAutomationRow,
    expectedAutomationId?: string,
  ): string {
    const automationId = this.getAutomationId(row);
    if (expectedAutomationId && expectedAutomationId !== automationId) {
      throw new ClaudeAutomationServiceError(
        `Automation ${expectedAutomationId} is stale; current automation is ${automationId}.`,
        'AUTOMATION_STALE_ACTION',
      );
    }
    return automationId;
  }

  private requireRow(sessionId: string): ClaudeAutomationRow {
    const row = this.db.getBySessionId(sessionId);
    if (!row) {
      throw new ClaudeAutomationServiceError(
        `Automation for session ${sessionId} was not found.`,
        'AUTOMATION_NOT_FOUND',
      );
    }
    return row;
  }

  private assertCanStart(sessionId: string): void {
    if (this.shuttingDown) {
      throw new ClaudeAutomationServiceError(
        'Claude automation service is shutting down.',
        'AUTOMATION_START_FAILED',
      );
    }
    if (this.getActiveRow(sessionId) || this.activeGoals.has(sessionId)
      || this.loopStarts.has(sessionId) || this.loopInputQueues.has(sessionId)
      || this.stops.has(sessionId)) {
      throw new ClaudeAutomationServiceError(
        `An automation is already active for session ${sessionId}.`,
        'AUTOMATION_ALREADY_ACTIVE',
      );
    }
  }

  private toNativeOptions(
    input: ClaudeAutomationStartInput,
    automationId: string,
  ): NativeClaudeAutomationStartOptions {
    const target = input.providerSessionId?.trim()
      ? { providerSessionId: input.providerSessionId.trim() }
      : { sessionId: input.sessionId };
    return {
      automationId,
      command: input.command,
      cwd: input.cwd,
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      env: input.env,
      ...target,
    } as NativeClaudeAutomationStartOptions;
  }

  private toNativeClearOptions(input: ClaudeAutomationStartInput) {
    // Clearing is a second process, so even a fresh Goal must resume the
    // session that its first process created with --session-id.
    const providerSessionId = input.providerSessionId?.trim() || input.sessionId;
    return {
      providerSessionId,
      cwd: input.cwd,
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      env: input.env,
    };
  }
}
