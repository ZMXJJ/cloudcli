import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '../../../utils/notificationSound';
import type { MarkSessionIdle, MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import type { ChatAutomation, PendingPermissionRequest } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import type { PendingChatRequestResult } from '../utils/pendingChatRequests';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

interface UseChatRealtimeHandlersArgs {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  streamStateRef: MutableRefObject<Map<string, ChatStreamState>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** Run generation paired with each session's replay sequence. */
  runIdRef: MutableRefObject<Map<string, string>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onAutomationState?: (sessionId: string, automation: ChatAutomation | null) => void;
  onAutomationInputAck?: (
    sessionId: string,
    requestId: string,
    automationId: string,
  ) => PendingChatRequestResult;
  onChatRequestRejected?: (
    sessionId: string,
    requestId: string,
    automationId?: string | null,
  ) => PendingChatRequestResult;
  onChatRunComplete?: (sessionId: string) => void;
  onAutomationCommandObserved?: (sessionId: string, requestId: string) => void;
  hasPendingAutomationInput?: (sessionId: string) => boolean;
  onWebSocketReconnect?: () => void;
  sessionStore: SessionStore;
}

export type ChatStreamState = {
  runId: string | null;
  provider: LLMProvider;
  text: string;
  timer: number | null;
};

const AUTOMATION_KINDS = new Set(['goal', 'loop']);
const AUTOMATION_STATES = new Set([
  'starting',
  'running',
  'stopping',
  'completed',
  'stopped',
  'failed',
]);
const isChatAutomation = (value: unknown): value is ChatAutomation => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const automation = value as Record<string, unknown>;
  return (
    typeof automation.automationId === 'string'
    && automation.automationId.length > 0
    && typeof automation.kind === 'string'
    && AUTOMATION_KINDS.has(automation.kind)
    && typeof automation.state === 'string'
    && AUTOMATION_STATES.has(automation.state)
    && typeof automation.command === 'string'
    && typeof automation.runtime === 'string'
    && typeof automation.startedAt === 'string'
    && typeof automation.updatedAt === 'string'
    && (automation.completedAt == null || typeof automation.completedAt === 'string')
    && (automation.error == null || typeof automation.error === 'string')
  );
};

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  streamStateRef,
  lastSeqRef,
  runIdRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onAutomationState,
  onAutomationInputAck,
  onChatRequestRejected,
  onChatRunComplete,
  onAutomationCommandObserved,
  hasPendingAutomationInput,
  onWebSocketReconnect,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      const messageRunId = typeof msg.runId === 'string' && msg.runId ? msg.runId : null;
      if (sid && messageRunId) {
        const knownRunId = runIdRef.current.get(sid);
        if (knownRunId !== messageRunId) {
          const staleStream = streamStateRef.current.get(sid);
          if (staleStream?.timer !== null && staleStream?.timer !== undefined) {
            window.clearTimeout(staleStream.timer);
          }
          streamStateRef.current.delete(sid);
          runIdRef.current.set(sid, messageRunId);
          lastSeqRef.current.set(sid, 0);
        }
      }

      // Record replay progress for every sequenced live event in this run.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.runId === null) {
            runIdRef.current.delete(sid);
            lastSeqRef.current.delete(sid);
          }

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else if (!hasPendingAutomationInput?.(sid)) {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }

          if (Object.prototype.hasOwnProperty.call(msg, 'automation')) {
            if (msg.automation === null) {
              onAutomationState?.(sid, null);
            } else if (isChatAutomation(msg.automation)) {
              onAutomationState?.(sid, msg.automation);
            } else {
              console.warn('[Chat] Ignoring invalid automation in chat_subscribed:', msg.automation);
            }
          }
          return;
        }

        case 'automation_state': {
          if (!sid) return;

          if (msg.automation === null) {
            onAutomationState?.(sid, null);
          } else if (isChatAutomation(msg.automation)) {
            onAutomationState?.(sid, msg.automation);
          } else {
            console.warn('[Chat] Ignoring invalid automation_state payload:', msg.automation);
            return;
          }
          if (typeof msg.requestId === 'string') {
            onAutomationCommandObserved?.(sid, msg.requestId);
          }
          return;
        }

        case 'automation_input_ack': {
          if (
            !sid
            || typeof msg.requestId !== 'string'
            || typeof msg.automationId !== 'string'
          ) {
            return;
          }

          const acknowledgement = onAutomationInputAck?.(sid, msg.requestId, msg.automationId);
          if (acknowledgement?.matched && acknowledgement.clearProcessing) {
            onSessionIdle?.(sid);
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            const rejection = typeof msg.requestId === 'string'
              ? onChatRequestRejected?.(
                  sid,
                  msg.requestId,
                  typeof msg.automationId === 'string' ? msg.automationId : null,
                )
              : undefined;

            // Only the request that established the local busy state may
            // clear it. Errors from stale tabs, Stop/Dismiss, or a rejected
            // concurrent send must not tear down an unrelated active run.
            if (
              rejection?.matched
              && rejection.clearProcessing
              && msg.preserveProcessing !== true
            ) {
              onSessionIdle?.(sid);
            }
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events are owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text) return;
        if (!sid) return;
        const eventProvider = typeof msg.provider === 'string'
          ? msg.provider as LLMProvider
          : provider;
        let stream = streamStateRef.current.get(sid);
        if (!stream || stream.runId !== messageRunId) {
          if (stream?.timer !== null && stream?.timer !== undefined) {
            window.clearTimeout(stream.timer);
          }
          stream = { runId: messageRunId, provider: eventProvider, text: '', timer: null };
          streamStateRef.current.set(sid, stream);
        }
        stream.text += text;
        if (stream.timer === null) {
          const scheduledStream = stream;
          stream.timer = window.setTimeout(() => {
            scheduledStream.timer = null;
            if (streamStateRef.current.get(sid) === scheduledStream) {
              sessionStore.updateStreaming(sid, scheduledStream.text, scheduledStream.provider);
            }
          }, 100);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (!sid) return;
        const stream = streamStateRef.current.get(sid);
        if (stream?.timer !== null && stream?.timer !== undefined) {
          clearTimeout(stream.timer);
        }
        if (stream?.text) {
          sessionStore.updateStreaming(sid, stream.text, stream.provider);
        }
        if (stream) {
          sessionStore.finalizeStreaming(sid);
        }
        streamStateRef.current.delete(sid);
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state
          const stream = sid ? streamStateRef.current.get(sid) : undefined;
          if (stream?.timer !== null && stream?.timer !== undefined) {
            clearTimeout(stream.timer);
          }
          if (sid && stream?.text) {
            sessionStore.updateStreaming(sid, stream.text, stream.provider);
            sessionStore.finalizeStreaming(sid);
          }
          if (sid) streamStateRef.current.delete(sid);

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          if (sid) {
            onChatRunComplete?.(sid);
          }
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void sessionStore.refreshFromServer(sid);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            setTokenBudget(msg.tokenBudget as Record<string, unknown>);
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamStateRef,
    lastSeqRef,
    runIdRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onAutomationState,
    onAutomationInputAck,
    onChatRequestRejected,
    onChatRunComplete,
    onAutomationCommandObserved,
    hasPendingAutomationInput,
    onWebSocketReconnect,
    sessionStore,
  ]);
}
