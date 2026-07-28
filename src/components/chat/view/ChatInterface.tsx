import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import PermissionContext from '../../../contexts/PermissionContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { ChatAutomation, ChatInterfaceProps, Provider  } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers, type ChatStreamState } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionStore } from '../../../stores/useSessionStore';
import { guardProcessingForAutomationGeneration } from '../utils/pendingChatRequests';
import { sendAutomationControl } from '../utils/automationControls';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import CommandResultModal from './subcomponents/CommandResultModal';

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  const streamStateRef = useRef(new Map<string, ChatStreamState>());
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());
  const runIdRef = useRef(new Map<string, string>());
  const [automationsBySession, setAutomationsBySession] = useState<Map<string, ChatAutomation>>(
    () => new Map(),
  );
  const automationsBySessionRef = useRef(automationsBySession);
  const [automationControlErrors, setAutomationControlErrors] = useState<Map<string, string>>(
    () => new Map(),
  );

  const handleAutomationState = useCallback((sessionId: string, automation: ChatAutomation | null) => {
    const next = new Map(automationsBySessionRef.current);
    if (automation) {
      next.set(sessionId, automation);
    } else {
      next.delete(sessionId);
    }
    automationsBySessionRef.current = next;
    setAutomationsBySession(next);
    setAutomationControlErrors((previous) => {
      if (!previous.has(sessionId)) return previous;
      const nextErrors = new Map(previous);
      nextErrors.delete(sessionId);
      return nextErrors;
    });
  }, []);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    opencodeModel,
    setOpenCodeModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels,
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    addMessageToSession,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    statusCheckSentAtRef,
    lastSeqRef,
    runIdRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const viewedSessionId = selectedSession?.id || currentSessionId || null;
  const automation = viewedSessionId ? automationsBySession.get(viewedSessionId) || null : null;
  const automationControlError = viewedSessionId
    ? automationControlErrors.get(viewedSessionId) || null
    : null;

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleAutomationInputAck: consumeAutomationInputAckResponse,
    handleChatRequestRejected: consumeChatRequestRejectionResponse,
    handleChatRunComplete,
    handleAutomationCommandObserved,
    hasPendingAutomationInput,
    retryPendingAutomationInputs,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    cursorModel,
    claudeModel,
    codexModel,
    currentProviderEffort,
    opencodeModel,
    automation,
    isLoading: isProcessing,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    addMessageToSession,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  const handleAutomationInputAck = useCallback((
    sessionId: string,
    requestId: string,
    automationId: string,
  ) => guardProcessingForAutomationGeneration(
    consumeAutomationInputAckResponse(sessionId, requestId, automationId),
    automationsBySessionRef.current.get(sessionId)?.automationId,
  ), [consumeAutomationInputAckResponse]);

  const handleChatRequestRejected = useCallback((
    sessionId: string,
    requestId: string,
    automationId?: string | null,
  ) => guardProcessingForAutomationGeneration(
    consumeChatRequestRejectionResponse(sessionId, requestId, automationId),
    automationsBySessionRef.current.get(sessionId)?.automationId,
  ), [consumeChatRequestRejectionResponse]);

  // On WebSocket reconnect, re-fetch the current session's messages from the
  // server so missed streaming events are shown, then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    try {
      await sessionStore.refreshFromServer(selectedSession.id);
    } catch (error) {
      console.error('[Chat] Failed to refresh history after reconnect:', error);
    }
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        runId: runIdRef.current.get(selectedSession.id),
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [selectedProject, selectedSession, sendMessage, sessionStore]);

  // Re-send unresolved Loop inputs with their original request ids. The server
  // either replays a persisted ACK or joins the existing input operation, so a
  // reconnect or page reload cannot inject the same turn twice.
  useEffect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const sessionId of retryPendingAutomationInputs()) {
      onSessionProcessing?.(sessionId, { statusText: null, canInterrupt: true });
    }
  }, [onSessionProcessing, retryPendingAutomationInputs, ws]);

  useChatRealtimeHandlers({
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
    onAutomationState: handleAutomationState,
    onAutomationInputAck: handleAutomationInputAck,
    onChatRequestRejected: handleChatRequestRejected,
    onChatRunComplete: handleChatRunComplete,
    onAutomationCommandObserved: handleAutomationCommandObserved,
    hasPendingAutomationInput,
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
  });

  const handleStopAutomation = useCallback(() => {
    if (!viewedSessionId || !automation) return;
    const sent = sendAutomationControl(
      sendMessage,
      'stop',
      viewedSessionId,
      automation.automationId,
    );
    setAutomationControlErrors((previous) => {
      const next = new Map(previous);
      if (sent) {
        next.delete(viewedSessionId);
      } else {
        next.set(viewedSessionId, t('automation.errors.stopNotSent', {
          defaultValue: 'Stop was not sent because the chat connection is offline. Reconnect and retry.',
        }));
      }
      return next;
    });
  }, [automation, sendMessage, t, viewedSessionId]);
  const handleDismissAutomation = useCallback(() => {
    if (!viewedSessionId || !automation) return;
    const sent = sendAutomationControl(
      sendMessage,
      'dismiss',
      viewedSessionId,
      automation.automationId,
    );
    setAutomationControlErrors((previous) => {
      const next = new Map(previous);
      if (sent) {
        next.delete(viewedSessionId);
      } else {
        next.set(viewedSessionId, t('automation.errors.dismissNotSent', {
          defaultValue: 'Dismiss was not sent because the chat connection is offline. Reconnect and retry.',
        }));
      }
      return next;
    });
  }, [automation, sendMessage, t, viewedSessionId]);

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    const streams = streamStateRef.current;
    return () => {
      for (const stream of streams.values()) {
        if (stream.timer !== null) clearTimeout(stream.timer);
      }
      streams.clear();
    };
  }, []);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  if (!selectedProject) {
    const selectedProviderLabel =
      provider === 'cursor'
        ? t('messageTypes.cursor')
        : provider === 'codex'
          ? t('messageTypes.codex')
          : provider === 'opencode'
              ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
            : t('messageTypes.claude');

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
            automation={automation}
            automationControlError={automationControlError}
            onStopAutomation={handleStopAutomation}
            onDismissAutomation={handleDismissAutomation}
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
            activity={sessionActivity}
            isLoading={isProcessing}
            onAbortSession={handleAbortSession}
            permissionMode={permissionMode}
            onModeSwitch={cyclePermissionMode}
            effort={currentProviderEffort}
            availableEffortOptions={currentProviderEffortOptions}
            onSelectEffort={(nextEffort) => setStoredProviderEffort(provider, nextEffort)}
            tokenBudget={tokenBudget}
            onShowTokenUsage={showCostModal}
            slashCommandsCount={slashCommandsCount}
            onToggleCommandMenu={handleToggleCommandMenu}
            hasInput={Boolean(input.trim())}
            onClearInput={handleClearInput}
            onSubmit={handleSubmit}
            isDragActive={isDragActive}
            queuedDraft={queuedDraft}
            onEditQueuedDraft={editQueuedDraft}
            onDeleteQueuedDraft={deleteQueuedDraft}
            attachedImages={attachedImages}
            onRemoveImage={(index) =>
              setAttachedImages((previous) =>
                previous.filter((_, currentIndex) => currentIndex !== index),
              )
            }
            uploadingImages={uploadingImages}
            imageErrors={imageErrors}
            showFileDropdown={showFileDropdown}
            filteredFiles={filteredFiles}
            selectedFileIndex={selectedFileIndex}
            onSelectFile={selectFile}
            filteredCommands={filteredCommands}
            selectedCommandIndex={selectedCommandIndex}
            onCommandSelect={handleCommandSelect}
            onCloseCommandMenu={resetCommandMenuState}
            isCommandMenuOpen={showCommandMenu}
            frequentCommands={commandQuery ? [] : frequentCommands}
            getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
            getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
            openImagePicker={openImagePicker}
            inputHighlightRef={inputHighlightRef}
            renderInputWithMentions={renderInputWithMentions}
            textareaRef={textareaRef}
            input={input}
            onVoiceTranscript={handleVoiceTranscript}
            onInputChange={handleInputChange}
            onTextareaClick={handleTextareaClick}
            onTextareaKeyDown={handleKeyDown}
            onTextareaPaste={handlePaste}
            onTextareaScrollSync={syncInputOverlayScroll}
            onTextareaInput={handleTextareaInput}
            isInputFocused={isInputFocused}
            onInputFocusChange={handleInputFocusChange}
            placeholder={t('input.placeholder', {
              provider:
                provider === 'cursor'
                  ? t('messageTypes.cursor')
                  : provider === 'codex'
                    ? t('messageTypes.codex')
                    : provider === 'opencode'
                        ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
                      : t('messageTypes.claude'),
            })}
            isTextareaExpanded={isTextareaExpanded}
            sendByCtrlEnter={sendByCtrlEnter}
          />
        </div>
      </div>

      <QuickSettingsPanel />

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
