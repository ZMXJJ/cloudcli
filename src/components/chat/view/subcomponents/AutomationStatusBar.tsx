import { CheckCircle2, CircleStop, LoaderCircle, Repeat2, Square, Target, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../../../shared/view/ui';
import type { ChatAutomation, ChatAutomationState } from '../../types/types';

interface AutomationStatusBarProps {
  automation: ChatAutomation;
  controlError?: string | null;
  onStop: () => void;
  onDismiss: () => void;
}

const TERMINAL_STATES = new Set<ChatAutomationState>(['completed', 'stopped', 'failed']);

const STATE_DEFAULT_LABELS: Record<ChatAutomationState, string> = {
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  completed: 'Completed',
  stopped: 'Stopped',
  failed: 'Failed',
};

function AutomationStatusIcon({
  automation,
  hasError,
}: {
  automation: ChatAutomation;
  hasError: boolean;
}) {
  if (automation.state === 'completed') {
    return <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />;
  }
  if (automation.state === 'stopped') {
    return <CircleStop className="h-4 w-4 text-muted-foreground" aria-hidden />;
  }
  if (automation.state === 'failed' || hasError) {
    return <TriangleAlert className="h-4 w-4 text-destructive" aria-hidden />;
  }
  if (automation.state === 'starting' || automation.state === 'stopping') {
    return <LoaderCircle className="h-4 w-4 animate-spin text-primary" aria-hidden />;
  }
  if (automation.kind === 'goal') {
    return <Target className="h-4 w-4 text-sky-600 dark:text-sky-400" aria-hidden />;
  }
  return <Repeat2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />;
}

export default function AutomationStatusBar({
  automation,
  controlError,
  onStop,
  onDismiss,
}: AutomationStatusBarProps) {
  const { t } = useTranslation('chat');
  const isTerminal = TERMINAL_STATES.has(automation.state);
  const isStopping = automation.state === 'stopping';
  const canRetryStop = isStopping && Boolean(automation.error);
  const kindLabel = t(`automation.kind.${automation.kind}`, {
    defaultValue: automation.kind === 'goal' ? 'Goal' : 'Loop',
  });
  const stateLabel = t(`automation.state.${automation.state}`, {
    defaultValue: STATE_DEFAULT_LABELS[automation.state],
  });
  const visibleError = controlError || automation.error;
  const detail = visibleError || automation.command;
  const stopLabel = canRetryStop
    ? t('automation.actions.retryStopLabel', {
        kind: kindLabel,
        defaultValue: `Retry stopping ${kindLabel}`,
      })
    : t('automation.actions.stopLabel', {
        kind: kindLabel,
        defaultValue: `Stop ${kindLabel}`,
      });

  return (
    <div className="mx-auto mb-2 max-w-[54.25rem]">
      <div
        role="status"
        aria-live="polite"
        className={`flex min-h-10 min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm shadow-sm ${
          visibleError
            ? 'border-destructive/35 bg-destructive/5'
            : 'border-border/60 bg-muted/40'
        }`}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          <AutomationStatusIcon automation={automation} hasError={Boolean(visibleError)} />
        </span>

        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="shrink-0 font-medium text-foreground">{kindLabel}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{stateLabel}</span>
          <span
            className={`min-w-0 font-mono text-xs ${
              visibleError
                ? 'basis-full break-words text-destructive sm:basis-auto'
                : 'truncate text-muted-foreground'
            }`}
            title={detail}
          >
            {detail}
          </span>
        </div>

        <span
          className="hidden max-w-32 shrink-0 truncate font-mono text-[11px] text-muted-foreground/70 md:block"
          title={t('automation.runtime', {
            runtime: automation.runtime,
            defaultValue: `Runtime: ${automation.runtime}`,
          })}
        >
          {automation.runtime}
        </span>

        {isTerminal ? (
          <Tooltip
            content={t('automation.actions.dismiss', { defaultValue: 'Dismiss status' })}
            position="top"
          >
            <button
              type="button"
              onClick={onDismiss}
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-7 sm:w-7"
              aria-label={t('automation.actions.dismiss', { defaultValue: 'Dismiss status' })}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
        ) : isStopping && !canRetryStop ? null : (
          <Tooltip
            content={stopLabel}
            position="top"
          >
            <button
              type="button"
              onClick={onStop}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-7"
              aria-label={stopLabel}
            >
              <Square className="h-3 w-3 fill-current" aria-hidden />
              <span>
                {canRetryStop
                  ? t('automation.actions.retryStop', { defaultValue: 'Retry stop' })
                  : t('automation.actions.stop', { defaultValue: 'Stop' })}
              </span>
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
