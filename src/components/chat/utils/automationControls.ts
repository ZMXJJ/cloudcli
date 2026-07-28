export type AutomationControlAction = 'stop' | 'dismiss';

export function sendAutomationControl(
  sendMessage: (message: unknown) => boolean,
  action: AutomationControlAction,
  sessionId: string,
  automationId: string,
): boolean {
  return sendMessage({
    type: `automation.${action}`,
    sessionId,
    automationId,
  });
}
