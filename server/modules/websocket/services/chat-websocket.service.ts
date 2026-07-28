import path from 'node:path';

import type { WebSocket } from 'ws';

import {
  MAX_AUTOMATION_CORRELATION_ID_LENGTH,
  parseClaudeAutomationCommand,
  type ClaudeAutomationService,
} from '@/modules/automations/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { getGlobalImageAssetsDir, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  ClaudeAutomationSnapshot,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterImagesToUploadStore(images: unknown, assetsRootOverride?: string): AnyRecord[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeImageDescriptors(images).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping image outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/**
 * One provider runtime entry point. All five runtimes share this signature,
 * which lets the chat handler dispatch through a provider-keyed map instead
 * of provider-specific branches.
 */
type ProviderSpawnFn = (
  command: string,
  options: AnyRecord,
  writer: unknown
) => Promise<unknown>;

export type ChatWebSocketDependencies = {
  /** Provider runtimes keyed by provider id. */
  spawnFns: Record<LLMProvider, ProviderSpawnFn>;
  /**
   * Abort functions keyed by provider id. They are addressed with the
   * provider-native session id (that is how runtimes key their process maps).
   * The Claude abort is async; the rest are sync — both shapes are accepted.
   */
  abortFns: Record<LLMProvider, (providerSessionId: string) => boolean | Promise<boolean>>;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
  /** Claude-only today: pending tool approvals included in `chat_subscribed`. */
  getPendingApprovalsForSession: (providerSessionId: string) => unknown[];
  /** Persistent native Claude Code Goal/Loop orchestration. */
  automations: ClaudeAutomationService;
  /** Provider adapter normalization without coupling the gateway to a provider module. */
  normalizeMessage: (
    provider: LLMProvider,
    raw: unknown,
    sessionId: string | null,
  ) => NormalizedMessage[];
};

const ACTIVE_AUTOMATION_STATES = new Set(['starting', 'running', 'stopping']);
const UNATTENDED_LOOP_PERMISSION_MODES = new Set([
  'auto',
  'bypassPermissions',
  'dontAsk',
]);
const chatSubscriptions = new Map<WebSocket, Set<string>>();

function trackChatSubscription(ws: WebSocket, sessionId: string): void {
  const subscriptions = chatSubscriptions.get(ws) ?? new Set<string>();
  subscriptions.add(sessionId);
  chatSubscriptions.set(ws, subscriptions);
}

function attachSubscribedConnections(sessionId: string): void {
  for (const [client, subscriptions] of chatSubscriptions) {
    if (subscriptions.has(sessionId) && client.readyState === WS_OPEN_STATE) {
      chatRunRegistry.attachConnection(sessionId, client);
    }
  }
}

/** Sends automation state only to clients that subscribed to that chat. */
export function broadcastAutomationState(
  sessionId: string,
  automation: ClaudeAutomationSnapshot | null,
): void {
  const payload = JSON.stringify({
    kind: 'automation_state',
    sessionId,
    automation,
    timestamp: new Date().toISOString(),
  });

  for (const [client, subscriptions] of chatSubscriptions) {
    if (subscriptions.has(sessionId) && client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  }
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

function sendAutomationState(
  ws: WebSocket,
  sessionId: string,
  automation: ClaudeAutomationSnapshot | null,
  requestId?: string | null,
): void {
  sendJson(ws, {
    kind: 'automation_state',
    sessionId,
    automation,
    ...(requestId ? { requestId } : {}),
    timestamp: new Date().toISOString(),
  });
}

function readErrorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return fallback;
}

function readAutomationPreferences(options: AnyRecord): {
  model?: string;
  effort?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
} {
  const toolsSettings = options.toolsSettings as AnyRecord | undefined;
  const requestedPermissionMode = typeof options.permissionMode === 'string'
    ? options.permissionMode
    : undefined;
  const permissionMode = toolsSettings?.skipPermissions === true && requestedPermissionMode !== 'plan'
    ? 'bypassPermissions'
    : requestedPermissionMode;

  return {
    model: typeof options.model === 'string' ? options.model : undefined,
    effort: typeof options.effort === 'string' ? options.effort : undefined,
    permissionMode,
    allowedTools: readStringArray(toolsSettings?.allowedTools),
    disallowedTools: readStringArray(toolsSettings?.disallowedTools),
  };
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value.filter((entry): entry is string =>
    typeof entry === 'string' && entry.trim().length > 0
  );
  return entries.length > 0 ? entries : [];
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string,
  preserveProcessing = false,
  requestId?: string | null,
  automationId?: string | null,
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    preserveProcessing,
    requestId: requestId ?? null,
    automationId: automationId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

function readRequestId(data: AnyRecord): string | null {
  const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
  return requestId.length > 0 && requestId.length <= MAX_AUTOMATION_CORRELATION_ID_LENGTH
    ? requestId
    : null;
}

function readAutomationId(data: AnyRecord): string | null {
  const automationId = typeof data.automationId === 'string' ? data.automationId.trim() : '';
  return automationId.length > 0 && automationId.length <= MAX_AUTOMATION_CORRELATION_ID_LENGTH
    ? automationId
    : null;
}

function hasInvalidCorrelationId(data: AnyRecord, field: 'requestId' | 'automationId'): boolean {
  if (!Object.prototype.hasOwnProperty.call(data, field)) return false;
  const value = data[field];
  return typeof value !== 'string'
    || value.trim().length === 0
    || value.trim().length > MAX_AUTOMATION_CORRELATION_ID_LENGTH;
}

async function startGoalAutomation(
  ws: WebSocket,
  userId: string | number | null,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  command: string,
  clientOptions: AnyRecord,
  requestId: string | null,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = session.session_id;
  const images = filterImagesToUploadStore(clientOptions.images);
  if (images.length > 0) {
    sendProtocolError(
      ws,
      'AUTOMATION_ATTACHMENTS_UNSUPPORTED',
      'Goal commands do not support image attachments.',
      sessionId,
      false,
      requestId,
    );
    return;
  }
  const cwd = session.project_path?.trim();
  if (!cwd) {
    sendProtocolError(
      ws,
      'PROJECT_PATH_REQUIRED',
      'Goal requires a project working directory.',
      sessionId,
      false,
      requestId,
    );
    return;
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'claude',
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });
  if (!run) {
    sendProtocolError(
      ws,
      'RUN_IN_PROGRESS',
      `Session "${sessionId}" already has a run in progress.`,
      sessionId,
      true,
      requestId,
    );
    return;
  }
  attachSubscribedConnections(sessionId);

  const wasFreshSession = !session.provider_session_id;
  let freshSessionCaptured = false;
  const nativeSessionId = session.provider_session_id ?? sessionId;

  try {
    const handle = dependencies.automations.startGoal({
      sessionId,
      providerSessionId: session.provider_session_id,
      cwd,
      command,
      ...readAutomationPreferences(clientOptions),
    }, {
      onEvent: (value) => {
        if (wasFreshSession && !freshSessionCaptured && value && typeof value === 'object') {
          const announcedId = (value as AnyRecord).session_id;
          if (announcedId === sessionId) {
            freshSessionCaptured = true;
            run.writer.setSessionId(sessionId);
          }
        }
        for (const message of dependencies.normalizeMessage('claude', value, nativeSessionId)) {
          run.writer.send(message);
        }
      },
      onMalformed: (raw, error) => {
        console.warn('[Automation] Ignoring malformed Goal output', {
          sessionId,
          raw,
          error: error.message,
        });
      },
      onStderr: (chunk) => {
        console.warn('[Automation] Goal stderr', { sessionId, stderr: chunk.trim() });
      },
    });

    const result = await handle.completion;
    const automation = dependencies.automations.getSnapshot(sessionId);
    if (automation?.state === 'failed' && automation.error) {
      run.writer.send(createNormalizedMessage({
        kind: 'error',
        content: automation.error,
        sessionId: nativeSessionId,
        provider: 'claude',
      }));
    }
    chatRunRegistry.completeRunIfCurrent(run, {
      exitCode: automation?.state === 'completed' ? 0 : 1,
      aborted: result.interrupted || automation?.state === 'stopped',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Automation] Unable to run Goal', { sessionId, error: message });
    sendProtocolError(
      ws,
      readErrorCode(error, 'AUTOMATION_START_FAILED'),
      message,
      sessionId,
      false,
      requestId,
    );
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }
}

async function startLoopAutomation(
  ws: WebSocket,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  command: string,
  clientOptions: AnyRecord,
  requestId: string | null,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = session.session_id;
  const cwd = session.project_path?.trim();
  if (!cwd) {
    sendProtocolError(
      ws,
      'PROJECT_PATH_REQUIRED',
      'Loop requires a project working directory.',
      sessionId,
      false,
      requestId,
    );
    return;
  }
  if (chatRunRegistry.isProcessing(sessionId)) {
    sendProtocolError(
      ws,
      'RUN_IN_PROGRESS',
      `Session "${sessionId}" already has a run in progress.`,
      sessionId,
      true,
      requestId,
    );
    return;
  }

  const images = filterImagesToUploadStore(clientOptions.images);
  if (images.length > 0) {
    sendProtocolError(
      ws,
      'AUTOMATION_ATTACHMENTS_UNSUPPORTED',
      'Loop commands do not support image attachments.',
      sessionId,
      false,
      requestId,
    );
    return;
  }

  const preferences = readAutomationPreferences(clientOptions);
  if (!preferences.permissionMode || !UNATTENDED_LOOP_PERMISSION_MODES.has(preferences.permissionMode)) {
    sendProtocolError(
      ws,
      'LOOP_PERMISSION_MODE_REQUIRED',
      'Loop runs in a detached terminal and requires Auto, Bypass Permissions, or Don\'t Ask mode so hidden approval prompts cannot block it.',
      sessionId,
      false,
      requestId,
    );
    return;
  }

  try {
    await dependencies.automations.startLoop({
      sessionId,
      providerSessionId: session.provider_session_id,
      cwd,
      command,
      ...preferences,
    });
    if (!session.provider_session_id) {
      sessionsDb.assignProviderSessionId(sessionId, sessionId);
    }
    sendAutomationState(
      ws,
      sessionId,
      dependencies.automations.getSnapshot(sessionId),
      requestId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Automation] Unable to run Loop', { sessionId, error: message });
    sendProtocolError(
      ws,
      readErrorCode(error, 'AUTOMATION_START_FAILED'),
      message,
      sessionId,
      false,
      requestId,
    );
  }
}

async function handleAutomationCommand(
  ws: WebSocket,
  userId: string | number | null,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  command: string,
  clientOptions: AnyRecord,
  requestId: string | null,
  requestedAutomationId: string | null,
  dependencies: ChatWebSocketDependencies,
): Promise<boolean> {
  if (session.provider !== 'claude') {
    return false;
  }

  const sessionId = session.session_id;
  const parsed = parseClaudeAutomationCommand(command);
  const automation = dependencies.automations.getSnapshot(sessionId);
  const isActive = Boolean(automation && ACTIVE_AUTOMATION_STATES.has(automation.state));

  if (parsed?.kind === 'goal' && parsed.action === 'status') {
    if (!automation) {
      sendProtocolError(
        ws,
        'NO_AUTOMATION',
        `Session "${sessionId}" has no Goal or Loop status.`,
        sessionId,
        false,
        requestId,
      );
    } else {
      sendAutomationState(ws, sessionId, automation, requestId);
    }
    return true;
  }

  if (parsed?.kind === 'goal' && parsed.action === 'stop') {
    if (!isActive || automation?.kind !== 'goal') {
      sendProtocolError(
        ws,
        'NO_ACTIVE_GOAL',
        `Session "${sessionId}" has no active Goal.`,
        sessionId,
        false,
        requestId,
        requestedAutomationId,
      );
      return true;
    }
    if (!requestedAutomationId) {
      sendProtocolError(
        ws,
        'AUTOMATION_ID_REQUIRED',
        `${parsed.command} requires the current automationId. Refresh the Goal status first.`,
        sessionId,
        true,
        requestId,
      );
      return true;
    }
    try {
      const stopped = await dependencies.automations.stop(sessionId, requestedAutomationId);
      sendAutomationState(ws, sessionId, stopped, requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendProtocolError(
        ws,
        readErrorCode(error, 'AUTOMATION_STOP_FAILED'),
        message,
        sessionId,
        true,
        requestId,
        requestedAutomationId,
      );
    }
    return true;
  }

  if (parsed) {
    if (isActive) {
      sendProtocolError(
        ws,
        'AUTOMATION_IN_PROGRESS',
        `Session "${sessionId}" already has an active ${automation?.kind ?? 'automation'}.`,
        sessionId,
        true,
        requestId,
        requestedAutomationId,
      );
      return true;
    }

    if (parsed.kind === 'goal') {
      await startGoalAutomation(ws, userId, session, parsed.command, clientOptions, requestId, dependencies);
    } else {
      await startLoopAutomation(ws, session, parsed.command, clientOptions, requestId, dependencies);
    }
    return true;
  }

  // A client can race a Loop's terminal transition after composing against a
  // running snapshot. The automationId is an explicit routing claim: consume
  // it here and let sendLoopInput validate generation/state instead of
  // silently falling through to a normal Claude turn.
  if (!isActive && !requestedAutomationId) {
    return false;
  }

  if (isActive && automation?.kind !== 'loop') {
    sendProtocolError(
      ws,
      'AUTOMATION_IN_PROGRESS',
      `Session "${sessionId}" is currently controlled by an active ${automation?.kind ?? 'automation'}.`,
      sessionId,
      true,
      requestId,
      requestedAutomationId,
    );
    return true;
  }

  const images = filterImagesToUploadStore(clientOptions.images);
  if (images.length > 0) {
    sendProtocolError(
      ws,
      'AUTOMATION_ATTACHMENTS_UNSUPPORTED',
      'Messages sent to a running Loop do not support image attachments.',
      sessionId,
      false,
      requestId,
      requestedAutomationId,
    );
    return true;
  }

  if (!requestId) {
    sendProtocolError(
      ws,
      'REQUEST_ID_REQUIRED',
      'Messages sent to a running Loop require a requestId.',
      sessionId,
      false,
      null,
      requestedAutomationId,
    );
    return true;
  }

  if (!requestedAutomationId) {
    sendProtocolError(
      ws,
      'AUTOMATION_ID_REQUIRED',
      'Messages sent to a running Loop require an automationId.',
      sessionId,
      false,
      requestId,
    );
    return true;
  }

  try {
    const updated = await dependencies.automations.sendLoopInput(
      sessionId,
      command,
      requestedAutomationId,
      requestId,
    );
    sendJson(ws, {
      kind: 'automation_input_ack',
      sessionId,
      automationId: updated.automationId,
      requestId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(
      ws,
      readErrorCode(error, 'AUTOMATION_INPUT_FAILED'),
      message,
      sessionId,
      false,
      requestId,
      requestedAutomationId,
    );
  }
  return true;
}

/**
 * Handles `chat.send`: resolves the session row from the database, routes
 * native Claude automations when applicable, otherwise dispatches through the
 * existing provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (hasInvalidCorrelationId(data, 'requestId')) {
    sendProtocolError(
      ws,
      'INVALID_REQUEST_ID',
      `chat.send requestId must be a non-empty string of at most ${MAX_AUTOMATION_CORRELATION_ID_LENGTH} characters.`,
      sessionId ?? undefined,
    );
    return;
  }
  const requestId = readRequestId(data);
  if (hasInvalidCorrelationId(data, 'automationId')) {
    sendProtocolError(
      ws,
      'INVALID_AUTOMATION_ID',
      `chat.send automationId must be a non-empty string of at most ${MAX_AUTOMATION_CORRELATION_ID_LENGTH} characters.`,
      sessionId ?? undefined,
      false,
      requestId,
    );
    return;
  }
  const requestedAutomationId = readAutomationId(data);
  if (!sessionId) {
    sendProtocolError(
      ws,
      'SESSION_ID_REQUIRED',
      'chat.send requires a sessionId.',
      undefined,
      false,
      requestId,
      requestedAutomationId,
    );
    return;
  }
  if (typeof data.content !== 'string') {
    sendProtocolError(
      ws,
      'INVALID_CONTENT',
      'chat.send requires content to be a string.',
      sessionId,
      false,
      requestId,
      requestedAutomationId,
    );
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId,
      false,
      requestId,
      requestedAutomationId,
    );
    return;
  }

  // A newly-created session can send its first message before the explicit
  // subscribe effect runs. Register it now so automation state is not lost.
  trackChatSubscription(ws, sessionId);

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = data.content;
  if (await handleAutomationCommand(
    ws,
    userId,
    session,
    command,
    clientOptions,
    requestId,
    requestedAutomationId,
    dependencies,
  )) {
    return;
  }

  const provider = session.provider as LLMProvider;
  const spawnFn = dependencies.spawnFns[provider];
  if (!spawnFn) {
    sendProtocolError(
      ws,
      'UNSUPPORTED_PROVIDER',
      `Provider "${provider}" is not available.`,
      sessionId,
      false,
      requestId,
    );
    return;
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });
  if (!run) {
    sendProtocolError(
      ws,
      'RUN_IN_PROGRESS',
      `Session "${sessionId}" already has a run in progress.`,
      sessionId,
      true,
      requestId,
    );
    return;
  }
  attachSubscribedConnections(sessionId);

  // The provider runtimes receive the provider-native session id. Brand-new
  // regular chats still let the runtime create and announce one dynamically.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    images: filterImagesToUploadStore(clientOptions.images),
    sessionId: session.provider_session_id ?? undefined,
    resume: Boolean(session.provider_session_id),
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
  };

  try {
    await spawnFn(command, runtimeOptions, run.writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: message });
  } finally {
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (hasInvalidCorrelationId(data, 'automationId')) {
    sendProtocolError(
      ws,
      'INVALID_AUTOMATION_ID',
      `chat.abort automationId must be a non-empty string of at most ${MAX_AUTOMATION_CORRELATION_ID_LENGTH} characters.`,
      sessionId ?? undefined,
      true,
    );
    return;
  }
  const requestedAutomationId = readAutomationId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const automation = dependencies.automations.getSnapshot(sessionId);
  if (automation && ACTIVE_AUTOMATION_STATES.has(automation.state)) {
    if (!requestedAutomationId) {
      sendProtocolError(
        ws,
        'AUTOMATION_ID_REQUIRED',
        'chat.abort requires an automationId while an automation is active.',
        sessionId,
        true,
      );
      return;
    }
    try {
      await dependencies.automations.stop(sessionId, requestedAutomationId);
      if (chatRunRegistry.isProcessing(sessionId)) {
        chatRunRegistry.completeRun(sessionId, { exitCode: 0, aborted: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendProtocolError(
        ws,
        readErrorCode(error, 'AUTOMATION_STOP_FAILED'),
        message,
        sessionId,
        true,
        null,
        requestedAutomationId,
      );
    }
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const abortFn = dependencies.abortFns[run.provider];
  if (!abortFn) {
    sendProtocolError(
      ws,
      'ABORT_UNAVAILABLE',
      `Provider "${run.provider}" does not support aborting this run.`,
      sessionId,
      true,
    );
    return;
  }
  if (!run.providerSessionId) {
    sendProtocolError(
      ws,
      'ABORT_NOT_READY',
      'The provider has not announced its session id yet. The run is still active; retry Stop shortly.',
      sessionId,
      true,
    );
    return;
  }

  try {
    const success = Boolean(await abortFn(run.providerSessionId));
    if (!success) {
      sendProtocolError(
        ws,
        'ABORT_REJECTED',
        `Provider "${run.provider}" did not accept the abort request. The run is still active.`,
        sessionId,
        true,
      );
      return;
    }
    chatRunRegistry.completeRun(sessionId, { exitCode: 0, aborted: true });
  } catch (error) {
    sendProtocolError(
      ws,
      'ABORT_FAILED',
      error instanceof Error ? error.message : String(error),
      sessionId,
      true,
    );
  }
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }
    trackChatSubscription(ws, sessionId);

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;
    const requestedRunId = typeof (target as AnyRecord).runId === 'string'
      ? ((target as AnyRecord).runId as string).trim()
      : '';

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the provider-native id inside the
    // Claude runtime; remap their sessionId so the client only sees app ids.
    const pendingPermissions = (run?.providerSessionId
      ? dependencies.getPendingApprovalsForSession(run.providerSessionId)
      : []
    ).map((approval) =>
      approval && typeof approval === 'object'
        ? { ...(approval as AnyRecord), sessionId }
        : approval,
    );

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      runId: run?.runId ?? null,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      automation: dependencies.automations.getSnapshot(sessionId),
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      const replayAfterSeq = requestedRunId && requestedRunId !== run?.runId ? 0 : lastSeq;
      for (const event of chatRunRegistry.replayEvents(sessionId, replayAfterSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

async function handleAutomationStop(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (hasInvalidCorrelationId(data, 'requestId')) {
    sendProtocolError(
      ws,
      'INVALID_REQUEST_ID',
      `automation.stop requestId must be a non-empty string of at most ${MAX_AUTOMATION_CORRELATION_ID_LENGTH} characters.`,
      sessionId ?? undefined,
      true,
    );
    return;
  }
  const requestId = readRequestId(data);
  if (hasInvalidCorrelationId(data, 'automationId')) {
    sendProtocolError(
      ws,
      'INVALID_AUTOMATION_ID',
      `automation.stop automationId must be a non-empty string of at most ${MAX_AUTOMATION_CORRELATION_ID_LENGTH} characters.`,
      sessionId ?? undefined,
      true,
      requestId,
    );
    return;
  }
  const automationId = readAutomationId(data);
  if (!sessionId) {
    sendProtocolError(
      ws,
      'SESSION_ID_REQUIRED',
      'automation.stop requires a sessionId.',
      undefined,
      true,
      requestId,
      automationId,
    );
    return;
  }
  if (!automationId) {
    sendProtocolError(
      ws,
      'AUTOMATION_ID_REQUIRED',
      'automation.stop requires an automationId.',
      sessionId,
      true,
      requestId,
    );
    return;
  }

  try {
    await dependencies.automations.stop(sessionId, automationId);
    if (chatRunRegistry.isProcessing(sessionId)) {
      chatRunRegistry.completeRun(sessionId, { exitCode: 0, aborted: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(
      ws,
      readErrorCode(error, 'AUTOMATION_STOP_FAILED'),
      message,
      sessionId,
      true,
      requestId,
      automationId,
    );
  }
}

async function handleAutomationDismiss(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (hasInvalidCorrelationId(data, 'requestId')) {
    sendProtocolError(
      ws,
      'INVALID_REQUEST_ID',
      `automation.dismiss requestId must be a non-empty string of at most ${MAX_AUTOMATION_CORRELATION_ID_LENGTH} characters.`,
      sessionId ?? undefined,
      true,
    );
    return;
  }
  const requestId = readRequestId(data);
  if (hasInvalidCorrelationId(data, 'automationId')) {
    sendProtocolError(
      ws,
      'INVALID_AUTOMATION_ID',
      `automation.dismiss automationId must be a non-empty string of at most ${MAX_AUTOMATION_CORRELATION_ID_LENGTH} characters.`,
      sessionId ?? undefined,
      true,
      requestId,
    );
    return;
  }
  const automationId = readAutomationId(data);
  if (!sessionId) {
    sendProtocolError(
      ws,
      'SESSION_ID_REQUIRED',
      'automation.dismiss requires a sessionId.',
      undefined,
      true,
      requestId,
      automationId,
    );
    return;
  }
  if (!automationId) {
    sendProtocolError(
      ws,
      'AUTOMATION_ID_REQUIRED',
      'automation.dismiss requires an automationId.',
      sessionId,
      true,
      requestId,
    );
    return;
  }

  try {
    await dependencies.automations.dismiss(sessionId, automationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(
      ws,
      readErrorCode(error, 'AUTOMATION_DISMISS_FAILED'),
      message,
      sessionId,
      true,
      requestId,
      automationId,
    );
  }
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, requestId?, automationId?, content, options? }
 * - `chat.abort`               { sessionId, automationId? }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 * - `automation.stop`          { sessionId, automationId }
 * - `automation.dismiss`       { sessionId, automationId }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `automation_state`, `automation_input_ack`,
 * `session_upserted`, `loading_progress`, `protocol_error`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        case 'automation.stop':
          await handleAutomationStop(ws, data, dependencies);
          return;
        case 'automation.dismiss':
          await handleAutomationDismiss(ws, data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
    chatSubscriptions.delete(ws);
  });
}
