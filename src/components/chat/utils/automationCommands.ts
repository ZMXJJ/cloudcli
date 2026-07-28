export type ComposerAutomationCommand = {
  kind: 'goal' | 'loop';
  action: 'start' | 'status' | 'stop';
};

const GOAL_STOP_ARGUMENTS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

/** Mirrors the server parser for the composer behaviors that affect local busy state. */
export function readAutomationCommand(input: string): ComposerAutomationCommand | null {
  const match = input.trim().match(/^\/(goal|loop)(?=$|\s)([\s\S]*)$/);
  if (!match) {
    return null;
  }

  const kind = match[1] as 'goal' | 'loop';
  const prompt = match[2].trim();
  if (kind === 'loop') {
    return prompt ? { kind, action: 'start' } : null;
  }
  if (!prompt) {
    return { kind, action: 'status' };
  }
  return { kind, action: GOAL_STOP_ARGUMENTS.has(prompt) ? 'stop' : 'start' };
}
